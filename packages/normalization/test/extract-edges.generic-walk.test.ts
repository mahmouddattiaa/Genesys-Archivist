// packages/normalization/test/extract-edges.generic-walk.test.ts
//
// Gap 1 (see the task brief): extract-edges.ts's five-name field allowlist
// was measured on exactly one inboundcall flow. On any of Architect's other
// ~16 flow types the graph was wrong rather than empty, and nothing said so.
// These tests synthesise small, clearly-fabricated configurations for
// non-inboundcall flow types — bot, workflow, inqueuecall, commonmodule —
// using the same flowSequenceItemList/actionList canvas shape docs/04
// describes for every flow type, but with reference field *names* the
// current allowlist has never seen. No customer data is involved anywhere
// in this file, per CLAUDE.md.
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { parseFlowConfig, type RawFlowConfig } from '../src/config-schema.js';
import { extractNodes } from '../src/extract-nodes.js';
import { extractEdges } from '../src/extract-edges.js';

/** A minimal two-node container/action pair, with one extra reference field
 * on the action that the five-name allowlist has never catalogued. */
function makeSyntheticFlow(flowType: string, unknownFieldName: string): RawFlowConfig {
  return parseFlowConfig({
    name: `synthetic-${flowType}`,
    type: flowType,
    variables: [],
    flowSequenceItemList: [
      {
        __type: 'Task',
        trackingId: 1,
        id: '11111111-1111-1111-1111-111111111111',
        name: 'Entry',
        actionList: [
          {
            __type: 'SomeAction',
            trackingId: 2,
            id: '22222222-2222-2222-2222-222222222222',
            name: 'First',
            [unknownFieldName]: '33333333-3333-3333-3333-333333333333',
          },
          {
            __type: 'SomeAction',
            trackingId: 3,
            id: '33333333-3333-3333-3333-333333333333',
            name: 'Target',
          },
        ],
      },
    ],
  });
}

describe.each([
  ['bot', 'defaultActionId'],
  ['workflow', 'onCompleteAction'],
  ['inqueuecall', 'queueEscalationAction'],
  ['commonmodule', 'moduleExitAction'],
])('generic walk on a synthetic %s flow (field %s)', (flowType, fieldName) => {
  it('produces an edge through a field the five-name allowlist never catalogued', () => {
    const cfg = makeSyntheticFlow(flowType, fieldName);
    const { nodes } = extractNodes(cfg);
    const target = nodes.find((n) => n.name === 'Target');
    const source = nodes.find((n) => n.name === 'First');
    expect(target).toBeDefined();
    expect(source).toBeDefined();

    const { edges } = extractEdges(cfg, nodes);
    // This is the direct regression proof for gap 1: against the five-name
    // allowlist, `fieldName` is never inspected at all, so no edge to
    // `target` exists. A correct-by-construction generic walk must find it.
    const found = edges.find((e) => e.from === source?.nodeId && e.to === target?.nodeId);
    expect(found).toBeDefined();
  });

  it('records UNRECOGNISED_REFERENCE_FIELD naming the field path, not its value', () => {
    const cfg = makeSyntheticFlow(flowType, fieldName);
    const { nodes } = extractNodes(cfg);
    const { warnings } = extractEdges(cfg, nodes);
    const flag = warnings.find((w) => w.code === 'UNRECOGNISED_REFERENCE_FIELD');
    expect(flag).toBeDefined();
    expect(flag?.severity).toBe('info');
    expect(flag?.path).toContain(fieldName);
    // The field's raw GUID value is tenant/source data and must never
    // appear verbatim; only the field path and resolved node ids may.
    expect(flag?.message).not.toContain('33333333-3333-3333-3333-333333333333');
    expect(JSON.stringify(flag)).not.toContain('33333333-3333-3333-3333-333333333333');
  });
});

describe('dangling references (gap 1: self-reporting)', () => {
  it('reports DANGLING_REFERENCE for a known field pointing at nothing, and produces no phantom edge', () => {
    const cfg = parseFlowConfig({
      name: 'x',
      type: 'inboundcall',
      variables: [],
      flowSequenceItemList: [
        {
          __type: 'Task',
          trackingId: 1,
          id: 'g1',
          name: 'T',
          actionList: [
            {
              __type: 'TransferMenuAction',
              trackingId: 2,
              id: 'g2',
              name: 'Transfer',
              menuReference: '99999999-9999-9999-9999-999999999999',
            },
          ],
        },
      ],
    });
    const { nodes } = extractNodes(cfg);
    const { edges, warnings } = extractEdges(cfg, nodes);
    expect(edges.some((e) => e.role === 'transfer-menu')).toBe(false);
    const flag = warnings.find((w) => w.code === 'DANGLING_REFERENCE');
    expect(flag).toBeDefined();
    expect(flag?.severity).toBe('warning');
    expect(flag?.path).toContain('menuReference');
    // The unresolved GUID itself must never be recorded verbatim.
    expect(JSON.stringify(flag)).not.toContain('99999999-9999-9999-9999-999999999999');
  });

  it('reports DANGLING_REFERENCE for an unrecognised field pointing at nothing', () => {
    const cfg = parseFlowConfig({
      name: 'x',
      type: 'bot',
      variables: [],
      flowSequenceItemList: [
        {
          __type: 'Task',
          trackingId: 1,
          id: 'g1',
          name: 'T',
          actionList: [
            {
              __type: 'SomeAction',
              trackingId: 2,
              id: 'g2',
              name: 'A',
              fallbackIntentAction: '88888888-8888-8888-8888-888888888888',
            },
          ],
        },
      ],
    });
    const { nodes } = extractNodes(cfg);
    const { edges, warnings } = extractEdges(cfg, nodes);
    expect(edges).toHaveLength(0);
    expect(warnings.some((w) => w.code === 'DANGLING_REFERENCE')).toBe(true);
  });

  it('does not treat an absent reference field as dangling', () => {
    // Fourteen of the twenty branch entries in the reference fixture carry
    // no nextActionId at all — a labelled outcome that leads nowhere. That
    // must stay silent, not become false-positive noise.
    const cfg = parseFlowConfig({
      name: 'x',
      type: 'inboundcall',
      variables: [],
      flowSequenceItemList: [
        {
          __type: 'Task',
          trackingId: 1,
          id: 'g1',
          name: 'T',
          actionList: [
            {
              __type: 'DecisionAction',
              trackingId: 2,
              id: 'g2',
              name: 'D',
              paths: [{ outputId: '__YES__' }],
            },
          ],
        },
      ],
    });
    const { nodes } = extractNodes(cfg);
    const { warnings } = extractEdges(cfg, nodes);
    expect(warnings).toEqual([]);
  });
});

describe('value-ref noise avoidance', () => {
  it('does not treat a variable reference (ref.val) as a dangling node reference', () => {
    // A variable id looks exactly like a node id (both are GUIDs), but lives
    // in a completely different identity space. Walking generically into an
    // expression's `{config: {ref: {val, type}}}` wrapper and flagging every
    // variable read as a broken node link would swamp real findings in
    // noise on almost every DecisionAction and DataAction in a real flow.
    const cfg = parseFlowConfig({
      name: 'x',
      type: 'inboundcall',
      variables: [
        { __type: 'StringVariable', id: '44444444-4444-4444-4444-444444444444', name: 'v' },
      ],
      flowSequenceItemList: [
        {
          __type: 'Task',
          trackingId: 1,
          id: 'g1',
          name: 'T',
          actionList: [
            {
              __type: 'DecisionAction',
              trackingId: 2,
              id: 'g2',
              name: 'D',
              expression: {
                config: { ref: { val: '44444444-4444-4444-4444-444444444444', type: 'string' } },
              },
            },
          ],
        },
      ],
    });
    const { nodes } = extractNodes(cfg);
    const { edges, warnings } = extractEdges(cfg, nodes);
    expect(edges).toHaveLength(0);
    expect(warnings).toEqual([]);
  });
});

describe('property: determinism under shuffled input key order', () => {
  /** A seeded, deterministic permutation — not a random one — so a failure
   * is reproducible from the printed seed alone. Only object key insertion
   * order changes; array element order (semantically meaningful per docs/04)
   * and every value are left untouched. */
  function seededShuffle<T>(items: readonly T[], seed: number): T[] {
    const out = [...items];
    let state = seed;
    const next = (): number => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state / 0x7fffffff;
    };
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = Math.floor(next() * (i + 1));
      const a = out[i] as T;
      const b = out[j] as T;
      out[i] = b;
      out[j] = a;
    }
    return out;
  }

  function reorderKeysDeep(value: unknown, seed: number): unknown {
    if (Array.isArray(value)) {
      return value.map((item, i) => reorderKeysDeep(item, seed + i + 1));
    }
    if (value !== null && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      const keys = seededShuffle(Object.keys(record), seed);
      const reordered: Record<string, unknown> = {};
      for (const key of keys) reordered[key] = reorderKeysDeep(record[key], seed + 1);
      return reordered;
    }
    return value;
  }

  it('yields the same edges and warnings regardless of source key order', () => {
    const baseCfg = makeSyntheticFlow('bot', 'defaultActionId');
    const { nodes: baseNodes } = extractNodes(baseCfg);
    const baseline = extractEdges(baseCfg, baseNodes);
    expect(baseline.edges.length).toBeGreaterThan(0);

    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000_000 }), (seed) => {
        const shuffled = reorderKeysDeep(baseCfg, seed) as RawFlowConfig;
        const { nodes: shuffledNodes } = extractNodes(shuffled);
        const result = extractEdges(shuffled, shuffledNodes);
        expect(result.edges).toEqual(baseline.edges);
        expect(result.warnings).toEqual(baseline.warnings);
      }),
      { numRuns: 25 },
    );
  });
});
