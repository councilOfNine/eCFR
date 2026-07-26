/**
 * Side-effect module that makes `.ts` sources loadable from the plain-`node` entry points.
 *
 * Import this FIRST and statically; static imports finish evaluating before the importing
 * module's async body runs, so any `await import('./thing.js')` afterwards goes through the
 * hook. Registering inside the async body would be too late for anything already resolved.
 */

import { register } from 'node:module';

/**
 * Native, unflagged type stripping landed in 22.18.0 (and 23.6.0). Below that the pipeline
 * fails deep inside module resolution with an unreadable syntax error, so check up front and
 * say what is actually wrong.
 */
const MIN_NODE = [22, 18, 0];

function assertNodeVersion() {
  const parts = process.versions.node.split('.').map((n) => Number.parseInt(n, 10));
  const [major = 0, minor = 0, patch = 0] = parts;
  const [reqMajor, reqMinor, reqPatch] = MIN_NODE;
  const ok =
    major > reqMajor ||
    (major === reqMajor && (minor > reqMinor || (minor === reqMinor && patch >= reqPatch)));
  if (!ok) {
    console.error(
      `ecfr-atlas sync requires Node >= ${MIN_NODE.join('.')} (native TypeScript type stripping).\n` +
        `Running Node ${process.versions.node}. Upgrade Node, or run the pipeline through a ` +
        `TypeScript-aware loader.`,
    );
    process.exit(78); // EX_CONFIG
  }
}

assertNodeVersion();
register('./ts-loader.mjs', import.meta.url);
