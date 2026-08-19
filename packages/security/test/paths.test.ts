// packages/security/test/paths.test.ts
import { describe, expect, it } from 'vitest';
import { resolveWithinRoot, safeSegment, UntrustedPathError } from '../src/paths.js';

const ROOT = process.platform === 'win32' ? 'C:\\work\\out' : '/work/out';

describe('safeSegment', () => {
  it('keeps benign characters', () => {
    expect(safeSegment('Main-Service_IVR.v2')).toBe('Main-Service_IVR.v2');
  });

  it('replaces separators so a name cannot become a path', () => {
    expect(safeSegment('../../etc/passwd')).not.toContain('/');
    expect(safeSegment('..\\..\\windows')).not.toContain('\\');
  });

  it('never returns a relative-traversal segment', () => {
    expect(safeSegment('..')).not.toBe('..');
    expect(safeSegment('.')).not.toBe('.');
  });

  it('strips null bytes and control characters', () => {
    expect(safeSegment('name\u0000\u001f')).toBe('name');
  });

  it('bounds the length', () => {
    expect(safeSegment('a'.repeat(500)).length).toBeLessThanOrEqual(120);
  });

  it('never returns an empty string', () => {
    expect(safeSegment('///').length).toBeGreaterThan(0);
    expect(safeSegment('').length).toBeGreaterThan(0);
  });

  it('rejects Windows reserved device names', () => {
    expect(safeSegment('CON').toLowerCase()).not.toBe('con');
    expect(safeSegment('NUL').toLowerCase()).not.toBe('nul');
  });
});

describe('resolveWithinRoot', () => {
  it('resolves a normal path under the root', () => {
    expect(resolveWithinRoot(ROOT, ['flows', 'f1', 'business.md'])).toContain('business.md');
  });

  it('rejects traversal even when the caller forgot to slug', () => {
    expect(() => resolveWithinRoot(ROOT, ['..', '..', 'other-customer'])).toThrow(
      UntrustedPathError,
    );
  });

  it('rejects an absolute segment', () => {
    const absolute = process.platform === 'win32' ? 'C:\\elsewhere' : '/etc';
    expect(() => resolveWithinRoot(ROOT, [absolute])).toThrow(UntrustedPathError);
  });

  it('rejects a segment containing a null byte', () => {
    expect(() => resolveWithinRoot(ROOT, ['a\u0000b'])).toThrow(UntrustedPathError);
  });

  it('does not leak the attempted path in the error message', () => {
    try {
      resolveWithinRoot(ROOT, ['..', 'secret-customer']);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as Error).message).not.toContain('secret-customer');
    }
  });
});
