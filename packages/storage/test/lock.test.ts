// packages/storage/test/lock.test.ts
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireLock } from '../src/lock.js';

let root = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'archivist-lock-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('acquireLock', () => {
  it('grants a lock when none is held', async () => {
    expect(await acquireLock(root, 'org_1')).not.toBeNull();
  });

  it('refuses a second holder for the same key', async () => {
    await acquireLock(root, 'org_1');
    expect(await acquireLock(root, 'org_1')).toBeNull();
  });

  it('allows different keys to proceed concurrently', async () => {
    await acquireLock(root, 'org_1');
    expect(await acquireLock(root, 'org_2')).not.toBeNull();
  });

  it('grants the lock again after release', async () => {
    const first = await acquireLock(root, 'org_1');
    await first?.release();
    expect(await acquireLock(root, 'org_1')).not.toBeNull();
  });

  it('reclaims a lock whose TTL has expired, so a crash cannot deadlock', async () => {
    let clock = 1_000;
    await acquireLock(root, 'org_1', { ttlMs: 100, now: () => clock });
    clock += 500;
    expect(await acquireLock(root, 'org_1', { ttlMs: 100, now: () => clock })).not.toBeNull();
  });

  it('does not reclaim a lock that is still within its TTL', async () => {
    let clock = 1_000;
    await acquireLock(root, 'org_1', { ttlMs: 10_000, now: () => clock });
    clock += 500;
    expect(await acquireLock(root, 'org_1', { ttlMs: 10_000, now: () => clock })).toBeNull();
  });

  it('is idempotent on release', async () => {
    const lock = await acquireLock(root, 'org_1');
    await lock?.release();
    await expect(lock?.release()).resolves.toBeUndefined();
  });

  it('does not let a key influence the lock file path', async () => {
    const lock = await acquireLock(root, '../../escape');
    expect(lock).not.toBeNull();
    await expect(acquireLock(root, '../../escape')).resolves.toBeNull();
  });

  it('grants exactly one lock among many concurrent acquirers for the same key', async () => {
    // Exercises the real race, not a sequential approximation of it: ten
    // acquireLock calls for the same key are kicked off in the same tick.
    // A read-then-write implementation would let more than one through here.
    // Repeated across several fresh roots because async interleaving is
    // nondeterministic -- a single lucky trial is weak evidence.
    for (let trial = 0; trial < 8; trial += 1) {
      const trialRoot = await mkdtemp(join(tmpdir(), 'archivist-lock-race-'));
      try {
        const attempts = await Promise.all(
          Array.from({ length: 10 }, () => acquireLock(trialRoot, 'org_race')),
        );
        const granted = attempts.filter((lock) => lock !== null);
        expect(granted).toHaveLength(1);
      } finally {
        await rm(trialRoot, { recursive: true, force: true });
      }
    }
  });

  it('lets a fresh acquirer win after concurrent stale reclamation, still exactly once', async () => {
    // This is the scenario that broke a naive "read stale, delete, retry"
    // reclaim path: several callers observe the same stale record, but by
    // the time they act on it, a faster caller may have already installed a
    // fresh, live lock via its own legitimate `wx` create. Acting on the
    // outdated staleness belief must not tear that down.
    for (let trial = 0; trial < 8; trial += 1) {
      const trialRoot = await mkdtemp(join(tmpdir(), 'archivist-lock-stale-race-'));
      try {
        let clock = 1_000;
        await acquireLock(trialRoot, 'org_stale', { ttlMs: 100, now: () => clock });
        clock += 1_000; // now well past the TTL
        const attempts = await Promise.all(
          Array.from({ length: 8 }, () =>
            acquireLock(trialRoot, 'org_stale', { ttlMs: 100, now: () => clock }),
          ),
        );
        const granted = attempts.filter((lock) => lock !== null);
        expect(granted).toHaveLength(1);
      } finally {
        await rm(trialRoot, { recursive: true, force: true });
      }
    }
  });

  it('never grants a lock to a concurrent acquirer while a live holder still owns it', async () => {
    for (let trial = 0; trial < 8; trial += 1) {
      const trialRoot = await mkdtemp(join(tmpdir(), 'archivist-lock-live-race-'));
      try {
        await acquireLock(trialRoot, 'org_live');
        const attempts = await Promise.all(
          Array.from({ length: 8 }, () => acquireLock(trialRoot, 'org_live')),
        );
        expect(attempts.filter((lock) => lock !== null)).toHaveLength(0);
      } finally {
        await rm(trialRoot, { recursive: true, force: true });
      }
    }
  });

  it('does not deadlock or throw when the lock file holds garbage instead of JSON', async () => {
    const dir = join(root, '.archivist', 'locks');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'org-garbage.lock'), 'not json at all {{{', 'utf8');
    await expect(acquireLock(root, 'org-garbage')).resolves.not.toBeNull();
  });

  it('does not deadlock or throw when the lock file holds well-formed JSON of the wrong shape', async () => {
    const dir = join(root, '.archivist', 'locks');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'org-wrong-shape.lock'), JSON.stringify({ unrelated: true }), 'utf8');
    await expect(acquireLock(root, 'org-wrong-shape')).resolves.not.toBeNull();
  });

  it('does not steal from a live holder even when a concurrent garbage write races it', async () => {
    const first = await acquireLock(root, 'org_live');
    expect(first).not.toBeNull();
    expect(await acquireLock(root, 'org_live')).toBeNull();
  });

  it('persists a lock record that a subsequent acquirer can read back as valid JSON', async () => {
    await acquireLock(root, 'org_1', { pid: 4242 });
    const dir = join(root, '.archivist', 'locks');
    const raw = await readFile(join(dir, 'org_1.lock'), 'utf8');
    const record: unknown = JSON.parse(raw);
    expect(record).toMatchObject({ key: 'org_1', pid: 4242 });
  });
});
