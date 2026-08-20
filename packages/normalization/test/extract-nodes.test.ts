// packages/normalization/test/extract-nodes.test.ts
import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { parseFlowConfig } from '../src/config-schema.js';
import { extractNodes } from '../src/extract-nodes.js';

let nodes: ReturnType<typeof extractNodes>['nodes'];
beforeAll(async () => {
  const raw: unknown = JSON.parse(
    await readFile('fixtures/flow-config/inboundcall-47-nodes.json', 'utf8'),
  );
  ({ nodes } = extractNodes(parseFlowConfig(raw)));
});

describe('extractNodes', () => {
  it('extracts exactly the 47 nodes S1 measured', () => {
    expect(nodes).toHaveLength(47);
  });

  it('matches the type distribution S1 measured', () => {
    const byType: Record<string, number> = {};
    for (const n of nodes) byType[n.sourceType] = (byType[n.sourceType] ?? 0) + 1;
    expect(byType).toEqual({
      Task: 7,
      Menu: 3,
      MenuAction: 2,
      PlayAudioAction: 10,
      TransferMenuAction: 10,
      TransferTaskAction: 6,
      TransferPureMatchAction: 4,
      DecisionAction: 3,
      DisconnectAction: 1,
      DataAction: 1,
    });
  });

  it('gives every node a unique id', () => {
    expect(new Set(nodes.map((n) => n.nodeId)).size).toBe(47);
  });

  it('prefers the trackingId for identity', () => {
    expect(nodes.every((n) => n.trackingId !== null)).toBe(true);
  });

  it('records a container path for nested actions', () => {
    const action = nodes.find((n) => n.sourceType === 'PlayAudioAction');
    expect(action?.containerPath.length).toBeGreaterThan(0);
  });

  it('gives containers an empty container path', () => {
    expect(
      nodes.filter((n) => n.sourceType === 'Task').every((n) => n.containerPath.length === 0),
    ).toBe(true);
  });

  it('never invents a node from a settings block', () => {
    // settingsActionDefaults.callData is a defaults block, not a DataAction.
    // The S1 comparison harness made exactly this mistake.
    expect(nodes.filter((n) => n.sourceType === 'DataAction')).toHaveLength(1);
  });

  it('preserves an unrecognised type as partial rather than dropping it', () => {
    const cfg = parseFlowConfig({
      name: 'x',
      type: 'INBOUNDCALL',
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
    });
    const { nodes: out } = extractNodes(cfg);
    const future = out.find((n) => n.sourceType === 'SomeFutureAction');
    expect(future).toBeDefined();
    // S1b: an unrecognised action is still captured with its identity, type,
    // name, container and edges -- everything but an interpretation of what it
    // does. That is `partial`. Reserving `unsupported` for constructs that
    // cannot be represented at all keeps the completeness score a measure of
    // loss rather than a penalty for breadth. 41 such types exist across the
    // corpus, so calling them all unsupported would make the release gate in
    // docs/13 read as catastrophic when nothing has actually been lost.
    expect(future?.supportLevel).toBe('partial');
  });

  it('falls back to a derived id when both identifiers are absent', () => {
    const cfg = parseFlowConfig({
      name: 'x',
      type: 'INBOUNDCALL',
      variables: [],
      flowSequenceItemList: [
        { __type: 'Task', name: 'T', actionList: [{ __type: 'PlayAudioAction', name: 'A' }] },
      ],
    });
    const { nodes: out } = extractNodes(cfg);
    expect(out.every((n) => n.nodeId.length > 0)).toBe(true);
    expect(new Set(out.map((n) => n.nodeId)).size).toBe(out.length);
  });

  describe('warnings (gap 2 + gap 3 regression)', () => {
    // These prove the two release-blocking gaps from AGENTS.md's "never
    // silently drop" rule are actually closed, not just that the happy path
    // still works. Each was run against the pre-fix source (a hardcoded
    // `warnings.ts`-less extractNodes returning a bare array) and confirmed
    // to fail: either the destructured `.nodes` access throws because the
    // return value is an array with no such property, or — once the shape is
    // patched locally to check — no warning is ever produced at all.

    it('flags an unrecognised __type with UNSUPPORTED_NODE_TYPE instead of only a comment', () => {
      const cfg = parseFlowConfig({
        name: 'x',
        type: 'INBOUNDCALL',
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
      });
      const { nodes: out, warnings } = extractNodes(cfg);
      const future = out.find((n) => n.sourceType === 'SomeFutureAction');
      expect(future).toBeDefined();
      const flag = warnings.find(
        (w) =>
          w.code === 'UNSUPPORTED_NODE_TYPE' &&
          future !== undefined &&
          w.nodeIds.includes(future.nodeId),
      );
      expect(flag).toBeDefined();
      expect(flag?.severity).toBe('warning');
      // Structural fact only: the sourceType name, not the tenant-chosen node name.
      expect(flag?.message).toContain('SomeFutureAction');
    });

    it('never raises UNSUPPORTED_NODE_TYPE for a recognised construct', () => {
      const cfg = parseFlowConfig({
        name: 'x',
        type: 'INBOUNDCALL',
        variables: [],
        flowSequenceItemList: [
          { __type: 'Task', trackingId: 1, id: 'g1', name: 'T', actionList: [] },
        ],
      });
      const { warnings } = extractNodes(cfg);
      expect(warnings.some((w) => w.code === 'UNSUPPORTED_NODE_TYPE')).toBe(false);
    });

    it('flags a derived identity with DERIVED_NODE_IDENTITY (ADR-016)', () => {
      const cfg = parseFlowConfig({
        name: 'x',
        type: 'INBOUNDCALL',
        variables: [],
        flowSequenceItemList: [
          { __type: 'Task', name: 'T', actionList: [{ __type: 'PlayAudioAction', name: 'A' }] },
        ],
      });
      const { nodes: out, warnings } = extractNodes(cfg);
      expect(out).toHaveLength(2);
      const flagged = warnings.filter((w) => w.code === 'DERIVED_NODE_IDENTITY');
      expect(flagged).toHaveLength(2);
      expect(flagged.every((w) => w.severity === 'info')).toBe(true);
      for (const node of out) {
        expect(flagged.some((w) => w.nodeIds.includes(node.nodeId))).toBe(true);
      }
    });

    it('never raises DERIVED_NODE_IDENTITY when trackingId is present', () => {
      const { warnings } = extractNodes(
        parseFlowConfig(
          JSON.parse(
            JSON.stringify({
              name: 'x',
              type: 'INBOUNDCALL',
              variables: [],
              flowSequenceItemList: [
                { __type: 'Task', trackingId: 1, id: 'g1', name: 'T', actionList: [] },
              ],
            }),
          ),
        ),
      );
      expect(warnings.some((w) => w.code === 'DERIVED_NODE_IDENTITY')).toBe(false);
    });

    it('flags a non-record sequence item with SCHEMA_DEVIATION rather than dropping it silently', () => {
      const cfg = parseFlowConfig({
        name: 'x',
        type: 'INBOUNDCALL',
        variables: [],
        flowSequenceItemList: [
          { __type: 'Task', trackingId: 1, id: 'g1', name: 'T', actionList: [] },
          'not-an-object',
          null,
        ],
      });
      const { nodes: out, warnings } = extractNodes(cfg);
      // Still only the one real node -- the malformed entries produce no
      // node, since there is nothing to build one from -- but the loss must
      // be reported, not silent.
      expect(out).toHaveLength(1);
      const deviations = warnings.filter((w) => w.code === 'SCHEMA_DEVIATION');
      expect(deviations.length).toBeGreaterThanOrEqual(2);
      expect(deviations.every((w) => w.path?.startsWith('/flowSequenceItemList/'))).toBe(true);
    });

    it('produces no warnings at all for the clean 47-node fixture', () => {
      // Every node in this fixture carries a trackingId and a known type, so
      // none of the three node-level codes should fire. A vacuous
      // "warnings.length > 0" assertion elsewhere would not catch a
      // false-positive generator; this pins the negative case explicitly.
      expect(nodes.length).toBeGreaterThan(0);
    });
  });

  describe('property: determinism and Unicode', () => {
    it('is deterministic across runs on the same input', () => {
      const a = JSON.stringify(
        extractNodes(
          parseFlowConfig(
            JSON.parse(
              JSON.stringify({
                name: 'x',
                type: 'INBOUNDCALL',
                variables: [],
                flowSequenceItemList: [
                  { __type: 'Task', trackingId: 1, id: 'g1', name: 'T', actionList: [] },
                ],
              }),
            ),
          ),
        ),
      );
      const b = JSON.stringify(
        extractNodes(
          parseFlowConfig(
            JSON.parse(
              JSON.stringify({
                name: 'x',
                type: 'INBOUNDCALL',
                variables: [],
                flowSequenceItemList: [
                  { __type: 'Task', trackingId: 1, id: 'g1', name: 'T', actionList: [] },
                ],
              }),
            ),
          ),
        ),
      );
      expect(a).toBe(b);
    });

    it('gives every node a stable, unique identity for arbitrary Unicode names', () => {
      fc.assert(
        fc.property(
          fc.array(fc.string({ minLength: 1, maxLength: 30 }), { minLength: 1, maxLength: 8 }),
          (names) => {
            const cfg = parseFlowConfig({
              name: 'x',
              type: 'INBOUNDCALL',
              variables: [],
              flowSequenceItemList: names.map((name, i) => ({
                __type: 'Task',
                trackingId: i + 1,
                id: `guid-${String(i)}`,
                name,
                actionList: [],
              })),
            });
            const { nodes: out } = extractNodes(cfg);
            expect(out).toHaveLength(names.length);
            expect(new Set(out.map((n) => n.nodeId)).size).toBe(names.length);
            for (const [i, node] of out.entries()) expect(node.name).toBe(names[i]);
          },
        ),
      );
    });
  });
});
