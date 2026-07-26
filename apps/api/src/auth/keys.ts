/**
 * API key material.
 *
 * Rules this file enforces:
 *   - the secret is generated from `crypto.getRandomValues` and never from Math.random,
 *     a timestamp, or a counter;
 *   - only `sha256(full key)` is persisted, so a database dump does not contain a credential;
 *   - the plaintext is returned exactly once, by the endpoint that created it;
 *   - comparison is constant-time, so a caller cannot binary-search a hash by timing the
 *     lookup.
 *
 * Format: `ecfr_<key id>_<secret>`. The key id is in the plaintext on purpose — it turns
 * authentication into one primary-key lookup plus one fixed-cost comparison, instead of a
 * scan, and it means a leaked key found in a log can be revoked by its visible id without
 * anyone having to handle the secret half.
 */

import { KEY_PREFIX, KEY_SECRET_BYTES, VERIFY_TOKEN_BYTES } from '../constants/config.js';

export interface GeneratedKey {
  /** api_key.id */
  id: string;
  /** The full `ecfr_..._...` string. Shown once, then unrecoverable. */
  plaintext: string;
  /** sha256 of `plaintext`, hex. The only part that is stored. */
  hash: string;
  /** Last 4 characters of the secret, for identifying a key in a list. */
  suffix: string;
}

export async function generateKey(id: string = crypto.randomUUID()): Promise<GeneratedKey> {
  const secret = randomBase64Url(KEY_SECRET_BYTES);
  const plaintext = `${KEY_PREFIX}_${id}_${secret}`;
  return {
    id,
    plaintext,
    hash: await sha256Hex(plaintext),
    suffix: secret.slice(-4),
  };
}

export interface ParsedKey {
  id: string;
  plaintext: string;
}

/**
 * Split a presented credential without touching the database.
 *
 * The shape check is deliberately strict and length-bounded: a malformed Authorization header
 * should cost a string comparison, not a query. The id must look like a UUID because that is
 * what `api_key.id` is; anything else cannot match a row and there is no reason to ask.
 */
const KEY_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SECRET_RE = /^[A-Za-z0-9_-]{16,128}$/;

export function parseKey(raw: string): ParsedKey | null {
  if (raw.length > 256) return null;

  const marker = `${KEY_PREFIX}_`;
  if (!raw.startsWith(marker)) return null;
  const rest = raw.slice(marker.length);

  // Split on the FIRST underscore, not all of them. The secret is base64url, whose alphabet
  // includes `_`, so `raw.split('_')` yields four or more parts for roughly a third of all
  // generated keys — which authenticated fine in a hand-written test and rejected real keys
  // in production. A UUID contains no underscore, so the first one is unambiguously the
  // separator.
  const separator = rest.indexOf('_');
  if (separator === -1) return null;

  const id = rest.slice(0, separator);
  const secret = rest.slice(separator + 1);
  if (!KEY_ID_RE.test(id)) return null;
  if (!SECRET_RE.test(secret)) return null;
  return { id, plaintext: raw };
}

/**
 * Read the credential from the request.
 *
 * `Authorization: Bearer <key>` is the documented form. `X-Api-Key` is accepted because a
 * meaningful share of API consumers are analysts driving this from a spreadsheet add-in or a
 * BI tool that only exposes a custom-header field. A key in a query string is NOT accepted:
 * query strings land in access logs, browser history, and Referer headers.
 */
export function extractKey(headers: Headers): string | null {
  const auth = headers.get('authorization');
  if (auth) {
    const match = /^Bearer\s+(\S{1,256})$/i.exec(auth);
    if (match?.[1]) return match[1];
  }
  const header = headers.get('x-api-key');
  if (header && header.length <= 256) return header.trim();
  return null;
}

// ─── verification tokens ─────────────────────────────────────────────────────

export interface GeneratedToken {
  plaintext: string;
  hash: string;
}

export async function generateVerifyToken(): Promise<GeneratedToken> {
  const plaintext = randomBase64Url(VERIFY_TOKEN_BYTES);
  return { plaintext, hash: await sha256Hex(plaintext) };
}

// ─── primitives ──────────────────────────────────────────────────────────────

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return hex(new Uint8Array(digest));
}

/**
 * Constant-time string comparison.
 *
 * Written by hand rather than using `crypto.subtle.timingSafeEqual`, which is a Cloudflare
 * extension whose typing has moved between releases, or `node:crypto`, which would pull the
 * compat layer in for four lines. Both operands here are fixed-length hex digests, so the
 * early length return leaks nothing an attacker does not already know.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    // charCodeAt is in-bounds for every i < length; the loop cannot short-circuit.
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function randomBase64Url(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let binary = '';
  for (const byte of buf) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function hex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}
