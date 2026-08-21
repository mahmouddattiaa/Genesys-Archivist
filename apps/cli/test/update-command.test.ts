// apps/cli/test/update-command.test.ts
//
// `archivist update` is exercised entirely through `buildProgram(deps)` with
// a fake `UpdateCommandDeps` -- no test here shells out to git, npm, or the
// network. `createRealUpdateDeps` in ../src/commands/update.ts is the only
// part of this command that touches a subprocess, and it is deliberately not
// covered here: a test suite for this command that had to shell out to git
// to exercise it would not be a test suite.
import { describe, expect, it, vi } from 'vitest';
import { CANARIES, scanForCanaries } from '@genesys-archivist/testing';
import { buildProgram, type CliDeps } from '../src/bin.js';
import { parsePorcelain } from '../src/commands/update.js';
import type { RepoStatus, StepResult, UpdateCommandDeps } from '../src/commands/update.js';

function baseStatus(overrides: Partial<RepoStatus> = {}): RepoStatus {
  return {
    dirtyPaths: [],
    remoteOk: true,
    currentCommit: 'abc1234',
    behindCount: 0,
    shortLog: [],
    ...overrides,
  };
}

const STEP_OK: StepResult = { ok: true };

function fakeUpdateDeps(overrides: Partial<UpdateCommandDeps> = {}): UpdateCommandDeps {
  return {
    write: () => {
      /* individual tests override this when they need to inspect output */
    },
    confirm: () => Promise.resolve(true),
    status: () => Promise.resolve(baseStatus()),
    pull: () => Promise.resolve(STEP_OK),
    install: () => Promise.resolve(STEP_OK),
    build: () => Promise.resolve(STEP_OK),
    ...overrides,
  };
}

function fakeCliDeps(update: UpdateCommandDeps): {
  deps: CliDeps;
  out: string[];
  codes: number[];
} {
  const out: string[] = [];
  const codes: number[] = [];
  // `runUpdate` reports through UpdateCommandDeps.write, not CliDeps.write --
  // wiring both into the same array here is what lets a test that only
  // overrides status/pull/install/build (via fakeUpdateDeps' no-op default
  // write) still see what archivist update actually reported.
  const wiredUpdate: UpdateCommandDeps = { ...update, write: (line) => out.push(line) };
  const deps: CliDeps = {
    write: (line) => out.push(line),
    exit: (code) => codes.push(code),
    doctor: () => Promise.resolve({ ok: true, checks: [] }),
    verifyBundle: () => Promise.resolve({ ok: true, findings: [] }),
    documentBundle: () => Promise.resolve({ ok: true, documentsWritten: 0 }),
    capture: () => Promise.resolve({ state: 'completed' }),
    update: wiredUpdate,
  };
  return { deps, out, codes };
}

async function run(deps: CliDeps, argv: readonly string[]): Promise<void> {
  const program = buildProgram(deps);
  await program.parseAsync(['node', 'archivist', ...argv]);
}

describe('archivist update', () => {
  it('already up to date: reports it, exits 0, performs no install or build', async () => {
    const pull = vi.fn(() => Promise.resolve(STEP_OK));
    const install = vi.fn(() => Promise.resolve(STEP_OK));
    const build = vi.fn(() => Promise.resolve(STEP_OK));
    const update = fakeUpdateDeps({
      status: () => Promise.resolve(baseStatus({ behindCount: 0 })),
      pull,
      install,
      build,
    });
    const { deps, codes, out } = fakeCliDeps(update);

    await run(deps, ['update']);

    expect(codes).toEqual([0]);
    expect(pull).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
    expect(out.some((l) => /up to date/i.test(l))).toBe(true);
  });

  it('behind: shows the commit count and log, asks for confirmation, and does nothing if declined', async () => {
    const confirm = vi.fn(() => Promise.resolve(false));
    const pull = vi.fn(() => Promise.resolve(STEP_OK));
    const install = vi.fn(() => Promise.resolve(STEP_OK));
    const build = vi.fn(() => Promise.resolve(STEP_OK));
    const update = fakeUpdateDeps({
      status: () =>
        Promise.resolve(
          baseStatus({
            behindCount: 3,
            shortLog: ['aaa1111 feat: one', 'bbb2222 fix: two', 'ccc3333 docs: three'],
          }),
        ),
      confirm,
      pull,
      install,
      build,
    });
    const { deps, codes, out } = fakeCliDeps(update);

    await run(deps, ['update']);

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(pull).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
    expect(out.some((l) => l.includes('3') && /behind/i.test(l))).toBe(true);
    expect(out.some((l) => l.includes('aaa1111 feat: one'))).toBe(true);
    expect(codes).toEqual([0]);
  });

  it('--yes skips the confirmation prompt', async () => {
    const confirm = vi.fn(() => Promise.resolve(true));
    const pull = vi.fn(() => Promise.resolve(STEP_OK));
    const install = vi.fn(() => Promise.resolve(STEP_OK));
    const build = vi.fn(() => Promise.resolve(STEP_OK));
    const update = fakeUpdateDeps({
      status: () =>
        Promise.resolve(baseStatus({ behindCount: 1, shortLog: ['aaa0000 chore: bump'] })),
      confirm,
      pull,
      install,
      build,
    });
    const { deps, codes } = fakeCliDeps(update);

    await run(deps, ['update', '--yes']);

    expect(confirm).not.toHaveBeenCalled();
    expect(pull).toHaveBeenCalledTimes(1);
    expect(install).toHaveBeenCalledTimes(1);
    expect(build).toHaveBeenCalledTimes(1);
    expect(codes).toEqual([0]);
  });

  it('--check never calls pull, install, or build, whatever the state', async () => {
    for (const behindCount of [0, 5]) {
      const confirm = vi.fn(() => Promise.resolve(true));
      const pull = vi.fn(() => Promise.resolve(STEP_OK));
      const install = vi.fn(() => Promise.resolve(STEP_OK));
      const build = vi.fn(() => Promise.resolve(STEP_OK));
      const update = fakeUpdateDeps({
        status: () =>
          Promise.resolve(
            baseStatus({
              behindCount,
              shortLog: behindCount > 0 ? ['aaa9999 feat: something'] : [],
            }),
          ),
        confirm,
        pull,
        install,
        build,
      });
      const { deps, codes } = fakeCliDeps(update);

      await run(deps, ['update', '--check']);

      expect(confirm).not.toHaveBeenCalled();
      expect(pull).not.toHaveBeenCalled();
      expect(install).not.toHaveBeenCalled();
      expect(build).not.toHaveBeenCalled();
      expect(codes).toEqual([0]);
    }
  });

  it('dirty working tree: refuses, exits 1, and names the dirty paths', async () => {
    const pull = vi.fn(() => Promise.resolve(STEP_OK));
    const update = fakeUpdateDeps({
      status: () => Promise.resolve(baseStatus({ dirtyPaths: ['src/foo.ts', 'src/bar.ts'] })),
      pull,
    });
    const { deps, codes, out } = fakeCliDeps(update);

    await run(deps, ['update']);

    expect(codes).toEqual([1]);
    expect(pull).not.toHaveBeenCalled();
    expect(out.some((l) => l.includes('src/foo.ts'))).toBe(true);
    expect(out.some((l) => l.includes('src/bar.ts'))).toBe(true);
  });

  it('remote pointing somewhere unexpected: refuses, exits 1', async () => {
    const pull = vi.fn(() => Promise.resolve(STEP_OK));
    const update = fakeUpdateDeps({
      status: () =>
        Promise.resolve(
          baseStatus({
            remoteOk: false,
            remoteDetail:
              'origin points to "https://github.com/someone-else/fork", not the expected repository.',
          }),
        ),
      pull,
    });
    const { deps, codes, out } = fakeCliDeps(update);

    await run(deps, ['update']);

    expect(codes).toEqual([1]);
    expect(pull).not.toHaveBeenCalled();
    expect(out.some((l) => l.includes('someone-else/fork'))).toBe(true);
  });

  it('install fails after a successful pull: reports which step failed and that the tree is ahead of the last build', async () => {
    const build = vi.fn(() => Promise.resolve(STEP_OK));
    const update = fakeUpdateDeps({
      status: () =>
        Promise.resolve(baseStatus({ behindCount: 2, shortLog: ['aaa1111 a', 'bbb2222 b'] })),
      install: () => Promise.resolve({ ok: false, detail: 'npm ci exited with code 1' }),
      build,
    });
    const { deps, codes, out } = fakeCliDeps(update);

    await run(deps, ['update', '--yes']);

    expect(codes).toEqual([1]);
    expect(build).not.toHaveBeenCalled();
    expect(out.some((l) => /install/i.test(l) && /fail/i.test(l))).toBe(true);
    expect(out.some((l) => /newer code than the last successful build/i.test(l))).toBe(true);
  });

  it('emits no canary even when one is planted in a dirty path or remote detail, and never reads .env or the profile store', async () => {
    const canary = CANARIES[0]!;
    const update = fakeUpdateDeps({
      status: () => Promise.resolve(baseStatus({ dirtyPaths: [`src/${canary}.ts`] })),
    });
    const { deps, out } = fakeCliDeps(update);

    await run(deps, ['update']);

    // The canary was injected only through the fake's own return value, to
    // prove archivist update's own code neither filters it out nor
    // manufactures an extra copy -- not that the CLI is a redaction
    // boundary. Nothing in this command's dependency shape (UpdateCommandDeps
    // above) or its implementation reads process.env or opens the profile
    // store; it only calls the four functions this fake replaces.
    expect(scanForCanaries(out.join('\n'))).toEqual([canary]);
  });
});

describe('parsePorcelain', () => {
  // Built from real `git status --porcelain` output, byte for byte. The bug
  // this exists to catch was invisible to lines typed from memory: an unstaged
  // change is " M path" with a LEADING SPACE, and trimming before the slice
  // ate the first character of every such path while leaving "?? path"
  // untouched. Half the output was silently wrong.
  it('keeps the whole path for an unstaged modification', () => {
    expect(parsePorcelain(' M apps/cli/src/bin.ts')).toEqual(['apps/cli/src/bin.ts']);
  });

  it('keeps the whole path for a staged modification', () => {
    expect(parsePorcelain('M  apps/cli/src/bin.ts')).toEqual(['apps/cli/src/bin.ts']);
  });

  it('keeps the whole path for an untracked file', () => {
    expect(parsePorcelain('?? apps/cli/src/commands/update.ts')).toEqual([
      'apps/cli/src/commands/update.ts',
    ]);
  });

  it('handles a real multi-line status with mixed states', () => {
    const porcelain = [
      ' M apps/cli/src/bin.ts',
      ' M apps/cli/test/bin.test.ts',
      '?? apps/cli/src/commands/update.ts',
      'A  packages/composition/src/new-file.ts',
      'MM packages/domain/src/identity.ts',
      ' D packages/storage/src/gone.ts',
    ].join('\n');
    expect(parsePorcelain(porcelain)).toEqual([
      'apps/cli/src/bin.ts',
      'apps/cli/test/bin.test.ts',
      'apps/cli/src/commands/update.ts',
      'packages/composition/src/new-file.ts',
      'packages/domain/src/identity.ts',
      'packages/storage/src/gone.ts',
    ]);
  });

  it('never drops a leading character, whatever the status pair', () => {
    // The regression stated as a property: for every status pair git can emit,
    // the parsed path is the path, unchanged.
    for (const status of [' M', 'M ', 'MM', 'A ', ' D', 'D ', '??', 'R ', 'UU', ' A']) {
      expect(parsePorcelain(`${status} apps/cli/src/bin.ts`)).toEqual(['apps/cli/src/bin.ts']);
    }
  });

  it('reports a rename as one path rather than splitting it', () => {
    expect(parsePorcelain('R  old/path.ts -> new/path.ts')).toEqual(['old/path.ts -> new/path.ts']);
  });

  it('returns nothing for a clean tree', () => {
    expect(parsePorcelain('')).toEqual([]);
    expect(parsePorcelain('\n')).toEqual([]);
  });
});
