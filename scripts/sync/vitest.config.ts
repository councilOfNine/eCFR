import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * Vitest resolves through Vite, not through `scripts/sync/lib/ts-loader.mjs`, so the
 * workspace aliases have to be restated here. Same targets, same reason: `scripts/` is not a
 * pnpm workspace member, so nothing links `@ecfr-atlas/*` into node_modules.
 *
 * Keep these in sync with the `paths` in tsconfig.json and the resolver in ts-loader.mjs. If
 * `scripts/` ever becomes a workspace package, all three can go.
 */
const packages = fileURLToPath(new URL('../../packages', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@ecfr-atlas/core/ecfr-schemas': `${packages}/core/src/ecfr-schemas.ts`,
      '@ecfr-atlas/core/api-schemas': `${packages}/core/src/api-schemas.ts`,
      '@ecfr-atlas/core': `${packages}/core/src/index.ts`,
      '@ecfr-atlas/ecfr': `${packages}/ecfr/src/index.ts`,
    },
  },
  test: {
    include: ['lib/**/*.test.ts'],
    environment: 'node',
    root: fileURLToPath(new URL('.', import.meta.url)),
  },
});
