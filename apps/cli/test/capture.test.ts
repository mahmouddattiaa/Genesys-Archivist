// apps/cli/test/capture.test.ts
import { describe, expect, it } from 'vitest';
import { CANARIES, scanForCanaries } from '@genesys-archivist/testing';
import { parseCaptureArgs } from '../src/commands/capture.js';

describe('parseCaptureArgs', () => {
  it('parses a minimal context capture with no scope filter', () => {
    const result = parseCaptureArgs(['--mode', 'context', '--org', 'org_1']);
    expect(result).toEqual({
      kind: 'capture',
      mode: 'context',
      organizationId: 'org_1',
      scope: { kind: 'all' },
    });
  });

  it('parses a migration capture', () => {
    const result = parseCaptureArgs(['--mode', 'migration', '--org', 'org_1']);
    expect(result.kind).toBe('capture');
    expect(result.kind === 'capture' && result.mode).toBe('migration');
  });

  it('rejects a missing --mode rather than defaulting to context', () => {
    const result = parseCaptureArgs(['--org', 'org_1']);
    expect(result.kind).toBe('error');
    expect(result.kind === 'error' && result.message).toMatch(/--mode/);
  });

  it('rejects a mistyped mode value instead of silently producing a context capture', () => {
    const result = parseCaptureArgs(['--mode', 'migraton', '--org', 'org_1']);
    expect(result.kind).toBe('error');
    expect(result.kind === 'error' && result.message).toMatch(
      /context.*migration|migration.*context/i,
    );
  });

  it('rejects a missing --org', () => {
    const result = parseCaptureArgs(['--mode', 'context']);
    expect(result.kind).toBe('error');
    expect(result.kind === 'error' && result.message).toMatch(/--org/);
  });

  it('rejects an unknown flag rather than ignoring it', () => {
    const result = parseCaptureArgs(['--mode', 'context', '--org', 'org_1', '--secret', 'x']);
    expect(result.kind).toBe('error');
    expect(result.kind === 'error' && result.message).toMatch(/--secret/);
  });

  it('scopes to named flows when --flow is given', () => {
    const result = parseCaptureArgs([
      '--mode',
      'migration',
      '--org',
      'org_1',
      '--flow',
      'f1',
      '--flow',
      'f2',
    ]);
    expect(result.kind === 'capture' && result.scope).toEqual({
      kind: 'flows',
      flowIds: ['f1', 'f2'],
    });
  });

  it('scopes to a flow type filter when --flow-type is given without --flow', () => {
    const result = parseCaptureArgs([
      '--mode',
      'context',
      '--org',
      'org_1',
      '--flow-type',
      'inboundcall',
    ]);
    expect(result.kind === 'capture' && result.scope).toEqual({
      kind: 'all',
      flowTypes: ['inboundcall'],
    });
  });

  it('rejects combining --flow with --flow-type', () => {
    const result = parseCaptureArgs([
      '--mode',
      'context',
      '--org',
      'org_1',
      '--flow',
      'f1',
      '--flow-type',
      'inboundcall',
    ]);
    expect(result.kind).toBe('error');
    expect(result.kind === 'error' && result.message).toMatch(
      /--flow.*--flow-type|--flow-type.*--flow/,
    );
  });

  it('carries an optional --profile through', () => {
    const result = parseCaptureArgs([
      '--mode',
      'context',
      '--org',
      'org_1',
      '--profile',
      'sandbox',
    ]);
    expect(result.kind === 'capture' && result.profileId).toBe('sandbox');
  });

  it('omits profileId entirely when --profile is absent', () => {
    const result = parseCaptureArgs(['--mode', 'context', '--org', 'org_1']);
    expect(result.kind === 'capture' && 'profileId' in result).toBe(false);
  });

  it('rejects a bare positional argument', () => {
    const result = parseCaptureArgs(['--mode', 'context', '--org', 'org_1', 'extra']);
    expect(result.kind).toBe('error');
  });

  it('rejects an empty --org value', () => {
    const result = parseCaptureArgs(['--mode', 'context', '--org', '']);
    expect(result.kind).toBe('error');
  });

  it('never echoes the raw --org value back in a validation error', () => {
    const canary = CANARIES[0]!;
    // An organization id this long is invalid on its own terms, independent
    // of the canary — the point is that the rejection reason never repeats
    // the value that was rejected.
    const result = parseCaptureArgs(['--mode', 'context', '--org', 'x'.repeat(400) + canary]);
    expect(result.kind).toBe('error');
    expect(scanForCanaries(result.kind === 'error' ? result.message : '')).toEqual([]);
  });

  it('is pure: parsing never touches the filesystem, network, or process state', () => {
    // No assertion beyond "this module has no side-effecting imports" is
    // possible from a test, so this documents intent rather than checks it;
    // the real guarantee is the module's own import list.
    expect(typeof parseCaptureArgs).toBe('function');
  });
});
