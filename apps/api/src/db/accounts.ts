/**
 * Account and key persistence.
 *
 * Nothing in this file ever selects a secret, because no secret is stored. `api_key.key_hash`
 * is the only credential-derived value on disk, and it leaves this module only to be compared
 * against a hash of a presented key.
 */

import type { AccountStatus, KeyTier } from '../enums.js';

// The account-status literals in the SQL below ('pending', 'active', 'suspended') are written
// out rather than interpolated from `AccountStatus`. They are already pinned by the CHECK
// constraint on `api_account.status` in packages/db/migrations/0001_init.sql — the same frozen
// source `AccountStatus` mirrors — so interpolation would buy nothing and would establish a
// pattern of building SQL text from JavaScript, which is not a habit worth having in a file
// that also handles credentials. Every value a CALLER supplies is bound, never interpolated.

export interface AccountRow {
  id: string;
  email: string;
  organization: string | null;
  intended_use: string | null;
  status: AccountStatus;
  verify_token_hash: string | null;
  verify_sent_at: string | null;
  created_at: string;
  verified_at: string | null;
}

export interface KeyRow {
  id: string;
  account_id: string;
  key_hash: string;
  key_suffix: string;
  label: string | null;
  tier: KeyTier;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

/**
 * Look up the principal behind a presented key id.
 *
 * Joins the account so a suspended account's keys stop working immediately rather than at the
 * next key rotation, and returns `account_status` so the caller can say *why* a valid-looking
 * key was refused.
 */
export interface KeyPrincipalRow extends KeyRow {
  account_status: AccountRow['status'];
}

export async function getKeyById(db: D1Database, keyId: string): Promise<KeyPrincipalRow | null> {
  return db
    .prepare(
      `SELECT k.id, k.account_id, k.key_hash, k.key_suffix, k.label, k.tier,
              k.created_at, k.last_used_at, k.revoked_at,
              a.status AS account_status
         FROM api_key k
         JOIN api_account a ON a.id = k.account_id
        WHERE k.id = ?`,
    )
    .bind(keyId)
    .first<KeyPrincipalRow>();
}

export async function listKeys(db: D1Database, accountId: string): Promise<KeyRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, account_id, key_hash, key_suffix, label, tier,
              created_at, last_used_at, revoked_at
         FROM api_key
        WHERE account_id = ?
        ORDER BY created_at DESC`,
    )
    .bind(accountId)
    .all<KeyRow>();
  return results;
}

export async function countActiveKeys(db: D1Database, accountId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM api_key WHERE account_id = ? AND revoked_at IS NULL`)
    .bind(accountId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function insertKey(
  db: D1Database,
  key: {
    id: string;
    accountId: string;
    hash: string;
    suffix: string;
    label: string | null;
    tier: KeyTier;
    createdAt: string;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO api_key (id, account_id, key_hash, key_suffix, label, tier, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(key.id, key.accountId, key.hash, key.suffix, key.label, key.tier, key.createdAt)
    .run();
}

/**
 * Revoke rather than delete.
 *
 * A deleted key would cascade its api_usage_day rows away, taking the abuse trail with it —
 * which is precisely the history you want when someone revokes a key immediately after a
 * spike. Revocation is also idempotent here: re-revoking keeps the original timestamp.
 */
export async function revokeKey(
  db: D1Database,
  accountId: string,
  keyId: string,
  now: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE api_key SET revoked_at = ?
        WHERE id = ? AND account_id = ? AND revoked_at IS NULL`,
    )
    .bind(now, keyId, accountId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/**
 * Record that a key was used, at most once per UTC day.
 *
 * A write on every request would double this Worker's write volume for a field nobody reads
 * at sub-day resolution. The caller already has `last_used_at` from the auth lookup, so the
 * day comparison is free.
 */
export async function touchKey(db: D1Database, keyId: string, now: string): Promise<void> {
  await db.prepare(`UPDATE api_key SET last_used_at = ? WHERE id = ?`).bind(now, keyId).run();
}

export async function getAccountByEmail(db: D1Database, email: string): Promise<AccountRow | null> {
  return db.prepare(`SELECT * FROM api_account WHERE email = ?`).bind(email).first<AccountRow>();
}

export async function getAccountById(db: D1Database, id: string): Promise<AccountRow | null> {
  return db.prepare(`SELECT * FROM api_account WHERE id = ?`).bind(id).first<AccountRow>();
}

/**
 * Create the account if new, or re-arm verification if it already exists.
 *
 * `ON CONFLICT (email)` rather than a read-then-write: two simultaneous registrations for the
 * same address must not race into a UNIQUE violation that surfaces as a 500. The existing
 * `status` is preserved, so re-registering an already-active account issues a fresh token
 * (the documented way to recover from losing every key) without downgrading the account.
 */
export async function upsertPendingAccount(
  db: D1Database,
  account: {
    id: string;
    email: string;
    organization: string | null;
    intendedUse: string | null;
    verifyTokenHash: string;
    now: string;
  },
): Promise<AccountRow> {
  await db
    .prepare(
      `INSERT INTO api_account
         (id, email, organization, intended_use, status, verify_token_hash, verify_sent_at, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)
       ON CONFLICT (email) DO UPDATE SET
         organization      = COALESCE(excluded.organization, api_account.organization),
         intended_use      = COALESCE(excluded.intended_use, api_account.intended_use),
         verify_token_hash = excluded.verify_token_hash,
         verify_sent_at    = excluded.verify_sent_at`,
    )
    .bind(
      account.id,
      account.email,
      account.organization,
      account.intendedUse,
      account.verifyTokenHash,
      account.now,
      account.now,
    )
    .run();

  const row = await getAccountByEmail(db, account.email);
  if (!row) throw new Error('account upsert did not produce a row');
  return row;
}

/**
 * Exchange a verification token for an active account.
 *
 * The token is looked up by its hash, which is what the partial index
 * `idx_account_verify ... WHERE verify_token_hash IS NOT NULL` exists for. Clearing the hash
 * in the same statement makes the token single-use: a second attempt matches nothing.
 */
export async function consumeVerifyToken(
  db: D1Database,
  tokenHash: string,
  now: string,
): Promise<AccountRow | null> {
  const account = await db
    .prepare(`SELECT * FROM api_account WHERE verify_token_hash = ?`)
    .bind(tokenHash)
    .first<AccountRow>();
  if (!account) return null;

  const result = await db
    .prepare(
      `UPDATE api_account
          SET status = CASE WHEN status = 'suspended' THEN 'suspended' ELSE 'active' END,
              verified_at = COALESCE(verified_at, ?),
              verify_token_hash = NULL
        WHERE id = ? AND verify_token_hash = ?`,
    )
    .bind(now, account.id, tokenHash)
    .run();

  // Zero changes means another request consumed the same token between the read and the
  // write. That is a race, not a valid verification, and must not mint a key.
  if ((result.meta.changes ?? 0) === 0) return null;

  return getAccountById(db, account.id);
}

/** Operator-only: move an account's keys to a higher tier. */
export async function setAccountTier(
  db: D1Database,
  accountId: string,
  tier: KeyTier,
): Promise<number> {
  const result = await db
    .prepare(`UPDATE api_key SET tier = ? WHERE account_id = ? AND revoked_at IS NULL`)
    .bind(tier, accountId)
    .run();
  return result.meta.changes ?? 0;
}
