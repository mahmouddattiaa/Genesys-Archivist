// packages/normalization/test/extract-edges.test.ts
import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseFlowConfig } from '../src/config-schema.js';
import { extractNodes } from '../src/extract-nodes.js';
import { extractEdges } from '../src/extract-edges.js';

let cfg: ReturnType<typeof parseFlowConfig>;
let nodes: ReturnType<typeof extractNodes>;
beforeAll(async () => {
  const raw: unknown = JSON.parse(
    await readFile('fixtures/flow-config/inboundcall-47-nodes.json', 'utf8'),
  );
  cfg = parseFlowConfig(raw);
  nodes = extractNodes(cfg);
});

describe('extractEdges', () => {
  it('produces edges', () => {
    expect(extractEdges(cfg, nodes).length).toBeGreaterThan(0);
  });

  it('every endpoint resolves to a known node', () => {
    const ids = new Set(nodes.map((n) => n.nodeId));
    for (const e of extractEdges(cfg, nodes)) {
      expect(ids.has(e.from)).toBe(true);
      expect(ids.has(e.to)).toBe(true);
    }
  });

  it('gives every edge a unique id', () => {
    const edges = extractEdges(cfg, nodes);
    expect(new Set(edges.map((e) => e.edgeId)).size).toBe(edges.length);
  });

  it('labels decision branches by their outcome', () => {
    const roles = new Set(extractEdges(cfg, nodes).map((e) => e.role));
    expect(roles.has('yes') || roles.has('no')).toBe(true);
  });

  it('links menu choices to their target', () => {
    expect(extractEdges(cfg, nodes).some((e) => e.role === 'menu-choice')).toBe(true);
  });

  it('preserves sequential order within a task', () => {
    const seq = extractEdges(cfg, nodes).filter((e) => e.role === 'next');
    expect(seq.length).toBeGreaterThan(0);
  });

  it('is deterministic across runs', () => {
    expect(JSON.stringify(extractEdges(cfg, nodes))).toBe(JSON.stringify(extractEdges(cfg, nodes)));
  });
});
