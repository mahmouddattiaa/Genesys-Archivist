// packages/normalization/test/warnings.test.ts
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  dedupeWarnings,
  finalizeWarnings,
  sortWarnings,
  type NormalizationWarning,
} from '../src/warnings.js';

const warning = (over: Partial<NormalizationWarning> = {}): NormalizationWarning => ({
  code: 'SCHEMA_DEVIATION',
  severity: 'warning',
  message: 'm',
  path: null,
  nodeIds: [],
  ...over,
});

describe('sortWarnings', () => {
  it('orders by code, then path, then node ids, then message', () => {
    const a = warning({ code: 'DANGLING_REFERENCE', path: '/b' });
    const b = warning({ code: 'DANGLING_REFERENCE', path: '/a' });
    const c = warning({ code: 'SCHEMA_DEVIATION' });
    expect(sortWarnings([c, a, b])).toEqual([b, a, c]);
  });

  it('places two warnings that differ only in node-id order at the same rank', () => {
    // The sort key must normalize node-id order before comparing, or two
    // warnings that are the same fact recorded by two call sites in a
    // different order would sort unpredictably relative to a third warning.
    const before = warning({ code: 'DANGLING_REFERENCE', nodeIds: ['n2', 'n1'] });
    const after = warning({ code: 'SCHEMA_DEVIATION' });
    const reordered = { ...before, nodeIds: ['n1', 'n2'] as const };
    expect(sortWarnings([after, before])).toEqual([before, after]);
    expect(sortWarnings([after, reordered])).toEqual([reordered, after]);
  });

  it('does not mutate its input', () => {
    const input = [warning({ code: 'SCHEMA_DEVIATION' }), warning({ code: 'DANGLING_REFERENCE' })];
    const copy = [...input];
    sortWarnings(input);
    expect(input).toEqual(copy);
  });
});

describe('dedupeWarnings', () => {
  it('collapses exact duplicates', () => {
    const w = warning({ path: '/x' });
    expect(dedupeWarnings([w, { ...w }])).toHaveLength(1);
  });

  it('keeps warnings that differ in any field', () => {
    const a = warning({ path: '/x' });
    const b = warning({ path: '/y' });
    expect(dedupeWarnings([a, b])).toHaveLength(2);
  });
});

describe('finalizeWarnings', () => {
  it('is deterministic regardless of input order', () => {
    const warnings = [
      warning({ code: 'DANGLING_REFERENCE', path: '/a' }),
      warning({ code: 'SCHEMA_DEVIATION', path: '/b' }),
      warning({ code: 'DANGLING_REFERENCE', path: '/a' }),
    ];
    fc.assert(
      fc.property(fc.shuffledSubarray(warnings, { minLength: warnings.length }), (shuffled) => {
        expect(finalizeWarnings(shuffled)).toEqual(finalizeWarnings(warnings));
      }),
    );
  });
});
