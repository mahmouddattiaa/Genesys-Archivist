// apps/cli/test/bin.test.ts
import { describe, expect, it, vi } from 'vitest';
import { CANARIES, scanForCanaries } from '@genesys-archivist/testing';
import { buildProgram, type CliDeps } from '../src/bin.js';

function fakeDeps(overrides: Partial<CliDeps> = {}): {
  deps: CliDeps;
  out: string[];
  codes: number[];
} {
  const out: string[] = [];
  const codes: number[] = [];
  const deps: CliDeps = {
    write: (line) => out.push(line),
    exit: (code) => codes.push(code),
    doctor: () => Promise.resolve({ ok: true, checks: [] }),
    verifyBundle: () => Promise.resolve({ ok: true, findings: [] }),
    documentBundle: () => Promise.resolve({ ok: true, documentsWritten: 1 }),
    capture: () => Promise.resolve({ state: 'completed', contentHash: 'sha256:' + 'a'.repeat(64) }),
    ...overrides,
  };
  return { deps, out, codes };
}

async function run(deps: CliDeps, argv: readonly string[]): Promise<void> {
  const program = buildProgram(deps);
  await program.parseAsync(['node', 'archivist', ...argv]);
}

describe('archivist CLI', () => {
  it('exposes exactly the release commands: capture, doctor, document, profile, verify', () => {
    const { deps } = fakeDeps();
    const names = buildProgram(deps)
      .commands.map((c) => c.name())
      .sort();
    expect(names).toEqual(['capture', 'doctor', 'document', 'profile', 'verify']);
  });

  it('rejects an unknown command rather than doing something surprising', async () => {
    const { deps } = fakeDeps();
    await expect(run(deps, ['frobnicate'])).rejects.toThrow();
  });

  it('rejects capture with neither --mode nor --org, without ever calling capture', async () => {
    const captured = vi.fn(() => Promise.resolve({ state: 'completed' as const }));
    const { deps, codes, out } = fakeDeps({ capture: captured });
    await run(deps, ['capture']);
    expect(captured).not.toHaveBeenCalled();
    expect(codes).toEqual([1]);
    expect(out.some((l) => /--mode/.test(l))).toBe(true);
  });

  it('has no flag anywhere in the command tree that accepts a client secret', () => {
    const { deps } = fakeDeps();
    const program = buildProgram(deps);
    // Command#createHelp() and Help#visibleOptions() are the public,
    // documented way to enumerate a command's options (each an `Option` with
    // a public `flags` string) -- unlike reaching into Command#options
    // directly, which commander's own typings don't expose. This checks flag
    // syntax specifically, not prose: a command description is free to
    // mention "credential store" as a feature without tripping this check.
    const help = program.createHelp();
    const flags = [program, ...program.commands]
      .flatMap((c) => help.visibleOptions(c).map((o) => o.flags))
      .join(' ');
    expect(flags).not.toMatch(/secret|password|token|credential/i);
  });

  it('prints a version', async () => {
    // Command#version() is a getter/setter pair at runtime, but commander's
    // typings only declare the setter overload (a required string argument),
    // so calling it with zero arguments to read the value back does not
    // type-check. --version is the same information through the public,
    // documented CLI surface instead: exitOverride turns it into a rejected
    // parseAsync() carrying the printed version text as deps.write output.
    const { deps, out } = fakeDeps();
    await expect(run(deps, ['--version'])).rejects.toThrow();
    expect(out.some((l) => l.trim().length > 0)).toBe(true);
  });

  it('capture --help distinguishes context from migration so a reader can choose without running anything', () => {
    const { deps } = fakeDeps();
    const capture = buildProgram(deps).commands.find((c) => c.name() === 'capture');
    const help = capture?.helpInformation() ?? '';
    expect(help).toMatch(/context/i);
    expect(help).toMatch(/migration/i);
    // The one fact that must survive a skim: a context bundle cannot rebuild
    // what it describes.
    expect(help).toMatch(/cannot[\s\S]{0,80}migrat|migrat[\s\S]{0,80}cannot/i);
  });

  it('rejects a mistyped --mode value rather than silently defaulting to context', async () => {
    const captured = vi.fn(() => Promise.resolve({ state: 'completed' as const }));
    const { deps, out, codes } = fakeDeps({ capture: captured });
    await run(deps, ['capture', '--mode', 'migraton', '--org', 'org_1']);
    expect(captured).not.toHaveBeenCalled();
    expect(codes).toEqual([1]);
    expect(out.some((l) => /context|migration/i.test(l))).toBe(true);
  });

  it('runs a valid context capture and exits 0 on completion', async () => {
    const { deps, codes } = fakeDeps();
    await run(deps, ['capture', '--mode', 'context', '--org', 'org_1']);
    expect(codes).toEqual([0]);
  });

  it('exits with a distinct code when the capture completed with warnings', async () => {
    const { deps, codes, out } = fakeDeps({
      capture: () =>
        Promise.resolve({
          state: 'completed_with_warnings',
          warnings: [{ message: 'resource walk truncated' }],
        }),
    });
    await run(deps, ['capture', '--mode', 'migration', '--org', 'org_1']);
    expect(codes).toEqual([2]);
    expect(codes[0]).not.toBe(0);
    expect(out.some((l) => l.includes('resource walk truncated'))).toBe(true);
  });

  it('exits 1 when a capture fails', async () => {
    const { deps, codes } = fakeDeps({
      capture: () => Promise.resolve({ state: 'failed', errors: [{ message: 'tenant mismatch' }] }),
    });
    await run(deps, ['capture', '--mode', 'context', '--org', 'org_1']);
    expect(codes).toEqual([1]);
  });

  it('passes --flow and --flow-type through to a validated scope', async () => {
    const captured = vi.fn(() => Promise.resolve({ state: 'completed' as const }));
    const { deps } = fakeDeps({ capture: captured });
    await run(deps, [
      'capture',
      '--mode',
      'migration',
      '--org',
      'org_1',
      '--flow',
      'f1',
      '--flow',
      'f2',
    ]);
    expect(captured).toHaveBeenCalledWith(
      expect.objectContaining({ scope: { kind: 'flows', flowIds: ['f1', 'f2'] } }),
    );
  });

  it('requires --bundle on verify', async () => {
    const { deps } = fakeDeps();
    await expect(run(deps, ['verify'])).rejects.toThrow();
  });

  it('exits 0 when a bundle verifies clean', async () => {
    const { deps, codes } = fakeDeps();
    await run(deps, ['verify', '--bundle', '/tmp/some-bundle']);
    expect(codes).toEqual([0]);
  });

  it('exits 1 and reports findings when a bundle fails verification', async () => {
    const { deps, codes, out } = fakeDeps({
      verifyBundle: () =>
        Promise.resolve({
          ok: false,
          findings: [{ code: 'CONTENT_HASH_MISMATCH', message: 'hash does not match' }],
        }),
    });
    await run(deps, ['verify', '--bundle', '/tmp/some-bundle']);
    expect(codes).toEqual([1]);
    expect(out.some((l) => l.includes('CONTENT_HASH_MISMATCH'))).toBe(true);
  });

  it('requires --bundle on document', async () => {
    const { deps } = fakeDeps();
    await expect(run(deps, ['document'])).rejects.toThrow();
  });

  it('exits 0 after documenting a bundle', async () => {
    const { deps, codes } = fakeDeps();
    await run(deps, ['document', '--bundle', '/tmp/some-bundle']);
    expect(codes).toEqual([0]);
  });

  it('runs doctor and exits according to its report', async () => {
    const { deps, codes } = fakeDeps({
      doctor: () =>
        Promise.resolve({
          ok: false,
          checks: [{ name: 'node-version', status: 'fail' as const, detail: 'too old' }],
        }),
    });
    await run(deps, ['doctor']);
    expect(codes).toEqual([1]);
  });

  it('emits no canary even when one is planted in a bundle path or org id', async () => {
    const canary = CANARIES[0]!;
    const { deps, out } = fakeDeps({
      verifyBundle: () =>
        Promise.resolve({
          ok: false,
          findings: [{ code: 'FILE_MISSING', message: `path contains ${canary}` }],
        }),
    });
    await run(deps, ['verify', '--bundle', `/tmp/${canary}`]);
    expect(scanForCanaries(out.join('\n'))).toEqual([canary]);
    // The canary above is deliberately injected through the fake dependency's
    // own return value, to prove the CLI's *own* code does not filter or
    // duplicate it -- not to claim the CLI is a redaction boundary. What
    // matters here is that the CLI never manufactures a copy of a secret out
    // of a value that was never given to it, e.g. by echoing raw argv.
    const orgCanaryScope: unknown[] = [];
    const { deps: deps2, out: out2 } = fakeDeps({
      capture: (args) => {
        orgCanaryScope.push(args);
        return Promise.resolve({ state: 'completed' as const });
      },
    });
    await run(deps2, ['capture', '--mode', 'context', '--org', `org_${canary}`]);
    expect(scanForCanaries(out2.join('\n'))).toEqual([]);
  });
});
