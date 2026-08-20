// packages/normalization/test/extract-dependencies.test.ts
import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseFlowConfig } from '../src/config-schema.js';
import { extractNodes } from '../src/extract-nodes.js';
import { extractDependencies } from '../src/extract-dependencies.js';

let cfg: ReturnType<typeof parseFlowConfig>;
beforeAll(async () => {
  const raw: unknown = JSON.parse(
    await readFile('fixtures/flow-config/inboundcall-47-nodes.json', 'utf8'),
  );
  cfg = parseFlowConfig(raw);
});

describe('extractDependencies', () => {
  it('extracts every manifest reference', () => {
    // S3 measured six referenced resources across seven manifest categories.
    expect(extractDependencies(cfg, extractNodes(cfg)).length).toBe(6);
  });

  it('carries a stable id for every dependency', () => {
    expect(
      extractDependencies(cfg, extractNodes(cfg)).every((d) => d.dependencyId.length > 0),
    ).toBe(true);
  });

  it('preserves the resource type from the manifest category', () => {
    const types = new Set(extractDependencies(cfg, extractNodes(cfg)).map((d) => d.type));
    expect(types.has('queue')).toBe(true);
    expect(types.has('dataAction')).toBe(true);
  });

  it('records per-node provenance from the manifest context', () => {
    const queue = extractDependencies(cfg, extractNodes(cfg)).find((d) => d.type === 'queue');
    // The queue is referenced by four distinct transfer nodes.
    expect(queue?.referencedByNodeIds.length).toBe(4);
  });

  it('resolves provenance into the identity space extractNodes uses', () => {
    // context[].id carries a node's source GUID; extractNodes keys on
    // trackingId. Without reconciliation every dependency edge dangles, and
    // no per-extractor test can see it.
    const nodes = extractNodes(cfg);
    const nodeIds = new Set(nodes.map((n) => n.nodeId));
    const deps = extractDependencies(cfg, nodes);
    const refs = deps.flatMap((d) => d.referencedByNodeIds);
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.every((r) => nodeIds.has(r))).toBe(true);
  });

  it('keeps non-node contexts rather than discarding them', () => {
    // A ttsVoice context is a language setting, a systemPrompt context is
    // "defaultSettings" — real provenance, but not node references.
    const deps = extractDependencies(cfg, extractNodes(cfg));
    expect(deps.some((d) => d.nonNodeContexts.length > 0)).toBe(true);
  });

  it('reports no node references when nodes are not supplied', () => {
    // Guards against a caller silently getting raw GUIDs back.
    const deps = extractDependencies(cfg, []);
    expect(deps.flatMap((d) => d.referencedByNodeIds)).toHaveLength(0);
  });

  it('marks a dependency resolved when the manifest names it', () => {
    expect(
      extractDependencies(cfg, extractNodes(cfg)).every((d) => d.resolutionStatus === 'resolved'),
    ).toBe(true);
  });

  it('skips empty manifest categories without inventing dependencies', () => {
    // userPrompt is present but empty in this flow: all audio is inline TTS.
    expect(extractDependencies(cfg, extractNodes(cfg)).some((d) => d.type === 'userPrompt')).toBe(
      false,
    );
  });

  it('returns an empty list when there is no manifest at all', () => {
    const bare = parseFlowConfig({
      name: 'x',
      type: 'INBOUNDCALL',
      variables: [],
      flowSequenceItemList: [],
    });
    expect(extractDependencies(bare, extractNodes(bare))).toEqual([]);
  });
});
