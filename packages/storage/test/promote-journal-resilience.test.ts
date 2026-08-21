// packages/storage/test/promote-journal-resilience.test.ts
//
// The second cause of "a healthy capture reported as a failed run".
//
// `promote` writes a 'completed' record to the recovery journal as its last
// act -- *after* the rename that makes this run's content live. Opening that
// journal file was measured failing with EPERM under load, from the same
// momentary external handle that makes the renames fail. Because the append
// was unguarded, a promotion that had entirely succeeded was reported to the
// caller as a thrown error, and `run-store.save` turned that into a run whose
// status was `failed` while its documents sat correctly promoted on disk.
//
// Swallowing that failure is safe, and this file pins the reason down rather
// than trusting it: recovery does not need the record. With the last phase
// left at 'promoting', `reconcilePendingPromotion` finds staging gone --
// the rename consumed it -- takes its "the rename already succeeded" branch,
// and writes the 'completed' entry itself. The cost is a deferred cleanup,
// never a rollback of live content.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const gate = vi.hoisted(() => ({
  failCompleted: false,
  transientFailures: 0,
  appendAttempts: 0,
}));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    appendFile: async (path: unknown, data: unknown, encoding: unknown): Promise<void> => {
      gate.appendAttempts += 1;
      const text = typeof data === 'string' ? data : '';
      const isCompleted = text.includes('"phase":"completed"');
      const shouldFail =
        (gate.failCompleted && isCompleted) ||
        (gate.transientFailures > 0 && (gate.transientFailures -= 1) >= 0);
      if (shouldFail) {
        const error = new Error('EPERM: operation not permitted, open') as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      }
      await actual.appendFile(
        path as string,
        data as string,
        encoding as BufferEncoding | undefined,
      );
    },
  };
});

const { createStaging, promote, recoverJournal } = await import('../src/atomic.js');

let root = '';
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'archivist-journal-resilience-'));
  gate.failCompleted = false;
  gate.transientFailures = 0;
  gate.appendAttempts = 0;
});
afterEach(async () => {
  vi.clearAllMocks();
  await rm(root, { recursive: true, force: true });
});

async function stageOneFile(runId: string, contents: string) {
  const staging = await createStaging(root, runId);
  await staging.write(['technical.md'], contents);
  return staging;
}

describe('promote: journal failures after the commit point', () => {
  it('still reports success, and leaves the content live, when the completed record cannot be written', async () => {
    const target = join(root, 'documents');
    const staging = await stageOneFile('run-1', 'promoted content');

    gate.failCompleted = true;
    const result = await promote(staging, target);

    expect(result.target).toBe(target);
    // The whole point: the content is live even though the bookkeeping failed.
    expect(await readFile(join(target, 'technical.md'), 'utf8')).toBe('promoted content');
  });

  it('leaves a journal that recovery resolves forward, never by rolling back live content', async () => {
    const target = join(root, 'documents');
    const staging = await stageOneFile('run-1', 'promoted content');
    gate.failCompleted = true;
    await promote(staging, target);

    const entries = await recoverJournal(root);
    const last = entries.filter((e) => e.runId === 'run-1').at(-1);
    // 'promoting', not 'completed' -- and that is the state recovery handles
    // by finishing the promotion, because staging no longer exists.
    expect(last?.phase).toBe('promoting');
    expect(await readFile(join(target, 'technical.md'), 'utf8')).toBe('promoted content');
  });

  it('retries a transient append failure rather than giving up on the first one', async () => {
    const target = join(root, 'documents');
    const staging = await stageOneFile('run-1', 'promoted content');

    gate.transientFailures = 3;
    const before = gate.appendAttempts;
    await promote(staging, target);

    expect(gate.appendAttempts).toBeGreaterThan(before + 3);
    expect(await readFile(join(target, 'technical.md'), 'utf8')).toBe('promoted content');
  });
});
