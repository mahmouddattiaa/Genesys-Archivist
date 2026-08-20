// packages/normalization/test/extract-dependencies.test.ts
import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { asNodeId } from '@genesys-archivist/domain';
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
    expect(extractDependencies(cfg, extractNodes(cfg).nodes).dependencies).toHaveLength(6);
  });

  it('carries a stable id for every dependency', () => {
    expect(
      extractDependencies(cfg, extractNodes(cfg).nodes).dependencies.every(
        (d) => d.dependencyId.length > 0,
      ),
    ).toBe(true);
  });

  it('preserves the resource type from the manifest category', () => {
    const types = new Set(
      extractDependencies(cfg, extractNodes(cfg).nodes).dependencies.map((d) => d.type),
    );
    expect(types.has('queue')).toBe(true);
    expect(types.has('dataAction')).toBe(true);
  });

  it('records per-node provenance from the manifest context', () => {
    const queue = extractDependencies(cfg, extractNodes(cfg).nodes).dependencies.find(
      (d) => d.type === 'queue',
    );
    // The queue is referenced by four distinct transfer nodes.
    expect(queue?.referencedByNodeIds.length).toBe(4);
  });

  it('resolves provenance into the identity space extractNodes uses', () => {
    // context[].id carries a node's source GUID; extractNodes keys on
    // trackingId. Without reconciliation every dependency edge dangles, and
    // no per-extractor test can see it.
    const { nodes } = extractNodes(cfg);
    const nodeIds = new Set(nodes.map((n) => n.nodeId));
    const { dependencies: deps } = extractDependencies(cfg, nodes);
    const refs = deps.flatMap((d) => d.referencedByNodeIds);
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.every((r) => nodeIds.has(asNodeId(r)))).toBe(true);
  });

  it('keeps non-node contexts rather than discarding them', () => {
    // A ttsVoice context is a language setting, a systemPrompt context is
    // "defaultSettings" — real provenance, but not node references.
    const { dependencies: deps } = extractDependencies(cfg, extractNodes(cfg).nodes);
    expect(deps.some((d) => d.nonNodeContexts.length > 0)).toBe(true);
  });

  it('reports no node references when nodes are not supplied', () => {
    // Guards against a caller silently getting raw GUIDs back.
    const { dependencies: deps } = extractDependencies(cfg, []);
    expect(deps.flatMap((d) => d.referencedByNodeIds)).toHaveLength(0);
  });

  it('marks a dependency resolved when the manifest names it', () => {
    expect(
      extractDependencies(cfg, extractNodes(cfg).nodes).dependencies.every(
        (d) => d.resolutionStatus === 'resolved',
      ),
    ).toBe(true);
  });

  it('skips empty manifest categories without inventing dependencies', () => {
    // userPrompt is present but empty in this flow: all audio is inline TTS.
    expect(
      extractDependencies(cfg, extractNodes(cfg).nodes).dependencies.some(
        (d) => d.type === 'userPrompt',
      ),
    ).toBe(false);
  });

  it('returns an empty list when there is no manifest at all', () => {
    const bare = parseFlowConfig({
      name: 'x',
      type: 'INBOUNDCALL',
      variables: [],
      flowSequenceItemList: [],
    });
    expect(extractDependencies(bare, extractNodes(bare).nodes).dependencies).toEqual([]);
  });

  it('raises no warnings against the clean 47-node fixture', () => {
    expect(extractDependencies(cfg, extractNodes(cfg).nodes).warnings).toEqual([]);
  });

  describe('warnings (gap 2 regression)', () => {
    it('flags a non-record manifest entry with SCHEMA_DEVIATION instead of dropping it silently', () => {
      const bad = parseFlowConfig({
        name: 'x',
        type: 'INBOUNDCALL',
        variables: [],
        flowSequenceItemList: [],
        manifest: { queue: ['not-an-object', { id: 'q1', name: 'Q' }] },
      });
      const { dependencies, warnings } = extractDependencies(bad, []);
      expect(dependencies).toHaveLength(1);
      const flag = warnings.find((w) => w.code === 'SCHEMA_DEVIATION');
      expect(flag).toBeDefined();
      expect(flag?.path).toBe('/manifest/queue/0');
    });

    it('flags a manifest entry with no id with SCHEMA_DEVIATION instead of dropping it silently', () => {
      const bad = parseFlowConfig({
        name: 'x',
        type: 'INBOUNDCALL',
        variables: [],
        flowSequenceItemList: [],
        manifest: { queue: [{ name: 'no id here' }] },
      });
      const { dependencies, warnings } = extractDependencies(bad, []);
      expect(dependencies).toHaveLength(0);
      const flag = warnings.find((w) => w.code === 'SCHEMA_DEVIATION');
      expect(flag).toBeDefined();
      expect(flag?.path).toBe('/manifest/queue/0');
    });
  });
});
