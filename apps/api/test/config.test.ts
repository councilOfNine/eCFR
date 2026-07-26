/**
 * The burst limits live in two places and there is no way to make that one place: a Worker
 * cannot read its own rate-limit binding's configuration back at runtime. This test is the
 * thing that keeps `TIERS` in src/config.ts and the `ratelimits` block in wrangler.jsonc from
 * drifting, which would otherwise show up as an API that documents one number and enforces
 * another.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TIERS } from '../src/constants/config.js';
import { API_TIERS } from '../src/enums.js';

interface WranglerConfig {
  compatibility_date: string;
  observability?: { enabled?: boolean };
  d1_databases?: { binding: string; database_name: string; migrations_dir?: string }[];
  r2_buckets?: { binding: string }[];
  ratelimits?: { name: string; namespace_id: string; simple: { limit: number; period: number } }[];
  triggers?: { crons?: string[] };
  vars?: Record<string, string>;
}

/**
 * Strip JSONC comments.
 *
 * A regex would corrupt any `//` inside a string literal, and wrangler.jsonc contains a URL in
 * the User-Agent var. Hence a character-level scan that knows when it is inside a string.
 */
function stripJsonComments(source: string): string {
  let out = '';
  let inString = false;
  let inLine = false;
  let inBlock = false;

  for (let i = 0; i < source.length; i++) {
    const char = source[i] as string;
    const next = source[i + 1];

    if (inLine) {
      if (char === '\n') {
        inLine = false;
        out += char;
      }
      continue;
    }
    if (inBlock) {
      if (char === '*' && next === '/') {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += char;
      // A backslash escapes the next character, including a closing quote.
      if (char === '\\') {
        out += source[i + 1] ?? '';
        i++;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === '/' && next === '/') {
      inLine = true;
      i++;
      continue;
    }
    if (char === '/' && next === '*') {
      inBlock = true;
      i++;
      continue;
    }
    out += char;
  }
  return out;
}

const raw = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
const config = JSON.parse(stripJsonComments(raw)) as WranglerConfig;

describe('wrangler.jsonc', () => {
  it('declares one rate-limit namespace per tier, matching TIERS exactly', () => {
    const byName = new Map((config.ratelimits ?? []).map((r) => [r.name, r]));
    expect(byName.size).toBe(API_TIERS.length);

    for (const tier of API_TIERS) {
      const expected = TIERS[tier];
      const declared = byName.get(expected.burstBinding);
      expect(declared, `${expected.burstBinding} is missing from wrangler.jsonc`).toBeDefined();
      expect(declared?.simple.limit, `${tier} burst limit`).toBe(expected.burstPerMinute);
      // The binding accepts ONLY 10 or 60 for `period`. Anything else is rejected at deploy
      // time, which is a slow way to find out.
      expect([10, 60], `${tier} burst period`).toContain(declared?.simple.period);
    }
  });

  it('gives each namespace a distinct id, so tiers do not share a bucket', () => {
    const ids = (config.ratelimits ?? []).map((r) => r.namespace_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('binds the database the migrations and the root scripts expect', () => {
    const d1 = config.d1_databases?.[0];
    expect(d1?.binding).toBe('DB');
    // Root package.json's db:migrate:* target this name through this config file.
    expect(d1?.database_name).toBe('ecfr-atlas');
    expect(d1?.migrations_dir).toBe('../../packages/db/migrations');
  });

  it('binds R2 for part content and the diff memo', () => {
    expect(config.r2_buckets?.[0]?.binding).toBe('CONTENT');
  });

  it('has observability on', () => {
    expect(config.observability?.enabled).toBe(true);
  });

  it('pins the compatibility date the module was written against', () => {
    expect(config.compatibility_date).toBe('2026-07-01');
  });

  it('schedules only the retention sweep — the corpus sync is not a Worker', () => {
    expect(config.triggers?.crons).toHaveLength(1);
  });

  it('sends a descriptive User-Agent with a contact URL, as eCFR asks', () => {
    const ua = config.vars?.ECFR_USER_AGENT ?? '';
    expect(ua).toMatch(/ecfr-atlas/);
    expect(ua).toMatch(/https?:\/\//);
  });
});

/**
 * `.dev.vars.example` is documentation, and undocumented configuration is discovered by a
 * deployment failing. ANON_SALT is the sharp case: it is REQUIRED, it has no fallback by
 * design, and a deployment missing it 500s every anonymous request — so the inventory of what
 * must be set cannot be allowed to drift away from the `Env` the code actually reads.
 *
 * Parsed out of the source rather than duplicated, so this asserts against the interface that
 * ships. Bindings are excluded in both directions: they come from wrangler.jsonc, and listing
 * one in a vars file would be a wrong instruction, not a missing one.
 */
describe('.dev.vars.example', () => {
  const envSource = readFileSync(new URL('../src/env.ts', import.meta.url), 'utf8');
  const exampleSource = readFileSync(new URL('../.dev.vars.example', import.meta.url), 'utf8');

  /** Types supplied by wrangler.jsonc as bindings, never by the environment. */
  const BINDING_TYPES = new Set(['D1Database', 'R2Bucket', 'RateLimitBinding']);

  /** The body of `export interface Env { ... }`, brace-matched, with comments stripped. */
  function envInterfaceBody(): string {
    const marker = 'export interface Env {';
    const start = envSource.indexOf(marker);
    expect(start, 'src/env.ts no longer declares `export interface Env {`').toBeGreaterThan(-1);

    let depth = 0;
    let end = start + marker.length - 1;
    for (let i = start + marker.length - 1; i < envSource.length; i++) {
      if (envSource[i] === '{') depth++;
      else if (envSource[i] === '}') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    return envSource
      .slice(start + marker.length, end)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
  }

  const fields = [...envInterfaceBody().matchAll(/^\s*([A-Z][A-Z0-9_]*)\??:\s*([A-Za-z0-9_]+)/gm)]
    .map((m) => ({ name: m[1] as string, type: m[2] as string }))
    .filter((f) => f.name !== undefined);

  const fromEnvironment = fields.filter((f) => !BINDING_TYPES.has(f.type)).map((f) => f.name);
  const bindings = fields.filter((f) => BINDING_TYPES.has(f.type)).map((f) => f.name);

  /** `NAME=` at the start of a line, optionally commented out for an optional var. */
  const documented = new Set(
    [...exampleSource.matchAll(/^[ \t]*#?[ \t]*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1] as string),
  );

  it('parsed a plausible Env interface', () => {
    // Guards the regexes above: a parse that silently matched nothing would make every
    // assertion below vacuously true, which is the failure mode of a test like this.
    expect(fromEnvironment).toContain('ANON_SALT');
    expect(bindings).toContain('DB');
    expect(fromEnvironment.length).toBeGreaterThanOrEqual(5);
  });

  it('documents every variable src/env.ts reads from the environment', () => {
    for (const name of fromEnvironment) {
      expect(
        documented,
        `${name} is read by src/env.ts but absent from .dev.vars.example`,
      ).toContain(name);
    }
  });

  it('documents nothing the code does not read', () => {
    for (const name of documented) {
      expect(
        fromEnvironment,
        `${name} is documented in .dev.vars.example but no longer read by src/env.ts`,
      ).toContain(name);
    }
  });

  it('does not present a wrangler binding as an environment variable', () => {
    for (const name of bindings) {
      expect(
        documented,
        `${name} is a binding and does not belong in .dev.vars.example`,
      ).not.toContain(name);
    }
  });

  it('gives ANON_SALT a placeholder long enough to satisfy the runtime check', () => {
    // A copied example that fails the 16-character floor sends the reader straight into the
    // 500 the file exists to prevent.
    const placeholder = /^ANON_SALT="([^"]*)"/m.exec(exampleSource)?.[1] ?? '';
    expect(placeholder.length).toBeGreaterThanOrEqual(16);
  });
});

describe('TIERS', () => {
  it('increases every ceiling monotonically with the tier', () => {
    expect(TIERS.anonymous.dailyQuota).toBeLessThan(TIERS.registered.dailyQuota);
    expect(TIERS.registered.dailyQuota).toBeLessThan(TIERS.elevated.dailyQuota);
    expect(TIERS.anonymous.burstPerMinute).toBeLessThan(TIERS.registered.burstPerMinute);
    expect(TIERS.registered.burstPerMinute).toBeLessThan(TIERS.elevated.burstPerMinute);
  });

  it('lets anonymous callers actually explore the docs', () => {
    // The docs page is the front door; a decorative anonymous tier defeats it.
    expect(TIERS.anonymous.dailyQuota).toBeGreaterThanOrEqual(100);
  });

  it('does not let anonymous callers spend an upstream eCFR fetch', () => {
    expect(TIERS.anonymous.mayComputeDiff).toBe(false);
    expect(TIERS.registered.mayComputeDiff).toBe(true);
  });
});
