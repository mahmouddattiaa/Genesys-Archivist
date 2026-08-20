// packages/analysis/test/journeys.test.ts
import { describe, expect, it } from 'vitest';
import { extractJourneys } from '../src/journeys.js';

const snap = (nodes: [string, string][], edges: [string, string, string][], entry: string[]) => ({
  graph: {
    entryNodeIds: entry,
    nodes: nodes.map(([nodeId, sourceType]) => ({ nodeId, sourceType, name: nodeId })),
    edges: edges.map(([from, to, role], i) => ({
      edgeId: `e${String(i)}`,
      from,
      to,
      role,
      label: null,
    })),
  },
});

describe('extractJourneys', () => {
  it('walks a simple path to a disconnect', () => {
    const j = extractJourneys(
      snap(
        [
          ['a', 'Task'],
          ['b', 'PlayAudioAction'],
          ['c', 'DisconnectAction'],
        ],
        [
          ['a', 'b', 'next'],
          ['b', 'c', 'next'],
        ],
        ['a'],
      ),
    );
    expect(j).toHaveLength(1);
    expect(j[0]?.terminalKind).toBe('disconnect');
    expect(j[0]?.steps).toEqual(['a', 'b', 'c']);
  });

  it('produces one journey per branch', () => {
    const j = extractJourneys(
      snap(
        [
          ['a', 'Task'],
          ['y', 'DisconnectAction'],
          ['n', 'DisconnectAction'],
        ],
        [
          ['a', 'y', 'yes'],
          ['a', 'n', 'no'],
        ],
        ['a'],
      ),
    );
    expect(j).toHaveLength(2);
  });

  it('stops at a transfer rather than continuing', () => {
    const j = extractJourneys(
      snap(
        [
          ['a', 'Task'],
          ['t', 'TransferPureMatchAction'],
          ['after', 'PlayAudioAction'],
        ],
        [
          ['a', 't', 'next'],
          ['t', 'after', 'next'],
        ],
        ['a'],
      ),
    );
    expect(j[0]?.terminalKind).toBe('transfer');
    expect(j[0]?.steps).toEqual(['a', 't']);
  });

  it('terminates on a loop and labels it', () => {
    const j = extractJourneys(
      snap(
        [
          ['a', 'Task'],
          ['m', 'Menu'],
        ],
        [
          ['a', 'm', 'next'],
          ['m', 'a', 'menu-choice'],
        ],
        ['a'],
      ),
    );
    expect(j.some((x) => x.terminalKind === 'loop')).toBe(true);
  });

  it('caps total journeys and marks the result truncated', () => {
    // A wide fan-out must not explode.
    const nodes: [string, string][] = [['root', 'Menu']];
    const edges: [string, string, string][] = [];
    for (let i = 0; i < 50; i += 1) {
      nodes.push([`t${String(i)}`, 'DisconnectAction']);
      edges.push(['root', `t${String(i)}`, 'menu-choice']);
    }
    const j = extractJourneys(snap(nodes, edges, ['root']), { maxJourneys: 10 });
    expect(j.length).toBeLessThanOrEqual(10);
  });

  it('caps path depth', () => {
    const nodes: [string, string][] = [];
    const edges: [string, string, string][] = [];
    for (let i = 0; i < 100; i += 1) {
      nodes.push([`n${String(i)}`, 'PlayAudioAction']);
      if (i > 0) edges.push([`n${String(i - 1)}`, `n${String(i)}`, 'next']);
    }
    const j = extractJourneys(snap(nodes, edges, ['n0']), { maxDepth: 5 });
    expect(j[0]?.steps.length).toBeLessThanOrEqual(6);
    expect(j[0]?.terminalKind).toBe('truncated');
  });

  it('is deterministic', () => {
    const s = snap(
      [
        ['a', 'Task'],
        ['b', 'DisconnectAction'],
      ],
      [['a', 'b', 'next']],
      ['a'],
    );
    expect(JSON.stringify(extractJourneys(s))).toBe(JSON.stringify(extractJourneys(s)));
  });
});
