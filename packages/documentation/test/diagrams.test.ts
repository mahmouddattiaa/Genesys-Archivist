// packages/documentation/test/diagrams.test.ts
import { describe, expect, it } from 'vitest';
import { buildDiagrams } from '../src/diagrams.js';

// buildDiagrams accepts the structural minimum a diagram needs (see
// diagrams.ts), and the literals below already satisfy that narrow shape, so
// TypeScript does not require the `as never` casts here. They are kept
// anyway, matching the plan verbatim, because production callers pass the
// full FlowSnapshot/FlowAnalysis domain types instead of this fixture shape.
/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion */

const snapshot = {
  flow: { name: 'Fixture Flow' },
  graph: {
    entryNodeIds: ['a'],
    nodes: [
      { nodeId: 'a', sourceType: 'Task', name: 'Call Entry', containerPath: [] },
      { nodeId: 'b', sourceType: 'Menu', name: 'Main Menu', containerPath: [] },
      { nodeId: 'c', sourceType: 'DisconnectAction', name: 'End', containerPath: ['Call Entry'] },
    ],
    edges: [
      { edgeId: 'e0', from: 'a', to: 'b', role: 'next', label: null },
      { edgeId: 'e1', from: 'b', to: 'c', role: 'menu-choice', label: '1: Sales' },
    ],
  },
};
const analysis = { cycles: { nodeIdsInCycles: [] } };

describe('buildDiagrams', () => {
  it('produces a flowchart', () => {
    const [d] = buildDiagrams(snapshot as never, analysis as never);
    expect(d?.mermaid).toMatch(/^flowchart /m);
  });

  it('includes every node and edge of a small graph', () => {
    const [d] = buildDiagrams(snapshot as never, analysis as never);
    expect(d?.nodeIds).toHaveLength(3);
    expect(d?.mermaid).toContain('-->');
  });

  it('escapes a hostile node name', () => {
    const hostile = structuredClone(snapshot) as typeof snapshot;
    hostile.graph.nodes[0]!.name = 'evil --> injected';
    const [d] = buildDiagrams(hostile as never, analysis as never);
    const body = d?.mermaid
      .split('\n')
      .filter((l) => l.includes('injected'))
      .join('');
    expect(body).not.toContain('-->');
  });

  it('splits when the node cap is exceeded', () => {
    const big = {
      flow: { name: 'Big' },
      graph: {
        entryNodeIds: ['n0'],
        nodes: Array.from({ length: 90 }, (_, i) => ({
          nodeId: `n${String(i)}`,
          sourceType: 'PlayAudioAction',
          name: `Step ${String(i)}`,
          containerPath: i < 45 ? ['A'] : ['B'],
        })),
        edges: [],
      },
    };
    expect(buildDiagrams(big as never, analysis as never, { maxNodes: 30 }).length).toBeGreaterThan(
      1,
    );
  });

  it('emits a legend mapping short labels back to node ids', () => {
    const [d] = buildDiagrams(snapshot as never, analysis as never);
    expect(d?.mermaid).toMatch(/%%.*legend/i);
  });

  it('is deterministic', () => {
    const a = buildDiagrams(snapshot as never, analysis as never);
    const b = buildDiagrams(snapshot as never, analysis as never);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
