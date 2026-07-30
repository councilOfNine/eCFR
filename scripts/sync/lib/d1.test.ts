/**
 * The retry contract, proven against a real subprocess: a fake `wrangler` binary that fails
 * with the exact error shape run 7 died on (Authentication error [code: 10000] from the D1
 * import API), then succeeds. Mocking execFile would test the mock; the class resolves and
 * spawns its own binary, so the test plants one for it to find.
 */

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import type { SyncConfig } from './config.js';
import { D1, D1Error } from './d1.js';
import type { Logger } from './log.js';

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
  time: <T>(_label: string, fn: () => Promise<T>) => fn(),
};

const FAKE_WRANGLER = `#!/bin/sh
n=$(cat "$FAKE_WRANGLER_COUNT" 2>/dev/null || echo 0)
n=$((n+1))
printf '%s' "$n" > "$FAKE_WRANGLER_COUNT"
if [ "$n" -lt "$FAKE_WRANGLER_SUCCEED_AT" ]; then
  echo '{"error":{"text":"A request to the Cloudflare API failed. Authentication error [code: 10000]"}}'
  exit 1
fi
echo '[]'
`;

const repoRoot = mkdtempSync(join(tmpdir(), 'd1-retry-'));
const countFile = join(repoRoot, 'count');

// The class prefers the workspace-pinned binary at node_modules/.bin/wrangler; plant the
// fake there so no PATH games are needed.
mkdirSync(join(repoRoot, 'node_modules', '.bin'), { recursive: true });
writeFileSync(join(repoRoot, 'node_modules', '.bin', 'wrangler'), FAKE_WRANGLER, 'utf8');
chmodSync(join(repoRoot, 'node_modules', '.bin', 'wrangler'), 0o755);

// Only the fields the class reads; the rest of SyncConfig is irrelevant here.
const config = {
  repoRoot,
  d1Database: 'ecfr-atlas',
  wranglerConfig: join(repoRoot, 'absent.jsonc'),
  local: true,
} as SyncConfig;

function attempts(): number {
  return Number(readFileSync(countFile, 'utf8'));
}

describe('D1 retry behaviour', () => {
  beforeEach(() => {
    writeFileSync(countFile, '0', 'utf8');
    process.env.FAKE_WRANGLER_COUNT = countFile;
  });

  afterAll(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('applyFile survives transient failures by retrying', async () => {
    process.env.FAKE_WRANGLER_SUCCEED_AT = '3';

    const d1 = new D1(config, silentLogger, [1, 1]);
    await d1.applyFile('/tmp/whatever.sql');

    expect(attempts()).toBe(3);
  });

  it('gives up once the backoff schedule is exhausted, surfacing the last error', async () => {
    process.env.FAKE_WRANGLER_SUCCEED_AT = '99';

    const d1 = new D1(config, silentLogger, [1, 1]);
    await expect(d1.applyFile('/tmp/whatever.sql')).rejects.toThrow(/Authentication error/);
    expect(attempts()).toBe(3);
  });

  it('command() does not retry: it carries the one non-idempotent statement', async () => {
    process.env.FAKE_WRANGLER_SUCCEED_AT = '2';

    const d1 = new D1(config, silentLogger, [1, 1]);
    await expect(d1.command('INSERT INTO sync_run (kind) VALUES (1)', 'open-run')).rejects.toThrow(
      D1Error,
    );
    expect(attempts()).toBe(1);
  });
});
