/**
 * Hold a sleep assertion for the life of this process (macOS only).
 *
 * A backfill is a multi-hour unattended local run, and macOS Deep Idle freezes the process
 * for minutes at a stretch: run 5 died when the first R2 PUT transmitted after a freeze
 * carried an x-amz-date stale enough for R2 to reject the signature
 * (403 RequestTimeTooSkewed). Correct operation cannot depend on the operator remembering
 * to prefix `caffeinate`, so the entries take the assertion themselves.
 *
 * `caffeinate -i -s -w <pid>` blocks idle sleep (and system sleep on AC power) until the
 * watched pid exits, then exits itself — a crash can never leave the machine unable to
 * sleep. On non-darwin platforms (CI is Linux) there is no caffeinate and nothing to do.
 */

import { spawn } from 'node:child_process';

import type { Logger } from './log.js';

export function keepAwakeWhileRunning(log: Logger): void {
  if (process.platform !== 'darwin') return;
  const child = spawn('caffeinate', ['-i', '-s', '-w', String(process.pid)], {
    stdio: 'ignore',
    detached: true,
  });
  child.on('spawn', () => {
    log.info('sleep assertion held for the duration of the run', { via: 'caffeinate' });
  });
  child.on('error', () => {
    log.warn('caffeinate could not start; the machine may sleep mid-run');
  });
  child.unref();
}
