// packages/analysis/test/reachability.test.ts
import { describe, expect, it } from 'vitest';
import { analyzeReachability } from '../src/reachability.js';

const snap = (nodes: string[], edges: [string, string][], entry: string[]) => ({
  graph: {
    entryNodeIds: entry,
    nodes: nodes.map((id) => ({ nodeId: id })),
    edges: edges.map(([from, to], i) => ({ edgeId: `e${String(i)}`, from, to, role: 'next' })),
  },
});

describe('analyzeReachability', () => {
  it('marks everything reachable from an entry', () => {
    const r = analyzeReachability(
      snap(
        ['a', 'b', 'c'],
        [
          ['a', 'b'],
          ['b', 'c'],
        ],
        ['a'],
      ),
    );
    expect([...r.reachableNodeIds].sort()).toEqual(['a', 'b', 'c']);
    expect(r.unreachableNodeIds).toHaveLength(0);
  });

  it('reports a node no entry can reach', () => {
    const r = analyzeReachability(snap(['a', 'b', 'orphan'], [['a', 'b']], ['a']));
    expect(r.unreachableNodeIds).toEqual(['orphan']);
  });

  it('terminates on a cycle', () => {
    // IVR menus loop back. A naive walk hangs here.
    const r = analyzeReachability(
      snap(
        ['a', 'b'],
        [
          ['a', 'b'],
          ['b', 'a'],
        ],
        ['a'],
      ),
    );
    expect([...r.reachableNodeIds].sort()).toEqual(['a', 'b']);
  });

  it('reports an edge pointing at a node that does not exist', () => {
    const r = analyzeReachability(snap(['a'], [['a', 'ghost']], ['a']));
    expect(r.danglingEdgeIds).toHaveLength(1);
  });

  it('identifies terminal nodes, which have no outgoing edge', () => {
    const r = analyzeReachability(snap(['a', 'b'], [['a', 'b']], ['a']));
    expect(r.terminalNodeIds).toEqual(['b']);
  });

  it('handles a snapshot with no entry at all without throwing', () => {
    const r = analyzeReachability(snap(['a'], [], []));
    expect(r.unreachableNodeIds).toEqual(['a']);
  });

  it('is deterministic', () => {
    const s = snap(
      ['c', 'a', 'b'],
      [
        ['a', 'b'],
        ['a', 'c'],
      ],
      ['a'],
    );
    expect(JSON.stringify(analyzeReachability(s))).toBe(JSON.stringify(analyzeReachability(s)));
  });
});
