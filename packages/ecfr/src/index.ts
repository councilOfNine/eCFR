/**
 * `@ecfr-atlas/ecfr` — the eCFR client, XML parser, and word counter.
 *
 * The three concerns are separated on purpose:
 *   - `client`    knows how to talk to eCFR politely and how to fail honestly.
 *   - `parser`    knows WHICH text is countable and how to render it safely.
 *   - `wordcount` knows HOW to count, and is the only place a total is defined.
 *
 * Nothing here writes to a database and nothing here decides what a number means. Consumers
 * receive `Measurement` values from `@ecfr-atlas/core` and store them with `toRow`.
 */

export * from './client.js';
export * from './errors.js';
export * from './governor.js';
export * from './parser.js';
export * from './wordcount.js';
