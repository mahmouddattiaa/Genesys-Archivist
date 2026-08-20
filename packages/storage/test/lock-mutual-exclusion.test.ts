import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireLock } from '../src/lock.js';

/**
 * An independent mutual-exclusion probe, written without reading the lock
 * implementation.
 *
 * The property under test is the only one that matters and the only one a
 * single-threaded test cannot show: **at no instant may two callers hold the
 * same key.** A lock that grants twice does not fail loudly — it corrupts the
 * output directory quietly, while every sequential test still passes.
 *
 * Concurrency bugs are probabilistic, so each scenario runs many trials. A
 * single green run of a racy lock proves nothing.
 */
let root = '';
const TRIALS = 25;
const CALLERS = 12;

/**
 * These do 300 real filesystem lock acquisitions apiece. Vitest's 5s default
 * is not a meaningful assertion about them — it just makes the suite fail
 * whenever this file happens to run alongside something heavy (the Playwright
 * browser launch, for instance). A timeout should catch a hang, not lose a
 * race with the scheduler.
 */
const SLOW = 60_000;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'archivist-lockprobe-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('lock mutual exclusion under real concurrency', () => {
  it('grants a contested key to exactly one caller, every trial', { timeout: SLOW }, async () => {
    for (let trial = 0; trial < TRIALS; trial += 1) {
      const key = `contested-${String(trial)}`;
      const results = await Promise.all(
        Array.from({ length: CALLERS }, () => acquireLock(root, key)),
      );
      const granted = results.filter((lock) => lock !== null);
      expect(granted.length, `trial ${String(trial)} granted ${String(granted.length)}`).toBe(1);
      await Promise.all(granted.map((lock) => lock.release()));
    }
  });

  it('never overlaps two holders, measured by a shared counter', { timeout: SLOW }, async () => {
    // Counting grants is not quite enough: a lock could grant once, be
    // released, and be granted again within the same batch. This asserts the
    // stronger property — that the number of simultaneous holders never
    // exceeds one at any moment.
    let held = 0;
    let maxHeld = 0;
    for (let trial = 0; trial < TRIALS; trial += 1) {
      const key = `overlap-${String(trial)}`;
      await Promise.all(
        Array.from({ length: CALLERS }, async () => {
          const lock = await acquireLock(root, key);
          if (lock === null) return;
          held += 1;
          maxHeld = Math.max(maxHeld, held);
          // Yield, so an overlapping holder would actually be observed.
          await new Promise((resolve) => setImmediate(resolve));
          held -= 1;
          await lock.release();
        }),
      );
    }
    expect(maxHeld).toBe(1);
  });

  it('reclaims a stale lock for exactly one caller', { timeout: SLOW }, async () => {
    for (let trial = 0; trial < TRIALS; trial += 1) {
      const key = `stale-${String(trial)}`;
      let clock = 1_000_000;
      const first = await acquireLock(root, key, { ttlMs: 10, now: () => clock });
      expect(first).not.toBeNull();

      // Time moves past the TTL without the holder releasing: the classic
      // crashed-process case the reclaim path exists for.
      clock += 10_000;
      const contenders = await Promise.all(
        Array.from({ length: CALLERS }, () =>
          acquireLock(root, key, { ttlMs: 10, now: () => clock }),
        ),
      );
      const granted = contenders.filter((lock) => lock !== null);
      expect(granted.length, `stale trial ${String(trial)}`).toBe(1);
      await Promise.all(granted.map((lock) => lock.release()));
    }
  });

  it('refuses every contender while a live holder has not expired', { timeout: SLOW }, async () => {
    for (let trial = 0; trial < TRIALS; trial += 1) {
      const key = `live-${String(trial)}`;
      const clock = 2_000_000;
      const holder = await acquireLock(root, key, { ttlMs: 60_000, now: () => clock });
      expect(holder).not.toBeNull();
      const contenders = await Promise.all(
        Array.from({ length: CALLERS }, () =>
          acquireLock(root, key, { ttlMs: 60_000, now: () => clock }),
        ),
      );
      expect(contenders.every((lock) => lock === null)).toBe(true);
      await holder?.release();
    }
  });

  it('keeps distinct keys independent', async () => {
    const locks = await Promise.all(
      Array.from({ length: CALLERS }, (_unused, i) => acquireLock(root, `key-${String(i)}`)),
    );
    expect(locks.every((lock) => lock !== null)).toBe(true);
    await Promise.all(locks.filter((lock) => lock !== null).map((lock) => lock.release()));
  });
});
