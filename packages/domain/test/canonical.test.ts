// packages/domain/test/canonical.test.ts
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { canonicalize, contentHash, type CanonicalOptions } from '../src/canonical.js';

const opts: CanonicalOptions = {
  canonicalizerVersion: '1',
  volatileKeys: new Set(['extractedAt', 'mediaUri']),
  orderSensitivePaths: new Set(['/graph/edges']),
};

describe('canonicalize', () => {
  it('is insensitive to object key order', () => {
    expect(canonicalize({ b: 1, a: 2 }, opts)).toBe(canonicalize({ a: 2, b: 1 }, opts));
  });

  it('drops volatile keys at any depth', () => {
    const withVolatile = { flow: { id: 'f1', extractedAt: '2026-08-20T00:00:00Z' } };
    const without = { flow: { id: 'f1' } };
    expect(canonicalize(withVolatile, opts)).toBe(canonicalize(without, opts));
  });

  it('preserves order where order carries meaning', () => {
    const a = { graph: { edges: [{ id: 'e1' }, { id: 'e2' }] } };
    const b = { graph: { edges: [{ id: 'e2' }, { id: 'e1' }] } };
    expect(canonicalize(a, opts)).not.toBe(canonicalize(b, opts));
  });

  it('sorts order-insensitive arrays by stable content', () => {
    const a = { warnings: [{ code: 'B' }, { code: 'A' }] };
    const b = { warnings: [{ code: 'A' }, { code: 'B' }] };
    expect(canonicalize(a, opts)).toBe(canonicalize(b, opts));
  });

  it('normalizes Unicode and line endings', () => {
    expect(canonicalize({ s: 'café\r\nx' }, opts)).toBe(canonicalize({ s: 'café\nx' }, opts));
  });

  it('changes when the canonicalizer version changes', () => {
    const v2: CanonicalOptions = { ...opts, canonicalizerVersion: '2' };
    expect(contentHash({ a: 1 }, opts)).not.toBe(contentHash({ a: 1 }, v2));
  });
});

describe('contentHash', () => {
  it('returns a prefixed lowercase sha256', () => {
    expect(contentHash({ a: 1 }, opts)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('agrees with itself for any JSON value regardless of key order', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.jsonValue()), (obj) => {
        const shuffled = Object.fromEntries(Object.entries(obj).reverse());
        return contentHash(obj, opts) === contentHash(shuffled, opts);
      }),
      { numRuns: 200 },
    );
  });
});
