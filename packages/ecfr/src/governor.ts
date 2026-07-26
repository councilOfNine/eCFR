/**
 * The politeness governor.
 *
 * eCFR's rate limiting is a TOKEN BUCKET, not a concurrency gate. That measurement decides the
 * whole design: running requests one at a time does NOT avoid a 429, because a serial loop of
 * fast responses still exceeds the sustained rate. What matters is requests per second over
 * time, and the measured boundary is that sustained <= 8 req/s is clean at any parallelism
 * while ~10 req/s is the onset of throttling.
 *
 * So there are two independent controls and they do different jobs:
 *   - the token bucket paces request STARTS to a sustained rate (the thing eCFR measures);
 *   - the semaphore bounds requests IN FLIGHT, which is about our own memory and socket use,
 *     not about politeness. A single title's XML can be 156 MB.
 *
 * The bucket is shared process-wide by default. A backfill worker pool, the delta sync, and an
 * ad-hoc script running in the same process must not each get their own 8 req/s.
 */

/**
 * FIFO queue with an amortised O(1) shift.
 *
 * `Array.prototype.shift` is O(n); the backfill can queue thousands of waiters behind a stalled
 * fetch and the quadratic blowup is not theoretical at that size.
 */
class FifoQueue<T> {
  #items: (T | undefined)[] = [];
  #head = 0;

  get size(): number {
    return this.#items.length - this.#head;
  }

  push(item: T): void {
    this.#items.push(item);
  }

  shift(): T | undefined {
    if (this.#head >= this.#items.length) return undefined;
    const item = this.#items[this.#head];
    this.#items[this.#head] = undefined;
    this.#head += 1;
    // Compact once the dead prefix is at least half the array, so memory is bounded without
    // paying a copy on every shift.
    if (this.#head > 32 && this.#head * 2 >= this.#items.length) {
      this.#items = this.#items.slice(this.#head);
      this.#head = 0;
    }
    return item;
  }
}

/** Cancels a scheduled callback. */
export type CancelTimer = () => void;

export interface RateGovernorOptions {
  /** Sustained requests per second. Default 8 — the measured clean ceiling. */
  ratePerSecond?: number;
  /**
   * Bucket capacity: how large an instantaneous burst is allowed after an idle period.
   *
   * Defaults to `min(ratePerSecond, concurrency)`. A capacity above the concurrency cap buys
   * nothing — no more than `concurrency` requests can be in flight regardless — while it does
   * let a freshly started process fire its whole bucket at once. With the defaults that would
   * be 8 requests inside 125 ms, an instantaneous ~64 req/s. The measurement that licenses
   * this client is "sustained <= 8 req/s is clean"; it says nothing about a spike that large,
   * so the default does not take one.
   */
  burst?: number;
  /** Maximum requests in flight. Default 4. */
  concurrency?: number;
  /** Injectable monotonic clock, in milliseconds. Tests pass a fake. */
  now?: () => number;
  /** Injectable timer, so tests do not have to wait in real time. */
  schedule?: (callback: () => void, delayMs: number) => CancelTimer;
}

export interface RateGovernorStats {
  /** Fractional tokens currently available. */
  tokens: number;
  inFlight: number;
  /** Callers waiting for a concurrency slot. */
  waitingForSlot: number;
  /** Callers holding a slot and waiting for a token. */
  waitingForToken: number;
}

const DEFAULT_RATE_PER_SECOND = 8;
const DEFAULT_CONCURRENCY = 4;

function defaultNow(): number {
  // performance.now() is monotonic and exists in Node 22 and in Workers; Date.now() can jump
  // backwards on a clock adjustment and would then hand out free tokens.
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function defaultSchedule(callback: () => void, delayMs: number): CancelTimer {
  const handle = setTimeout(callback, delayMs);
  // Deliberately NOT unref'd. An unref'd timer lets Node exit while a caller is still awaiting
  // its token, which turns "we are being polite" into "the process vanished mid-sync".
  return () => {
    clearTimeout(handle);
  };
}

export class RateGovernor {
  readonly ratePerSecond: number;
  readonly burst: number;
  readonly concurrency: number;

  readonly #now: () => number;
  readonly #schedule: (callback: () => void, delayMs: number) => CancelTimer;

  #tokens: number;
  #lastRefillMs: number;
  #inFlight = 0;
  readonly #tokenWaiters = new FifoQueue<() => void>();
  readonly #slotWaiters = new FifoQueue<() => void>();
  #cancelDrain: CancelTimer | null = null;

  constructor(options: RateGovernorOptions = {}) {
    const rate = options.ratePerSecond ?? DEFAULT_RATE_PER_SECOND;
    if (!(rate > 0) || !Number.isFinite(rate)) {
      throw new RangeError(`ratePerSecond must be a positive finite number, got ${rate}`);
    }
    const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new RangeError(`concurrency must be a positive integer, got ${concurrency}`);
    }
    this.ratePerSecond = rate;
    this.burst = options.burst ?? Math.min(rate, concurrency);
    this.concurrency = concurrency;
    this.#now = options.now ?? defaultNow;
    this.#schedule = options.schedule ?? defaultSchedule;
    // Start full: an idle process should not have to wait a second for its first request.
    this.#tokens = this.burst;
    this.#lastRefillMs = this.#now();
  }

  stats(): RateGovernorStats {
    this.#refill();
    return {
      tokens: this.#tokens,
      inFlight: this.#inFlight,
      waitingForSlot: this.#slotWaiters.size,
      waitingForToken: this.#tokenWaiters.size,
    };
  }

  /**
   * Run one request under the governor.
   *
   * The slot is taken before the token, so a caller that is going to be paced anyway does not
   * occupy a socket while it waits. With the defaults (4 in flight, 8/s) a slot waits at most
   * ~500 ms for its token, and when upstream is slow the in-flight bound backs everything off
   * naturally.
   *
   * `run` must wrap a SINGLE attempt. Retries go around it, not inside it — a retry is another
   * request and must pay for another token.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const releaseSlot = await this.#acquireSlot();
    try {
      await this.#acquireToken();
      return await fn();
    } finally {
      releaseSlot();
    }
  }

  #acquireSlot(): Promise<() => void> {
    const release = (): void => {
      this.#inFlight -= 1;
      const next = this.#slotWaiters.shift();
      if (next) {
        this.#inFlight += 1;
        next();
      }
    };
    if (this.#inFlight < this.concurrency) {
      this.#inFlight += 1;
      return Promise.resolve(release);
    }
    return new Promise<() => void>((resolve) => {
      this.#slotWaiters.push(() => {
        resolve(release);
      });
    });
  }

  #acquireToken(): Promise<void> {
    this.#refill();
    // The queue check keeps the bucket FIFO. Without it a caller arriving exactly as a token
    // lands can jump a queue that has been waiting, which starves the oldest request.
    if (this.#tokenWaiters.size === 0 && this.#tokens >= 1) {
      this.#tokens -= 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.#tokenWaiters.push(resolve);
      this.#scheduleDrain();
    });
  }

  #refill(): void {
    const now = this.#now();
    const elapsedMs = now - this.#lastRefillMs;
    if (elapsedMs <= 0) return;
    this.#lastRefillMs = now;
    this.#tokens = Math.min(this.burst, this.#tokens + (elapsedMs / 1000) * this.ratePerSecond);
  }

  #scheduleDrain(): void {
    if (this.#cancelDrain !== null || this.#tokenWaiters.size === 0) return;
    this.#refill();
    const deficit = 1 - this.#tokens;
    const waitMs = deficit <= 0 ? 0 : Math.ceil((deficit / this.ratePerSecond) * 1000);
    this.#cancelDrain = this.#schedule(() => {
      this.#cancelDrain = null;
      this.#drain();
    }, waitMs);
  }

  #drain(): void {
    this.#refill();
    while (this.#tokenWaiters.size > 0 && this.#tokens >= 1) {
      this.#tokens -= 1;
      const resolve = this.#tokenWaiters.shift();
      if (resolve) resolve();
    }
    if (this.#tokenWaiters.size > 0) this.#scheduleDrain();
  }
}

let shared: RateGovernor | null = null;

/**
 * The process-wide governor.
 *
 * Lazily constructed so that importing this module has no side effects, which matters for the
 * Worker bundle where module scope runs at isolate start.
 */
export function sharedRateGovernor(): RateGovernor {
  shared ??= new RateGovernor();
  return shared;
}

/** Test-only escape hatch: replace or clear the process-wide governor. */
export function setSharedRateGovernor(governor: RateGovernor | null): void {
  shared = governor;
}
