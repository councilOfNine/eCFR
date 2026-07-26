/**
 * Validation at the snapshot boundary.
 *
 * core's `WordCount` schema types the four fields but cannot express the relationship between
 * them: `{ words: 104642, status: 'unavailable_fetch_failed' }` parses cleanly against it. That
 * combination is precisely the bug this project was rebuilt to make impossible — a number
 * stored under a status that says it was never measured — so it is checked here, at the only
 * point where data enters the site.
 *
 * The D1 schema enforces the same invariant with a CHECK constraint. A snapshot file has no
 * database behind it, so this is its equivalent. Both must agree; if you change one, change
 * the other, and note that the CHECK in 0001_init.sql was verified against real SQLite to
 * reject a number with an unknown status, a known status with no number, and an unknown with
 * no reason.
 */

import { KNOWN_STATUSES, UNKNOWN_STATUSES } from '@ecfr-atlas/core';
import type { WordCount } from '@ecfr-atlas/core/api-schemas';
import { z } from 'zod';

const KNOWN = new Set<string>(KNOWN_STATUSES);
const UNKNOWN = new Set<string>(UNKNOWN_STATUSES);

/**
 * Walks a parsed payload for anything shaped like a `WordCount` and asserts the three
 * relationships the type system cannot. Recursive because word counts appear nested several
 * levels deep (a part's sections, a chapter's parts' counts, an agency's scopes').
 */
export function assertWordCountsCoherent(value: unknown, path = '$'): void {
  if (value === null || typeof value !== 'object') return;

  if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) assertWordCountsCoherent(item, `${path}[${i}]`);
    return;
  }

  const record = value as Record<string, unknown>;

  if ('words' in record && 'status' in record && typeof record.status === 'string') {
    const { words, status, reason } = record as unknown as WordCount;

    if (words === null && !UNKNOWN.has(status)) {
      throw new Error(
        `${path}: word count is null but status is "${status}". A null count must carry one of: ` +
          `${[...UNKNOWN].join(', ')}.`,
      );
    }
    if (words !== null && !KNOWN.has(status)) {
      throw new Error(
        `${path}: word count is ${words} but status is "${status}", which asserts the value was ` +
          `never measured. This is the exact defect the rewrite exists to prevent — an exporter ` +
          `must call unavailable() rather than publishing a number it did not measure.`,
      );
    }
    if (words === null && (reason === null || reason === undefined || reason === '')) {
      throw new Error(
        `${path}: word count is unknown but gives no reason. Every "—" on the site is a claim that we know why.`,
      );
    }
    if (words !== null && reason !== null && reason !== undefined) {
      throw new Error(`${path}: word count is ${words} but also carries reason "${reason}".`);
    }
  }

  for (const [key, child] of Object.entries(record)) {
    assertWordCountsCoherent(child, `${path}.${key}`);
  }
}

/**
 * Parse against a schema and then run the cross-field measurement check.
 *
 * Failures throw with the source label in the message. The build must die here rather than
 * render a page: a snapshot that violates the contract is not degraded data, it is data whose
 * meaning we no longer know.
 */
export function parseChecked<T extends z.ZodTypeAny>(
  schema: T,
  raw: unknown,
  label: string,
): z.infer<T> {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `${label}: does not match the snapshot contract.\n${z.prettifyError(result.error)}`,
    );
  }
  assertWordCountsCoherent(result.data, label);
  return result.data;
}
