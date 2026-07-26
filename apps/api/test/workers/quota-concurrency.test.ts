/**
 * The daily quota counter, under actual concurrency.
 *
 * apps/api/test/api.test.ts covers the metering rules against a node:sqlite shim, which runs
 * every statement to completion before the next one starts. That is the right place for the
 * rules and the wrong place for this property: a read-then-write counter passes a sequential
 * test perfectly and loses increments the moment two requests overlap. The whole reason the
 * quota is
 *
 *     INSERT ... ON CONFLICT DO UPDATE SET count = count + 1 RETURNING count
 *
 * rather than a SELECT followed by an UPDATE is that the atomic form cannot lose one — and
 * showing that needs a real database with real concurrent writers.
 *
 * The stakes are not academic. The Cloudflare rate-limiting binding is documented as "not to be
 * used as an accurate accounting system" and is per-location, so it handles burst only. This
 * counter is the only number the API can honestly put in a RateLimit header.
 */

import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import { TIERS } from '../../src/constants/config.js';

interface TestEnv {
  DB: D1Database;
  ANON_SALT?: string;
  __SEED: string[];
}

const testEnv = env as unknown as TestEnv;
const BASE = 'https://api.test';

/** Enough overlap to lose an increment if the write were not atomic, without being slow. */
const CONCURRENT = 25;

beforeEach(async () => {
  await testEnv.DB.batch(testEnv.__SEED.map((sql) => testEnv.DB.prepare(sql)));
});

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

interface MintedKey {
  plaintext: string;
  keyId: string;
  secret: string;
}

async function mintKey(tier: 'registered' | 'elevated' = 'registered'): Promise<MintedKey> {
  const accountId = crypto.randomUUID();
  const keyId = crypto.randomUUID();
  // 43 base64url characters is what 32 bytes of entropy produces; the shape has to pass
  // `parseKey`'s allowlist or the request never reaches the counter.
  const secret = 'Zq7'.padEnd(43, 'x');
  const plaintext = `ecfr_${keyId}_${secret}`;

  await testEnv.DB.batch([
    testEnv.DB.prepare(
      `INSERT INTO api_account (id, email, status, created_at, verified_at)
       VALUES (?, ?, 'active', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    ).bind(accountId, `${keyId}@example.test`),
    testEnv.DB.prepare(
      `INSERT INTO api_key (id, account_id, key_hash, key_suffix, tier, created_at)
       VALUES (?, ?, ?, ?, ?, '2026-01-01T00:00:00Z')`,
    ).bind(keyId, accountId, await sha256Hex(plaintext), secret.slice(-4), tier),
  ]);

  return { plaintext, keyId, secret };
}

const utcDay = (): string => new Date().toISOString().slice(0, 10);

describe('N concurrent requests produce exactly N', () => {
  it('counts every one of 25 overlapping keyed requests', async () => {
    const key = await mintKey();

    // Fired without awaiting in between, so they are genuinely in flight together rather than
    // being a loop that happens to use Promise.all.
    const responses = await Promise.all(
      Array.from({ length: CONCURRENT }, () =>
        SELF.fetch(`${BASE}/v1/meta`, {
          headers: {
            Authorization: `Bearer ${key.plaintext}`,
            'CF-Connecting-IP': '203.0.113.1',
          },
        }),
      ),
    );

    // The registered tier allows 25,000/day, so none of these may be rejected.
    expect(responses.every((r) => r.status === 200)).toBe(true);

    const row = await testEnv.DB.prepare(
      `SELECT count FROM api_usage_day WHERE key_id = ? AND day = ?`,
    )
      .bind(key.keyId, utcDay())
      .first<{ count: number }>();

    // Exactly N. A lost update would show fewer; a double-count would show more, and either
    // would make the RateLimit headers a guess.
    expect(row?.count).toBe(CONCURRENT);
  });

  it('counts every one of 25 overlapping anonymous requests', async () => {
    // Anonymous requests are metered on sha256(salt + IP + day) in a separate table, because
    // `api_usage_day.key_id` has a foreign key to api_key and an anonymous counter row has
    // nowhere to point. Same atomicity requirement, different table.
    const responses = await Promise.all(
      Array.from({ length: CONCURRENT }, () =>
        SELF.fetch(`${BASE}/v1/meta`, { headers: { 'CF-Connecting-IP': '198.51.100.4' } }),
      ),
    );
    expect(responses.every((r) => r.status === 200)).toBe(true);

    const rows = await testEnv.DB.prepare(
      `SELECT anon_key, count FROM api_usage_anon_day WHERE day = ?`,
    )
      .bind(utcDay())
      .all<{ anon_key: string; count: number }>();

    // One bucket for one address on one day, holding all 25.
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]?.count).toBe(CONCURRENT);

    // The address itself is never written. A 32-bit space is small enough that an unsalted
    // digest of an IP is an IP, so the key is salted and day-scoped: today's hash cannot be
    // joined to yesterday's, which is what stops the table becoming a movement history.
    const stored = rows.results[0]?.anon_key ?? '';
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(stored).not.toContain('198.51.100.4');
    expect(stored).not.toBe(await sha256Hex('198.51.100.4'));
  });

  it('meters two different addresses into two different buckets', async () => {
    await Promise.all([
      SELF.fetch(`${BASE}/v1/meta`, { headers: { 'CF-Connecting-IP': '198.51.100.5' } }),
      SELF.fetch(`${BASE}/v1/meta`, { headers: { 'CF-Connecting-IP': '198.51.100.6' } }),
      SELF.fetch(`${BASE}/v1/meta`, { headers: { 'CF-Connecting-IP': '198.51.100.5' } }),
    ]);

    const rows = await testEnv.DB.prepare(
      `SELECT count FROM api_usage_anon_day WHERE day = ? ORDER BY count DESC`,
    )
      .bind(utcDay())
      .all<{ count: number }>();

    expect(rows.results.map((r) => r.count)).toEqual([2, 1]);
  });

  it('reports a remaining balance consistent with the count it stored', async () => {
    const key = await mintKey();
    const limit = TIERS.registered.dailyQuota;

    for (let i = 1; i <= 3; i++) {
      const response = await SELF.fetch(`${BASE}/v1/meta`, {
        headers: { Authorization: `Bearer ${key.plaintext}`, 'CF-Connecting-IP': '203.0.113.2' },
      });
      // The header is derived from the RETURNING value, not from a second read, so it cannot
      // disagree with the row even under concurrency.
      expect(response.headers.get('RateLimit-Limit')).toBe(String(limit));
      expect(response.headers.get('RateLimit-Remaining')).toBe(String(limit - i));
    }

    const row = await testEnv.DB.prepare(`SELECT count FROM api_usage_day WHERE key_id = ?`)
      .bind(key.keyId)
      .first<{ count: number }>();
    expect(row?.count).toBe(3);
  });
});

describe('a key is a credential, and the database never holds one', () => {
  it('stores a hash and a suffix, never the secret', async () => {
    const key = await mintKey();

    const row = await testEnv.DB.prepare(`SELECT key_hash, key_suffix FROM api_key WHERE id = ?`)
      .bind(key.keyId)
      .first<{ key_hash: string; key_suffix: string }>();

    expect(row?.key_hash).toBe(await sha256Hex(key.plaintext));
    expect(row?.key_hash).not.toContain(key.secret);
    expect(row?.key_suffix).toBe(key.secret.slice(-4));

    // Belt and braces: nothing anywhere in the row set contains the plaintext.
    const dump = await testEnv.DB.prepare(`SELECT * FROM api_key`).all();
    expect(JSON.stringify(dump.results)).not.toContain(key.secret);
  });

  it('accepts the key, then rejects it the moment it is revoked', async () => {
    const key = await mintKey();

    const before = await SELF.fetch(`${BASE}/v1/meta`, {
      headers: { Authorization: `Bearer ${key.plaintext}`, 'CF-Connecting-IP': '203.0.113.3' },
    });
    expect(before.status).toBe(200);
    expect(before.headers.get('X-Api-Tier')).toBe('registered');

    await testEnv.DB.prepare(`UPDATE api_key SET revoked_at = ? WHERE id = ?`)
      .bind(new Date().toISOString(), key.keyId)
      .run();

    const after = await SELF.fetch(`${BASE}/v1/meta`, {
      headers: { Authorization: `Bearer ${key.plaintext}`, 'CF-Connecting-IP': '203.0.113.3' },
    });

    // A revoked key must be an error, NOT a silent downgrade to the anonymous tier. Downgrading
    // would let a revoked credential keep working at a lower limit, and the caller would have
    // no way to notice their key had stopped being honoured.
    expect(after.status).toBe(401);
    expect(after.headers.get('X-Api-Tier')).not.toBe('registered');
  });

  it('never accepts a key from the query string', async () => {
    // Query strings land in access logs, browser history and Referer headers. A credential that
    // works there is a credential that leaks there.
    const key = await mintKey();
    const response = await SELF.fetch(
      `${BASE}/v1/meta?api_key=${encodeURIComponent(key.plaintext)}`,
      { headers: { 'CF-Connecting-IP': '203.0.113.4' } },
    );

    expect(response.status).toBe(200);
    // Served, but as an anonymous caller — the key in the URL was ignored entirely.
    expect(response.headers.get('X-Api-Tier')).toBe('anonymous');

    const keyed = await testEnv.DB.prepare(`SELECT COUNT(*) AS n FROM api_usage_day`).first<{
      n: number;
    }>();
    expect(keyed?.n).toBe(0);
  });
});
