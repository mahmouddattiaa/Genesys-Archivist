// packages/security/test/paths-real.test.ts
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UntrustedPathError } from '../src/paths.js';
import { resolveWithinRootReal } from '../src/paths-real.js';

let root = '';
let outside = '';

beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), 'archivist-paths-'));
  root = join(base, 'root');
  outside = join(base, 'outside');
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, 'secret.txt'), 'other customer data');
});

afterEach(async () => {
  await rm(join(root, '..'), { recursive: true, force: true });
});

describe('resolveWithinRootReal', () => {
  it('resolves a path that stays inside the root', async () => {
    const p = await resolveWithinRootReal(root, ['flows', 'f1', 'business.md']);
    expect(p).toContain('business.md');
  });

  it('rejects lexical traversal, same as the lexical guard', async () => {
    await expect(resolveWithinRootReal(root, ['..', 'outside'])).rejects.toThrow(
      UntrustedPathError,
    );
  });

  it('rejects a directory symlink that escapes the root', async () => {
    // The lexical check passes here. Only realpath catches it.
    await symlink(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(resolveWithinRootReal(root, ['escape', 'secret.txt'])).rejects.toThrow(
      UntrustedPathError,
    );
  });

  it('allows a symlink that stays inside the root', async () => {
    await mkdir(join(root, 'real'), { recursive: true });
    await symlink(
      join(root, 'real'),
      join(root, 'link'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await expect(resolveWithinRootReal(root, ['link', 'x.md'])).resolves.toContain('x.md');
  });

  it('resolves correctly when the leaf does not exist yet', async () => {
    await expect(resolveWithinRootReal(root, ['not', 'created', 'yet.md'])).resolves.toContain(
      'yet.md',
    );
  });

  it('does not echo the attempted path into the error', async () => {
    await symlink(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(resolveWithinRootReal(root, ['escape', 'secret-customer'])).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('secret-customer') }),
    );
  });
});
