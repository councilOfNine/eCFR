/**
 * Logging for a job whose output is read twice: once streaming in a GitHub Actions console,
 * once as a post-mortem when the publish gate refuses to advance.
 *
 * Both readers want the same thing — a flat, greppable line with the numbers in it — so there
 * is no pretty-printing and no spinner. Timings are included because the only performance
 * fact we have measured (331.0 s for a serial gzipped pull of all 49 titles) is the baseline
 * a future regression gets compared against.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function currentThreshold(): number {
  const configured = (process.env.SYNC_LOG_LEVEL ?? 'info') as LogLevel;
  return LEVEL_ORDER[configured] ?? LEVEL_ORDER.info;
}

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(scope: string): Logger;
  /** Times an async unit of work and logs its duration at info. */
  time<T>(label: string, fn: () => Promise<T>): Promise<T>;
}

/**
 * Render one field value.
 *
 * Objects go through JSON rather than `String()`, which would print `[object Object]` — a log
 * line that says `counters=[object Object]` is worse than no log line, because it looks like
 * it worked.
 */
function renderValue(value: unknown): string {
  if (typeof value === 'string') return /[\s"]/.test(value) ? JSON.stringify(value) : value;
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return String(value);
  }
  if (typeof value === 'bigint') return `${value}n`;
  try {
    // JSON.stringify returns undefined for a function or symbol; name the type instead of
    // falling back to String(), which is the [object Object] trap this function exists to avoid.
    return JSON.stringify(value) ?? `[${typeof value}]`;
  } catch {
    // Circular, or a BigInt nested somewhere. Say so rather than throwing from a logger.
    return '[unserialisable]';
  }
}

function renderFields(fields: Record<string, unknown> | undefined): string {
  if (!fields) return '';
  const parts: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    parts.push(`${key}=${renderValue(value)}`);
  }
  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}

export function createLogger(scope = 'sync'): Logger {
  const emit = (level: LogLevel, message: string, fields?: Record<string, unknown>): void => {
    if (LEVEL_ORDER[level] < currentThreshold()) return;
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}${renderFields(fields)}`;
    // Everything above info goes to stderr so a CI step can capture failures separately.
    if (level === 'warn' || level === 'error') process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  };

  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (childScope) => createLogger(`${scope}:${childScope}`),
    async time(label, fn) {
      const started = performance.now();
      try {
        const result = await fn();
        emit('info', label, { ms: Math.round(performance.now() - started) });
        return result;
      } catch (error) {
        emit('error', `${label} failed`, {
          ms: Math.round(performance.now() - started),
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
  };
}
