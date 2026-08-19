// apps/cli/test/doctor.test.ts
import { describe, expect, it } from 'vitest';
import { CANARIES, scanForCanaries } from '@genesys-archivist/testing';
import { runDoctor } from '../src/commands/doctor.js';

const deps = (overrides: Partial<Parameters<typeof runDoctor>[0]> = {}) => ({
  nodeVersion: 'v22.15.0',
  outputRoot: process.platform === 'win32' ? 'C:\\work\\out' : '/work/out',
  outputRootWritable: true,
  profiles: [],
  secretStoreAvailable: true,
  ...overrides,
});

describe('runDoctor', () => {
  it('passes on a healthy machine', async () => {
    const report = await runDoctor(deps());
    expect(report.ok).toBe(true);
  });

  it('fails on an unsupported Node version', async () => {
    const report = await runDoctor(deps({ nodeVersion: 'v20.11.0' }));
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name === 'node-version')?.status).toBe('fail');
  });

  it('fails when the output root is not writable', async () => {
    const report = await runDoctor(deps({ outputRootWritable: false }));
    expect(report.checks.find((c) => c.name === 'output-root')?.status).toBe('fail');
  });

  it('warns rather than fails when no profile is configured', async () => {
    const report = await runDoctor(deps({ profiles: [] }));
    expect(report.checks.find((c) => c.name === 'profiles')?.status).toBe('warn');
    expect(report.ok).toBe(true);
  });

  it('reports secret-store health without reading any secret', async () => {
    const report = await runDoctor(deps({ secretStoreAvailable: false }));
    const check = report.checks.find((c) => c.name === 'secret-store');
    expect(check?.status).toBe('fail');
    expect(check?.detail).not.toMatch(/secret\s*=/i);
  });

  it('emits no canary even when one is planted in every input', async () => {
    const report = await runDoctor(
      deps({
        nodeVersion: `v22.15.0 ${CANARIES[0]!}`,
        outputRoot: `/work/${CANARIES[1]!}`,
      }),
    );
    expect(scanForCanaries(JSON.stringify(report))).toEqual([]);
  });
});
