// packages/storage/test/promote-rename-retry.test.ts
//
// Windows fails a rename that POSIX allows, transiently and at random. It was
// measured, not theorised: `promote` renames the live target aside and then
// renames staging into the now-vacant path, and that second rename failed with
// EPERM roughly one run in five. `run-store.save` promotes on every run state
// change, so a single EPERM turned a healthy capture into a run reported as
// `failed` -- which is how this surfaced, as a "flaky test" that was really a
// product defect on the platform this project is developed on.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted: vi.mock's factory runs before the module body, so the counter it
// closes over has to exist by then.
const gate = vi.hoisted(() => ({ failures: 0, code: 'EPERM', consumed: 0 }));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    rename: async (from: string, to: string): Promise<void> => {
      if (gate.failures > 0) {
        gate.failures -= 1;
        gate.consumed += 1;
        const error = new Error(
          `${gate.code}: operation not permitted, rename`,
        ) as NodeJS.ErrnoException;
        error.code = gate.code;
        throw error;
      }
      return actual.rename(from, to);
    },
  };
});

const { createStaging, promote } = await import('../src/atomic.js');

let root = '';

function failNext(count: number, code: string): void {
  gate.failures = count;
  gate.code = code;
  gate.consumed = 0;
}

beforeEach(async () => {
  gate.failures = 0;
  gate.consumed = 0;
  root = await mkdtemp(join(tmpdir(), 'archivist-promote-retry-'));
});
afterEach(async () => {
  gate.failures = 0;
  await rm(root, { recursive: true, force: true });
});

describe('promote: transient rename failures', () => {
  it('promotes over an existing target, which is what a repeated save does', async () => {
    const target = join(root, 'runs', 'run-1');

    const first = await createStaging(root, 'run-a');
    await first.write(['manifest.json'], '{"state":"planned"}');
    await promote(first, target);

    // The second promote is the one that failed on Windows: the destination
    // already exists, so promote must move it aside and then rename into a
    // path the OS was touching a millisecond earlier.
    const second = await createStaging(root, 'run-b');
    await second.write(['manifest.json'], '{"state":"completed"}');
    await promote(second, target);

    expect(JSON.parse(await readFile(join(target, 'manifest.json'), 'utf8'))).toEqual({
      state: 'completed',
    });
  });

  it.each(['EPERM', 'EACCES', 'EBUSY'])('retries through a transient %s', async (code) => {
    const target = join(root, 'runs', 'run-1');
    const staging = await createStaging(root, 'run-a');
    await staging.write(['manifest.json'], '{"ok":true}');

    failNext(2, code);
    await promote(staging, target);

    expect(JSON.parse(await readFile(join(target, 'manifest.json'), 'utf8'))).toEqual({ ok: true });
    expect(gate.consumed).toBe(2);
  });

  // Exhausts the entire retry schedule on purpose, twice over -- `promote`
  // makes two rename calls. The schedule is deliberately longer than vitest's
  // 5s default, so an explicit timeout is required here: it should catch a
  // hang, not stopwatch a backoff the product intends to spend.
  it('still surfaces a rename failure that never clears', { timeout: 60_000 }, async () => {
    // Bounded, so a genuine permission problem is reported rather than spun on.
    const target = join(root, 'runs', 'run-1');
    const staging = await createStaging(root, 'run-a');
    await staging.write(['manifest.json'], '{"ok":true}');

    failNext(99, 'EPERM');
    await expect(promote(staging, target)).rejects.toThrow(/EPERM/);
  });

  it('does not retry a failure that is not transient', async () => {
    const target = join(root, 'runs', 'run-1');
    const staging = await createStaging(root, 'run-a');
    await staging.write(['manifest.json'], '{"ok":true}');

    failNext(20, 'EINVAL');
    await expect(promote(staging, target)).rejects.toThrow(/EINVAL/);
    // promote makes two distinct rename calls -- moving any existing target
    // aside, then moving staging in -- so two consumed attempts means each was
    // tried exactly once and neither retried. A retried EINVAL would have
    // burned the whole schedule per call. The point is that a code which will
    // never clear surfaces immediately instead of paying any backoff at all.
    expect(gate.consumed).toBeLessThanOrEqual(2);
  });

  // Also exhausts the full schedule -- see the note above.
  it(
    'leaves the previous content intact when promotion cannot complete',
    { timeout: 60_000 },
    async () => {
      // The release gate: a failed run never destroys last known-good output.
      const target = join(root, 'runs', 'run-1');
      const first = await createStaging(root, 'run-a');
      await first.write(['manifest.json'], '{"generation":1}');
      await promote(first, target);

      const second = await createStaging(root, 'run-b');
      await second.write(['manifest.json'], '{"generation":2}');
      failNext(99, 'EPERM');
      await expect(promote(second, target)).rejects.toThrow();
      gate.failures = 0;

      expect(JSON.parse(await readFile(join(target, 'manifest.json'), 'utf8'))).toEqual({
        generation: 1,
      });
    },
  );
});
