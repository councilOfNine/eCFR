import { describe, expect, it } from 'vitest';

import { DEFAULT_MAX_RPS, loadConfig, parseRate } from './config.js';

describe('ECFR_MAX_RPS', () => {
  it('defaults to the measured clean ceiling', () => {
    expect(parseRate(undefined, DEFAULT_MAX_RPS)).toBe(8);
    expect(DEFAULT_MAX_RPS).toBe(8);
  });

  it('is actually read, not merely documented', () => {
    // CI has set ECFR_MAX_RPS=8 since the workflow was written and nothing consumed it, so the
    // documented ceiling was whatever the client happened to default to.
    const before = process.env.ECFR_MAX_RPS;
    try {
      process.env.ECFR_MAX_RPS = '3';
      expect(loadConfig([]).maxRps).toBe(3);
    } finally {
      if (before === undefined) delete process.env.ECFR_MAX_RPS;
      else process.env.ECFR_MAX_RPS = before;
    }
  });

  it('refuses a value that would silently disable pacing', () => {
    // `Number('')` is 0 and `Number('eight')` is NaN. Either reaching the governor is worse
    // than a startup failure: one throws deep inside a fetch, the other reads as "no limit".
    for (const bad of ['0', '-1', 'eight', 'NaN', 'Infinity']) {
      expect(() => parseRate(bad, DEFAULT_MAX_RPS), bad).toThrow(/ECFR_MAX_RPS/);
    }
  });

  it('accepts a fractional rate, because throttling below 1 req/s is a real operator need', () => {
    expect(parseRate('0.5', DEFAULT_MAX_RPS)).toBe(0.5);
  });
});

describe('snapshot directory', () => {
  it('is configurable with the same env var the web build reads', () => {
    const before = process.env.ECFR_SNAPSHOT_DIR;
    try {
      process.env.ECFR_SNAPSHOT_DIR = '/tmp/ecfr-snapshot-test';
      expect(loadConfig([]).snapshotDir).toBe('/tmp/ecfr-snapshot-test');
    } finally {
      if (before === undefined) delete process.env.ECFR_SNAPSHOT_DIR;
      else process.env.ECFR_SNAPSHOT_DIR = before;
    }
  });
});
