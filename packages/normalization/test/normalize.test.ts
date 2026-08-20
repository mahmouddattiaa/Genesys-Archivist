// packages/normalization/test/normalize.test.ts
import { readFile } from 'node:fs/promises';
import type { ValidateFunction } from 'ajv';
import { beforeAll, describe, expect, it } from 'vitest';
import { asNodeId } from '@genesys-archivist/domain';
import { createSchemaValidator } from '@genesys-archivist/testing';
import { normalizeFlow } from '../src/normalize.js';

let raw: unknown;
let validate: ValidateFunction;

const input = () => ({
  config: raw,
  source: {
    provider: 'platform-api' as const,
    adapterVersion: '0.1.0',
    extractedAt: '2026-08-20T00:00:00Z',
    region: 'eu_west_1',
    organizationId: 'org_1',
    trackingIdsAvailable: true,
    redactionApplied: true,
  },
  flow: {
    id: 'f1',
    name: 'Fixture Flow',
    type: 'inboundcall',
    secure: false,
    version: { selected: '4.0', state: 'published' as const },
  },
});

beforeAll(async () => {
  raw = JSON.parse(await readFile('fixtures/flow-config/inboundcall-47-nodes.json', 'utf8'));
  // allowUnionTypes matches scripts/validate-schemas.mjs's own Ajv setup —
  // the schema deliberately uses `type: [...]` unions (nullable ids,
  // integer-or-string version numbers), and strict mode refuses to compile
  // any schema keyword under a type union without this flag. Every other
  // option is exactly as the plan specifies: strict:true, allErrors:true.
  validate = await createSchemaValidator('schemas/flow-snapshot.schema.json', {
    allErrors: true,
    allowUnionTypes: true,
  });
});

describe('normalizeFlow', () => {
  it('produces a snapshot that validates against the published schema', () => {
    const snapshot = normalizeFlow(input());
    const valid = validate(snapshot);
    if (!valid) console.error(validate.errors);
    expect(valid).toBe(true);
  });

  it('carries all 47 nodes through', () => {
    expect(normalizeFlow(input()).graph.nodes).toHaveLength(47);
  });

  it('records at least one entry node', () => {
    expect(normalizeFlow(input()).graph.entryNodeIds.length).toBeGreaterThan(0);
  });

  it('reports completeness honestly', () => {
    const c = normalizeFlow(input()).completeness;
    expect(c?.representedObjectCount).toBe(47);
    expect(c?.unsupportedNodeCount).toBe(0);
  });

  it('is deterministic — identical input yields identical output', () => {
    expect(JSON.stringify(normalizeFlow(input()))).toBe(JSON.stringify(normalizeFlow(input())));
  });

  it('produces a stable canonical graph hash', () => {
    expect(normalizeFlow(input()).hashes.normalizedGraph).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('every node evidence id resolves to a real evidence record', () => {
    const s = normalizeFlow(input());
    const ids = new Set(s.evidence.map((e) => e.evidenceId));
    for (const n of s.graph.nodes) for (const id of n.evidenceIds) expect(ids.has(id)).toBe(true);
  });

  it('every dependency reference points at a real node', () => {
    const s = normalizeFlow(input());
    const ids = new Set(s.graph.nodes.map((n) => n.nodeId));
    for (const d of s.dependencies)
      for (const n of d.referencedByNodeIds) expect(ids.has(asNodeId(n))).toBe(true);
  });

  describe('warnings (gap 2 regression)', () => {
    // Direct proof of the gap: pre-fix, `normalize.ts` hardcodes
    // `warnings: []` regardless of input. Any assertion that a config known
    // to contain something worth reporting actually produces a non-empty
    // `warnings` array fails against that hardcoded value, with no need to
    // touch any extractor's shape first.

    it('is a real, computed empty array for the clean 47-node fixture — not a vacuous pass', () => {
      // Confirms the hardcoded `[]` and a genuinely-computed `[]` are not
      // accidentally indistinguishable: paired with the next test, which
      // proves the same pipeline produces a *non-empty* array for a
      // different input, this rules out a warnings implementation that
      // always returns `[]` no matter what.
      expect(normalizeFlow(input()).warnings).toEqual([]);
    });

    it('surfaces an unsupported node type as a warning finding', () => {
      const withUnsupported = {
        ...input(),
        config: {
          name: 'x',
          type: 'inboundcall',
          variables: [],
          flowSequenceItemList: [
            {
              __type: 'Task',
              trackingId: 1,
              id: 'g1',
              name: 'T',
              actionList: [{ __type: 'SomeFutureAction', trackingId: 2, id: 'g2', name: 'A' }],
            },
          ],
        },
      };
      const s = normalizeFlow(withUnsupported);
      expect(s.warnings.length).toBeGreaterThan(0);
      const finding = s.warnings.find((w) => w.code === 'UNSUPPORTED_NODE_TYPE');
      expect(finding).toBeDefined();
      expect(finding?.severity).toBe('warning');
      expect(finding?.evidenceIds).toEqual([]);
    });

    it('every warning finding validates against the published finding schema shape', () => {
      const withUnsupported = {
        ...input(),
        config: {
          name: 'x',
          type: 'inboundcall',
          variables: [],
          flowSequenceItemList: [
            { __type: 'Task', name: 'T', actionList: [{ __type: 'SomeFutureAction', name: 'A' }] },
          ],
        },
      };
      const s = normalizeFlow(withUnsupported);
      expect(s.warnings.length).toBeGreaterThan(0);
      const valid = validate(s);
      if (!valid) console.error(validate.errors);
      expect(valid).toBe(true);
      for (const w of s.warnings) {
        expect(w.code).toMatch(/^[A-Z0-9_]{3,100}$/);
        expect(['info', 'warning', 'error', 'critical']).toContain(w.severity);
      }
    });

    it('orders warnings deterministically across runs', () => {
      const withUnsupported = {
        ...input(),
        config: {
          name: 'x',
          type: 'inboundcall',
          variables: [],
          flowSequenceItemList: [
            { __type: 'Task', name: 'T', actionList: [{ __type: 'SomeFutureAction', name: 'A' }] },
          ],
        },
      };
      expect(JSON.stringify(normalizeFlow(withUnsupported).warnings)).toBe(
        JSON.stringify(normalizeFlow(withUnsupported).warnings),
      );
    });

    it('never lets tenant-authored text from a settings-truncation warning reach the message', () => {
      // Direct proof that a node's settings can legitimately carry a
      // canary-shaped string (that is the point of the field — tenant
      // content in a restricted snapshot) while the TRUNCATED warning that
      // reports its truncation never repeats it.
      const oversized = 'CANARY-PROMPT-1a7d'.repeat(40);
      const withOversizedExpression = {
        ...input(),
        config: {
          name: 'x',
          type: 'inboundcall',
          variables: [],
          flowSequenceItemList: [
            {
              __type: 'Task',
              trackingId: 1,
              id: '11111111-1111-1111-1111-111111111111',
              name: 'Entry',
              actionList: [
                {
                  __type: 'DecisionAction',
                  trackingId: 2,
                  id: '22222222-2222-2222-2222-222222222222',
                  name: 'Decide',
                  expression: { config: { lit: { pos: 1, text: oversized, type: 'str' } } },
                },
              ],
            },
          ],
        },
      };
      const s = normalizeFlow(withOversizedExpression);
      const node = s.graph.nodes.find((n) => n.nodeId === 'trk_2');
      expect(JSON.stringify(node?.settings)).toContain('CANARY-PROMPT-1a7d');
      const serializedWarnings = JSON.stringify(s.warnings);
      expect(serializedWarnings).not.toContain('CANARY-PROMPT-1a7d');
      expect(s.warnings.some((w) => w.code === 'TRUNCATED')).toBe(true);
    });

    it('never lets a tenant-authored flow or prompt name reach a warning message', () => {
      // Canary per the task brief: CANARY-TENANT-TEXT-9c2e names the flow,
      // CANARY-PROMPT-1a7d names a node. Both are prompt-injection vectors
      // per AGENTS.md/CLAUDE.md and must never appear in any warning —
      // only structural identifiers (node ids, field paths, type names) may.
      const withCanaries = {
        config: {
          name: 'CANARY-TENANT-TEXT-9c2e',
          type: 'inboundcall',
          variables: [],
          flowSequenceItemList: [
            {
              __type: 'Task',
              name: 'CANARY-PROMPT-1a7d',
              actionList: [
                {
                  __type: 'SomeFutureAction',
                  name: 'CANARY-PROMPT-1a7d',
                  menuReference: '77777777-7777-7777-7777-777777777777',
                  weirdUnknownField: '66666666-6666-6666-6666-666666666666',
                },
              ],
            },
          ],
        },
        source: input().source,
        flow: { ...input().flow, name: 'CANARY-TENANT-TEXT-9c2e' },
      };
      const s = normalizeFlow(withCanaries);
      expect(s.warnings.length).toBeGreaterThan(0);
      const serialized = JSON.stringify(s.warnings);
      expect(serialized).not.toContain('CANARY-TENANT-TEXT-9c2e');
      expect(serialized).not.toContain('CANARY-PROMPT-1a7d');
    });
  });

  describe('settings and promptRefs (gap 3 regression)', () => {
    // Direct proof of the gap: pre-fix, normalize.ts hardcodes
    // `settings: {}` and `promptRefs: []` for every node regardless of
    // input. The 47-node fixture alone already refutes the hardcoded
    // `settings: {}` (measured: 37 of its 47 nodes carry real, node-specific
    // configuration — see extract-settings.test.ts for where that count
    // comes from); it cannot refute the hardcoded `promptRefs: []`, since
    // this specific flow plays every prompt via inline TTS rather than a
    // prompt-library asset (see extract-prompts.test.ts), so the second
    // assertion below uses voicesurvey-16, which does reference real
    // prompt-library assets.

    it('is a real, computed non-empty settings object for most of the 47-node fixture', () => {
      const s = normalizeFlow(input());
      const withSettings = s.graph.nodes.filter((n) => Object.keys(n.settings).length > 0);
      expect(withSettings.length).toBe(37);
    });

    it('populates promptRefs from a real prompt-library reference (voicesurvey-16)', async () => {
      const raw = JSON.parse(
        await readFile('fixtures/flow-config/voicesurvey-16-nodes.json', 'utf8'),
      );
      const s = normalizeFlow({
        ...input(),
        config: raw,
        flow: { ...input().flow, type: 'voicesurvey' },
      });
      const withPromptRefs = s.graph.nodes.filter((n) => n.promptRefs.length > 0);
      expect(withPromptRefs.length).toBe(3);
      // Every promptRefs entry must join onto a real dependency in the same
      // snapshot — the schema-level shape check that proves this is not a
      // dangling identifier space of its own.
      const dependencyIds = new Set(s.dependencies.map((d) => d.dependencyId));
      for (const node of withPromptRefs) {
        for (const promptId of node.promptRefs) expect(dependencyIds.has(promptId)).toBe(true);
      }
    });

    it('is deterministic across runs for both settings and promptRefs', async () => {
      const raw = JSON.parse(
        await readFile('fixtures/flow-config/voicesurvey-16-nodes.json', 'utf8'),
      );
      const withConfig = {
        ...input(),
        config: raw,
        flow: { ...input().flow, type: 'voicesurvey' },
      };
      const a = normalizeFlow(withConfig);
      const b = normalizeFlow(withConfig);
      expect(JSON.stringify(a.graph.nodes.map((n) => [n.nodeId, n.settings, n.promptRefs]))).toBe(
        JSON.stringify(b.graph.nodes.map((n) => [n.nodeId, n.settings, n.promptRefs])),
      );
    });
  });
});
