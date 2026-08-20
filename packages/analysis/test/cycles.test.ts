// packages/analysis/test/cycles.test.ts
import { describe, expect, it } from 'vitest';
import { findCycles } from '../src/cycles.js';

const snap = (nodes: string[], edges: [string, string][]) => ({
  graph: {
    entryNodeIds: [nodes[0] ?? ''],
    nodes: nodes.map((id) => ({ nodeId: id })),
    edges: edges.map(([from, to], i) => ({ edgeId: `e${String(i)}`, from, to, role: 'next' })),
  },
});

describe('findCycles', () => {
  it('finds no component in an acyclic graph', () => {
    expect(findCycles(snap(['a', 'b'], [['a', 'b']])).stronglyConnectedComponents).toHaveLength(0);
  });

  it('finds a two-node cycle', () => {
    const r = findCycles(
      snap(
        ['a', 'b'],
        [
          ['a', 'b'],
          ['b', 'a'],
        ],
      ),
    );
    expect(r.stronglyConnectedComponents).toHaveLength(1);
    expect([...(r.stronglyConnectedComponents[0] ?? [])].sort()).toEqual(['a', 'b']);
  });

  it('finds a self-loop, which is how a retry is expressed', () => {
    expect(findCycles(snap(['a'], [['a', 'a']])).nodeIdsInCycles).toEqual(['a']);
  });

  it('separates two independent cycles', () => {
    const r = findCycles(
      snap(
        ['a', 'b', 'c', 'd'],
        [
          ['a', 'b'],
          ['b', 'a'],
          ['c', 'd'],
          ['d', 'c'],
        ],
      ),
    );
    expect(r.stronglyConnectedComponents).toHaveLength(2);
  });

  it('does not report an acyclic diamond as a cycle', () => {
    const r = findCycles(
      snap(
        ['a', 'b', 'c', 'd'],
        [
          ['a', 'b'],
          ['a', 'c'],
          ['b', 'd'],
          ['c', 'd'],
        ],
      ),
    );
    expect(r.stronglyConnectedComponents).toHaveLength(0);
  });

  it('is deterministic and sorted', () => {
    const s = snap(
      ['a', 'b', 'c'],
      [
        ['a', 'b'],
        ['b', 'c'],
        ['c', 'a'],
      ],
    );
    expect(JSON.stringify(findCycles(s))).toBe(JSON.stringify(findCycles(s)));
  });
});
