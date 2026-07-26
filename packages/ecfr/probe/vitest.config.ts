/**
 * Standalone config for the live-network measurement harness.
 *
 * Separate from the repo root config on purpose: the root config excludes this directory from
 * every project so CI never depends on ecfr.gov, which rate-limits with a token bucket and
 * times out at ~50 s on large titles. Run it by hand when a measured fact needs re-checking:
 *
 *   pnpm vitest run --config packages/ecfr/probe/vitest.config.ts
 *
 * Its output is evidence, not an assertion. Numbers it produces belong in the project brief
 * after a human has read them.
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'ecfr-live-probe',
    environment: 'node',
    include: ['packages/ecfr/probe/**/*.test.ts'],
    // A whole-title fetch plus parse legitimately runs for minutes.
    testTimeout: 900_000,
    hookTimeout: 900_000,
    // Serial: the governor's 8 req/s budget is per-process, and parallel workers would each
    // get their own.
    fileParallelism: false,
  },
});
