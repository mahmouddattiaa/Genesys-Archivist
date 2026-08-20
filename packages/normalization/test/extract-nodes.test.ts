// packages/normalization/test/extract-nodes.test.ts
import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseFlowConfig } from '../src/config-schema.js';
import { extractNodes } from '../src/extract-nodes.js';

let nodes: ReturnType<typeof extractNodes>;
beforeAll(async () => {
  const raw: unknown = JSON.parse(
    await readFile('fixtures/flow-config/inboundcall-47-nodes.json', 'utf8'),
  );
  nodes = extractNodes(parseFlowConfig(raw));
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

  it('preserves an unrecognised type as unsupported rather than dropping it', () => {
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
    const out = extractNodes(cfg);
    const future = out.find((n) => n.sourceType === 'SomeFutureAction');
    expect(future).toBeDefined();
    expect(future?.supportLevel).toBe('unsupported');
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
    const out = extractNodes(cfg);
    expect(out.every((n) => n.nodeId.length > 0)).toBe(true);
    expect(new Set(out.map((n) => n.nodeId)).size).toBe(out.length);
  });
});
