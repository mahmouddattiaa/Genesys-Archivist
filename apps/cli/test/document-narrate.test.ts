// apps/cli/test/document-narrate.test.ts
//
// `archivist document --narrate --profile <id>`. This is deliberately
// light: the actual narration pipeline (evidence pack, validator, resumable
// queue) is exercised end to end in
// packages/composition/test/document-bundle-to-disk-narration.test.ts. What
// belongs here is the one thing that keeps recurring in this codebase's own
// history per the task brief -- "a flag registered on a command but not
// threaded through is accepted silently and does nothing... that exact bug
// shipped here twice today" -- so every assertion below is about whether the
// flag actually reaches `deps.documentBundle`, not about narration itself.
import { describe, expect, it, vi } from 'vitest';
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
    capture: () => Promise.resolve({ state: 'completed' }),
    ...overrides,
  };
  return { deps, out, codes };
}

async function run(deps: CliDeps, argv: readonly string[]): Promise<void> {
  const program = buildProgram(deps);
  await program.parseAsync(['node', 'archivist', ...argv]);
}

describe('archivist document --narrate', () => {
  it('threads --narrate and --profile through to deps.documentBundle', async () => {
    const documentBundle = vi.fn(() => Promise.resolve({ ok: true, documentsWritten: 1 }));
    const { deps } = fakeDeps({ documentBundle });
    await run(deps, ['document', '--bundle', '/tmp/bundle', '--narrate', '--profile', 'acme']);
    expect(documentBundle).toHaveBeenCalledWith(
      '/tmp/bundle',
      expect.objectContaining({ narrate: true, profileId: 'acme' }),
    );
  });

  it('a plain document run (no --narrate) requests narrate: false and no profileId', async () => {
    let capturedOptions: { readonly narrate?: boolean; readonly profileId?: string } | undefined;
    const documentBundle: CliDeps['documentBundle'] = (_bundleDir, options) => {
      capturedOptions = options;
      return Promise.resolve({ ok: true, documentsWritten: 1 });
    };
    const { deps } = fakeDeps({ documentBundle });
    await run(deps, ['document', '--bundle', '/tmp/bundle']);
    expect(capturedOptions?.narrate).toBe(false);
    expect(capturedOptions?.profileId).toBeUndefined();
  });

  it('rejects --narrate without --profile, without ever calling documentBundle', async () => {
    const documentBundle = vi.fn(() => Promise.reject(new Error('must not be called')));
    const { deps, codes, out } = fakeDeps({ documentBundle });
    await run(deps, ['document', '--bundle', '/tmp/bundle', '--narrate']);
    expect(documentBundle).not.toHaveBeenCalled();
    expect(codes).toEqual([1]);
    expect(out.some((l) => /--profile/.test(l))).toBe(true);
  });

  it('reports narration counts when the result carries them', async () => {
    const documentBundle = vi.fn(() =>
      Promise.resolve({
        ok: true,
        documentsWritten: 2,
        narration: { narrated: 1, skipped: 1, failed: 0, acceptedClaims: 3, rejectedClaims: 1 },
      }),
    );
    const { deps, out } = fakeDeps({ documentBundle });
    await run(deps, ['document', '--bundle', '/tmp/bundle', '--narrate', '--profile', 'acme']);
    expect(out.some((l) => /narrat/i.test(l) && l.includes('1'))).toBe(true);
  });

  it('document --help mentions --narrate and its --profile requirement', () => {
    const { deps } = fakeDeps();
    const documentCmd = buildProgram(deps).commands.find((c) => c.name() === 'document');
    const help = documentCmd?.helpInformation() ?? '';
    expect(help).toMatch(/--narrate/);
    expect(help).toMatch(/--profile/);
  });
});
