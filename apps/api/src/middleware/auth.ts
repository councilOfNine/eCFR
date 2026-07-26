/**
 * Identify the caller, then meter them.
 *
 * Runs on every /v1 route. There is no route that skips it: an unauthenticated request is a
 * principal with a tier, not an absence of one, which is what makes anonymous access
 * meterable instead of free.
 */

import { createMiddleware } from 'hono/factory';
import { extractKey, parseKey, sha256Hex, timingSafeEqual } from '../auth/keys.js';
import {
  anonQuotaKey,
  checkBurst,
  clientIp,
  consumeQuota,
  rateLimitHeaders,
  utcDay,
} from '../auth/quota.js';
import {
  KEY_REQUIRED_MESSAGE,
  MALFORMED_KEY_MESSAGE,
  REVOKED_KEY_MESSAGE,
  SUSPENDED_ACCOUNT_MESSAGE,
  UNKNOWN_KEY_MESSAGE,
  UNVERIFIED_ACCOUNT_MESSAGE,
} from '../constants/messages.js';
import { getKeyById, touchKey } from '../db/accounts.js';
import { AccountStatus, ApiTier, assertNever, ErrorCode, PrincipalKind } from '../enums.js';
import type { AppEnv, Principal } from '../env.js';
import { ApiError, unauthorized } from '../errors.js';

/**
 * A presented key that does not resolve is a 401, not a downgrade to anonymous.
 *
 * Silently treating a bad key as anonymous is how a client ends up debugging "why am I getting
 * 429s at 500 requests" for an hour when the real answer is a typo in an environment variable.
 */
export const authenticate = createMiddleware<AppEnv>(async (c, next) => {
  const now = new Date();
  const day = utcDay(now);
  const presented = extractKey(c.req.raw.headers);

  let principal: Principal;

  if (presented === null) {
    principal = {
      kind: PrincipalKind.Anonymous,
      tier: ApiTier.Anonymous,
      quotaKey: await anonQuotaKey(c.env, clientIp(c.req.raw.headers), day),
    };
  } else {
    principal = await authenticateKey(c.env.DB, presented);
  }

  c.set('principal', principal);

  await checkBurst(c.env, principal);
  const quota = await consumeQuota(c.env, principal, day, now);
  c.set('quota', quota);

  // At most one write per key per UTC day. The auth lookup already returned last_used_at, so
  // the comparison costs nothing and the write is skipped 99.99% of the time.
  if (principal.kind === PrincipalKind.Key && principal.lastUsedAt?.slice(0, 10) !== day) {
    c.executionCtx.waitUntil(touchKey(c.env.DB, principal.keyId, now.toISOString()));
  }

  await next();

  for (const [key, value] of Object.entries(rateLimitHeaders(quota))) {
    c.res.headers.set(key, value);
  }
});

async function authenticateKey(db: D1Database, presented: string): Promise<Principal> {
  const parsed = parseKey(presented);
  if (!parsed) {
    throw unauthorized(MALFORMED_KEY_MESSAGE);
  }

  const row = await getKeyById(db, parsed.id);

  // Hash the presented key regardless of whether a row came back, so a request with an
  // unknown id costs the same as one with a known id. Otherwise the response time answers
  // "does this key id exist?" for free.
  const presentedHash = await sha256Hex(parsed.plaintext);

  if (!row || !timingSafeEqual(presentedHash, row.key_hash)) {
    throw unauthorized(UNKNOWN_KEY_MESSAGE);
  }
  if (row.revoked_at !== null) {
    throw unauthorized(REVOKED_KEY_MESSAGE, { revoked_at: row.revoked_at });
  }

  // Exhaustive over the account-status CHECK constraint, so a future status (say, `frozen`)
  // cannot slip through the old `!== 'active'` catch-all and silently authenticate.
  switch (row.account_status) {
    case AccountStatus.Active:
      break;
    case AccountStatus.Suspended:
      throw new ApiError({
        status: 403,
        code: ErrorCode.Forbidden,
        message: SUSPENDED_ACCOUNT_MESSAGE,
      });
    case AccountStatus.Pending:
      throw unauthorized(UNVERIFIED_ACCOUNT_MESSAGE);
    default:
      return assertNever(row.account_status, 'AccountStatus');
  }

  return {
    kind: PrincipalKind.Key,
    tier: row.tier,
    keyId: row.id,
    accountId: row.account_id,
    quotaKey: row.id,
    lastUsedAt: row.last_used_at,
  };
}

/**
 * Gate for the account-management routes: a real key, no anonymous access.
 *
 * The key identifies the account, so there is no separate session concept. An account that
 * has lost every key recovers by re-registering the same email, which re-sends a verification
 * token — that path is documented on POST /v1/account/register precisely so nobody has to
 * build a password reset.
 */
export const requireKey = createMiddleware<AppEnv>(async (c, next) => {
  const principal = c.get('principal');
  if (principal.kind !== PrincipalKind.Key) {
    throw unauthorized(KEY_REQUIRED_MESSAGE);
  }
  await next();
});
