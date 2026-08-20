// packages/storage/test/atomic.test.ts
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStaging, promote, recoverJournal, recoverPendingPromotions } from '../src/atomic.js';

let root = '';
let target = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'archivist-atomic-'));
  target = join(root, 'documentation', 'acme');
  await mkdir(target, { recursive: true });
  await writeFile(join(target, 'business.md'), 'LAST KNOWN GOOD');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('atomic promotion', () => {
  it('promotes staged content into the target', async () => {
    const staging = await createStaging(root, 'run_1');
    await staging.write(['business.md'], 'NEW CONTENT');
    await promote(staging, target);
    expect(await readFile(join(target, 'business.md'), 'utf8')).toBe('NEW CONTENT');
  });

  it('leaves last known good intact when staging is discarded', async () => {
    const staging = await createStaging(root, 'run_2');
    await staging.write(['business.md'], 'HALF WRITTEN');
    await staging.discard();
    expect(await readFile(join(target, 'business.md'), 'utf8')).toBe('LAST KNOWN GOOD');
  });

  it('leaves last known good intact when promotion throws', async () => {
    const staging = await createStaging(root, 'run_3');
    await staging.write(['business.md'], 'NEW CONTENT');
    // Force a genuine promotion failure: an existing *file* sits where the
    // target's parent directory needs to be, so recursive mkdir cannot
    // succeed (ENOTDIR). A merely-missing-but-creatable parent (as in the
    // plan's original fixture) does not actually fail: recursive mkdir
    // creates it happily, so that variant never reached the failure path.
    const blockedParent = join(root, 'blocked-parent');
    await writeFile(blockedParent, 'this is a file, not a directory');
    await expect(promote(staging, join(blockedParent, 'nested', 'target'))).rejects.toThrow();
    expect(await readFile(join(target, 'business.md'), 'utf8')).toBe('LAST KNOWN GOOD');
  });

  it('writes a journal entry before touching the target', async () => {
    const staging = await createStaging(root, 'run_4');
    await staging.write(['business.md'], 'NEW');
    await promote(staging, target);
    const journal = await recoverJournal(root);
    expect(journal.some((a) => a.runId === 'run_4' && a.phase === 'completed')).toBe(true);
  });

  it('reports an interrupted promotion as recoverable', async () => {
    const staging = await createStaging(root, 'run_5');
    await staging.write(['business.md'], 'NEW');
    // Simulate a crash after the journal is written but before promotion runs.
    await staging.markPromoting(target);
    const journal = await recoverJournal(root);
    const pending = journal.find((a) => a.runId === 'run_5');
    expect(pending?.phase).toBe('promoting');
  });

  it('refuses a target outside the approved root', async () => {
    const staging = await createStaging(root, 'run_6');
    await staging.write(['business.md'], 'NEW');
    await expect(promote(staging, join(root, '..', 'escape'))).rejects.toThrow();
  });

  it('removes the staging directory once promotion succeeds', async () => {
    const staging = await createStaging(root, 'run_7');
    await staging.write(['business.md'], 'NEW');
    const dir = staging.dir;
    await promote(staging, target);
    await expect(readdir(dir)).rejects.toThrow();
  });

  it('rejects a staged path that escapes the staging directory', async () => {
    const staging = await createStaging(root, 'run_8');
    await expect(staging.write(['..', '..', 'escape.md'], 'x')).rejects.toThrow();
  });

  it('rejects a symlink inside staging that escapes the root, not just literal ..', async () => {
    const staging = await createStaging(root, 'run_8b');
    const outside = join(root, '..', 'archivist-atomic-outside');
    await mkdir(outside, { recursive: true });
    try {
      await symlink(
        outside,
        join(staging.dir, 'escape'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      await expect(staging.write(['escape', 'x.md'], 'y')).rejects.toThrow();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('promotes a nested directory tree atomically', async () => {
    const staging = await createStaging(root, 'run_9');
    await staging.write(['flows', 'f1', 'business.md'], 'B1');
    await staging.write(['flows', 'f1', 'technical.md'], 'T1');
    await staging.write(['flows', 'f2', 'business.md'], 'B2');
    await promote(staging, target);
    expect(await readFile(join(target, 'flows', 'f1', 'business.md'), 'utf8')).toBe('B1');
    expect(await readFile(join(target, 'flows', 'f1', 'technical.md'), 'utf8')).toBe('T1');
    expect(await readFile(join(target, 'flows', 'f2', 'business.md'), 'utf8')).toBe('B2');
  });

  it('promotes into a target that does not exist yet, with nothing to archive', async () => {
    const freshTarget = join(root, 'documentation', 'brand-new-org');
    const staging = await createStaging(root, 'run_10');
    await staging.write(['business.md'], 'FIRST RUN');
    const result = await promote(staging, freshTarget);
    expect(result.previousArchived).toBe(false);
    expect(await readFile(join(freshTarget, 'business.md'), 'utf8')).toBe('FIRST RUN');
    const siblings = await readdir(dirname(freshTarget));
    expect(siblings.some((s) => s.includes('.previous-'))).toBe(false);
  });

  it('restores last known good after a crash between the two renames of promotion, and recovery is idempotent', async () => {
    const staging = await createStaging(root, 'run_11');
    await staging.write(['business.md'], 'NEW CONTENT');
    await staging.markPromoting(target);
    // Simulate the crash point: the old target has been archived, but the
    // staged content has not yet been swapped in. `target` must not exist
    // at all here -- a reader must never see a half-written directory.
    const previous = `${target}.previous-run_11`;
    await rename(target, previous);
    await expect(stat(target)).rejects.toThrow();

    const actions = await recoverPendingPromotions(root);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.runId).toBe('run_11');
    expect(actions[0]?.phase).toBe('rolled_back');
    expect(await readFile(join(target, 'business.md'), 'utf8')).toBe('LAST KNOWN GOOD');
    await expect(stat(previous)).rejects.toThrow();

    const second = await recoverPendingPromotions(root);
    expect(second).toHaveLength(0);
    expect(await readFile(join(target, 'business.md'), 'utf8')).toBe('LAST KNOWN GOOD');
  });

  it('finishes cleanup when a crash happens after content is live but before journal completion, and recovery is idempotent', async () => {
    const staging = await createStaging(root, 'run_12');
    await staging.write(['business.md'], 'NEW CONTENT');
    await staging.markPromoting(target);
    const previous = `${target}.previous-run_12`;
    await rename(target, previous);
    await rename(staging.dir, target);
    // Crash here: the new content is already live, but the journal never
    // recorded 'completed' and the archived copy was never cleaned up.

    const actions = await recoverPendingPromotions(root);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.runId).toBe('run_12');
    expect(actions[0]?.phase).toBe('completed');
    expect(await readFile(join(target, 'business.md'), 'utf8')).toBe('NEW CONTENT');
    await expect(stat(previous)).rejects.toThrow();

    const second = await recoverPendingPromotions(root);
    expect(second).toHaveLength(0);
    expect(await readFile(join(target, 'business.md'), 'utf8')).toBe('NEW CONTENT');
  });

  it('skips an unparseable journal line instead of throwing', async () => {
    const staging = await createStaging(root, 'run_13');
    await staging.write(['business.md'], 'X');
    await promote(staging, target);
    // Simulate a crash mid-write of the final journal line: truncated JSON,
    // no trailing newline.
    const path = join(root, '.archivist', 'journal.ndjson');
    await appendFile(path, '{"runId":"run_14","phase":"promo', 'utf8');

    await expect(recoverJournal(root)).resolves.not.toThrow();
    const journal = await recoverJournal(root);
    expect(journal.some((a) => a.runId === 'run_13' && a.phase === 'completed')).toBe(true);
    expect(journal.some((a) => a.runId === 'run_14')).toBe(false);
  });
});
