// packages/storage/test/lock-partial-write.test.ts
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { safeSegment } from '@genesys-archivist/security';
import { acquireLock } from '../src/lock.js';

/**
 * The invariant underneath mutual exclusion: a lock file, once visible, is
 * complete.
 *
 * `lock-mutual-exclusion.test.ts` asserts the property that actually matters
 * -- two callers never hold one key -- but it can only catch a violation when
 * the race happens to land, which was measured at roughly one contested trial
 * in 1,800. That is far too rare to fail reliably in a suite run, and it is
 * why this defect read as "a flaky test" for as long as it did.
 *
 * This asserts the mechanical precondition instead, which reproduces in
 * thousands of iterations rather than thousands of *contended* trials: while
 * `acquireLock` is creating a lock file, no other caller may observe that file
 * in a partially written state. When it could, `readLockRecord` returned null
 * for a perfectly live holder, the reclaim path read null as "stale", and
 * deleted a lock somebody was still holding.
 */
let root = '';
// 600 iterations x 4 readers is ~2,400 observations. Against the unfixed
// write that yielded roughly 120 incomplete reads, so the margin over the
// zero this asserts is two orders of magnitude -- ample, and a third of the
// wall-clock 1,500 iterations cost the suite.
const ITERATIONS = 600;
const READERS = 4;
const SLOW = 60_000;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'archivist-lockpartial-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('lock file visibility', () => {
  it('never exposes a partially written lock file to a contender', { timeout: SLOW }, async () => {
    let observed = 0;
    let unreadable = 0;

    for (let i = 0; i < ITERATIONS; i += 1) {
      const key = `partial-${String(i)}`;
      const path = join(root, '.archivist', 'locks', `${safeSegment(key)}.lock`);

      let settled = false;
      const acquire = acquireLock(root, key).then((lock) => {
        settled = true;
        return lock;
      });

      // Readers modelling a contender that lost the exclusive create and is
      // about to decide whether the existing holder is stale.
      //
      // Each one spins until the file appears rather than reading once: a
      // single read almost always lands before `acquireLock` has even
      // finished its `mkdir`, sees ENOENT, and observes nothing at all. A
      // reader that never looks at the file cannot witness the defect, and
      // an earlier version of this test passed against known-broken code
      // for exactly that reason. `observed` is asserted below so that can
      // never silently happen again.
      const readers = Array.from({ length: READERS }, async () => {
        let raw: string | null = null;
        while (raw === null && !settled) {
          try {
            raw = await readFile(path, 'utf8');
          } catch {
            await new Promise((resolve) => setImmediate(resolve));
          }
        }
        if (raw === null) return;
        observed += 1;
        try {
          const parsed: unknown = JSON.parse(raw);
          if (
            typeof parsed !== 'object' ||
            parsed === null ||
            typeof (parsed as Record<string, unknown>)['acquiredAt'] !== 'number'
          ) {
            unreadable += 1;
          }
        } catch {
          // Present but not parseable: exactly the state that made a live
          // holder look stale.
          unreadable += 1;
        }
      });

      const [granted] = await Promise.all([acquire, Promise.all(readers)]);
      await granted?.release();
    }

    // Guards against the vacuous pass described above: if the readers never
    // managed to look at a lock file, `unreadable === 0` means nothing.
    expect(observed, 'the readers never observed a lock file at all').toBeGreaterThan(0);
    expect(
      unreadable,
      `${String(unreadable)} of ${String(observed)} observed lock files were incomplete`,
    ).toBe(0);
  });
});
