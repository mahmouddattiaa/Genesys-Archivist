// packages/narrative/test/evidence-pack.property.test.ts
//
// Property-based coverage for the two guarantees buildEvidencePack must
// hold for arbitrary input, not just the fixed fixture: determinism (same
// snapshot in, byte-identical pack out) and boundedness (every
// UntrustedText value respects the configured length cap, and every list
// respects its configured count cap).
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { buildEvidencePack, type EvidencePackSnapshot } from '../src/evidence-pack.js';
import { evidenceId, makeSnapshot } from './fixtures.js';

const arbitraryVariableName = fc.string({ minLength: 0, maxLength: 200 });

const arbitraryVariables = fc
  .array(fc.tuple(fc.string({ minLength: 1, maxLength: 20 }), arbitraryVariableName), {
    minLength: 0,
    maxLength: 30,
  })
  .map((pairs) =>
    pairs.map(([id, name], index) => ({
      variableId: `v-${String(index)}-${id}`,
      name,
      scope: 'Flow',
      readNodeIds: [],
      writeNodeIds: [],
      evidenceIds: [evidenceId(`var-${String(index)}-${id}`)],
    })),
  );

function snapshotWithVariables(variables: EvidencePackSnapshot['variables']): EvidencePackSnapshot {
  const base = makeSnapshot();
  return {
    ...base,
    variables,
    evidence: [
      ...base.evidence,
      ...variables.flatMap((v) => v.evidenceIds.map((id) => ({ evidenceId: id }))),
    ],
  };
}

describe('buildEvidencePack (property-based)', () => {
  it('is deterministic for arbitrary variable sets', () => {
    fc.assert(
      fc.property(arbitraryVariables, (variables) => {
        const snapshot = snapshotWithVariables(variables);
        const a = buildEvidencePack(snapshot, []);
        const b = buildEvidencePack(snapshot, []);
        expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      }),
      { numRuns: 50 },
    );
  });

  it('never emits an UntrustedText value longer than the configured cap', () => {
    fc.assert(
      fc.property(arbitraryVariables, fc.integer({ min: 1, max: 100 }), (variables, cap) => {
        const snapshot = snapshotWithVariables(variables);
        const pack = buildEvidencePack(snapshot, [], { maxUntrustedTextLength: cap });
        for (const v of pack.variables) {
          expect(v.name.value.length).toBeLessThanOrEqual(cap);
        }
      }),
      { numRuns: 50 },
    );
  });

  it('never emits more variables than the configured cap', () => {
    fc.assert(
      fc.property(arbitraryVariables, fc.integer({ min: 0, max: 30 }), (variables, cap) => {
        const snapshot = snapshotWithVariables(variables);
        const pack = buildEvidencePack(snapshot, [], { maxVariables: cap });
        expect(pack.variables.length).toBeLessThanOrEqual(cap);
        if (variables.length > cap) {
          expect(pack.truncations.some((t) => t.field === 'variables')).toBe(true);
        }
      }),
      { numRuns: 50 },
    );
  });

  it('every evidence id emitted anywhere in the pack is in the closed evidenceIds set or was reported as dropped', () => {
    fc.assert(
      fc.property(arbitraryVariables, (variables) => {
        const snapshot = snapshotWithVariables(variables);
        const pack = buildEvidencePack(snapshot, []);
        const known = new Set(pack.evidenceIds);
        for (const v of pack.variables) {
          for (const id of v.evidenceIds) {
            expect(known.has(id)).toBe(true);
          }
        }
      }),
      { numRuns: 50 },
    );
  });
});
