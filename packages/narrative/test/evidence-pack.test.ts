// packages/narrative/test/evidence-pack.test.ts
import { describe, expect, it } from 'vitest';
import { buildEvidencePack } from '../src/evidence-pack.js';
import { makeFinding, makeNode, makeSnapshot, evidenceId } from './fixtures.js';

describe('buildEvidencePack', () => {
  it('is deterministic: the same snapshot and findings produce a byte-identical pack', () => {
    const snapshot = makeSnapshot();
    const findings = [makeFinding()];
    const a = buildEvidencePack(snapshot, findings);
    const b = buildEvidencePack(snapshot, findings);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('carries the flow name and description as untrusted text citing the flow evidence id', () => {
    const snapshot = makeSnapshot();
    const pack = buildEvidencePack(snapshot, []);
    expect(pack.flow.name.kind).toBe('untrusted-text');
    expect(pack.flow.name.value).toBe('Test Flow');
    expect(pack.flow.name.evidenceId).toBe(snapshot.flow.flowEvidenceId);
    expect(pack.flow.description?.value).toBe('A test flow.');
  });

  it('omits description when the flow has none', () => {
    const { description: _omitted, ...flowWithoutDescription } = makeSnapshot().flow;
    const snapshot = makeSnapshot({ flow: flowWithoutDescription });
    const pack = buildEvidencePack(snapshot, []);
    expect(pack.flow.description).toBeNull();
  });

  it('includes every evidence id it cites in the closed evidenceIds set', () => {
    const snapshot = makeSnapshot();
    const pack = buildEvidencePack(snapshot, [makeFinding()]);
    const known = new Set(pack.evidenceIds);
    expect(known.has(snapshot.flow.flowEvidenceId)).toBe(true);
    expect(pack.variables[0]?.evidenceIds.every((id) => known.has(id))).toBe(true);
    expect(pack.dependencies[0]?.evidenceIds.every((id) => known.has(id))).toBe(true);
  });

  it('drops a referenced evidence id that is not in the snapshot evidence set, and reports it', () => {
    const snapshot = makeSnapshot();
    const dangling = evidenceId('dangling-not-in-evidence-set');
    const withDangling = {
      ...snapshot,
      variables: [{ ...snapshot.variables[0]!, evidenceIds: [dangling] }],
    };
    const pack = buildEvidencePack(withDangling, []);
    expect(pack.evidenceIds.includes(dangling)).toBe(false);
    expect(pack.truncations.some((t) => t.field === 'evidenceIds' && t.omittedCount === 1)).toBe(
      true,
    );
  });

  it('indexes variable evidence under a variable subject', () => {
    const snapshot = makeSnapshot();
    const pack = buildEvidencePack(snapshot, []);
    const varEvidenceId = snapshot.variables[0]!.evidenceIds[0]!;
    const entry = pack.subjectIndex.find((e) => e.evidenceId === varEvidenceId);
    expect(entry?.subject).toEqual({ kind: 'variable', id: 'v1' });
  });

  it('indexes dependency evidence under a dependency subject', () => {
    const snapshot = makeSnapshot();
    const pack = buildEvidencePack(snapshot, []);
    const depEvidenceId = snapshot.dependencies[0]!.evidenceIds[0]!;
    const entry = pack.subjectIndex.find((e) => e.evidenceId === depEvidenceId);
    expect(entry?.subject).toEqual({ kind: 'dependency', id: 'd1' });
  });

  it('indexes entry-point and terminal-node evidence under a node subject', () => {
    // The same evidence id is also cited by the node-type aggregate count
    // (under a 'flow' subject) -- both are legitimate, so this looks for
    // the specific 'node' entry rather than assuming only one exists.
    const snapshot = makeSnapshot();
    const pack = buildEvidencePack(snapshot, []);
    const entryEvidenceId = snapshot.graph.nodes[0]!.evidenceIds[0]!;
    const entry = pack.subjectIndex.find(
      (e) => e.evidenceId === entryEvidenceId && e.subject.kind === 'node',
    );
    expect(entry?.subject).toEqual({ kind: 'node', id: 'n1' });
  });

  it('carries a finding subject through to warnings and the subject index', () => {
    const snapshot = makeSnapshot();
    const finding = makeFinding({ subject: { kind: 'variable', id: 'v1' } });
    const pack = buildEvidencePack(snapshot, [finding]);
    expect(pack.warnings[0]?.subject).toEqual({ kind: 'variable', id: 'v1' });
  });

  it('never carries a data action field this schema has no slot for', () => {
    // buildEvidencePack's only inputs are EvidencePackSnapshot fields --
    // there is no field anywhere in that type for a data action's request
    // template, headers, or endpoint. A caller cannot smuggle one through
    // even by trying: TypeScript rejects an extra property on a snapshot
    // built to satisfy the type, and at runtime this function only ever
    // reads the fields the type declares.
    const snapshot = makeSnapshot({
      dependencies: [
        {
          dependencyId: 'da1',
          type: 'dataAction',
          displayName: 'Lookup Customer',
          resolutionStatus: 'resolved',
          evidenceIds: [evidenceId('dep:da1')],
        },
      ],
    });
    const pack = buildEvidencePack(snapshot, []);
    const json = JSON.stringify(pack);
    expect(json).not.toContain('requestUrlTemplate');
    expect(json).not.toContain('endpoint');
  });

  it('reports truncation rather than silently dropping when a list exceeds its cap', () => {
    const manyVariables = Array.from({ length: 5 }, (_, i) => ({
      variableId: `v${String(i)}`,
      name: `Var${String(i)}`,
      scope: 'Flow',
      readNodeIds: [],
      writeNodeIds: [],
      evidenceIds: [evidenceId(`var:${String(i)}`)],
    }));
    const snapshot = makeSnapshot({
      variables: manyVariables,
      evidence: [
        ...makeSnapshot().evidence,
        ...manyVariables.flatMap((v) => v.evidenceIds.map((id) => ({ evidenceId: id }))),
      ],
    });
    const pack = buildEvidencePack(snapshot, [], { maxVariables: 2 });
    expect(pack.variables).toHaveLength(2);
    expect(pack.truncations.some((t) => t.field === 'variables' && t.omittedCount === 3)).toBe(
      true,
    );
  });

  it('truncates an oversized untrusted-text field and records the cut', () => {
    const longName = 'n'.repeat(10_000);
    const snapshot = makeSnapshot({ flow: { ...makeSnapshot().flow, name: longName } });
    const pack = buildEvidencePack(snapshot, [], { maxUntrustedTextLength: 500 });
    expect(pack.flow.name.value).toHaveLength(500);
    expect(pack.flow.name.truncatedAt).toBe(500);
  });

  it('caps evidence ids attached to a node-type aggregate count', () => {
    const nodes = Array.from({ length: 10 }, (_, i) =>
      makeNode({ nodeId: `n${String(i)}`, sourceType: 'MenuAction' }),
    );
    const snapshot = makeSnapshot({
      graph: { entryNodeIds: ['n0'], nodes, edges: [] },
      reachability: { terminalNodeIds: [], unreachableNodeIds: [], danglingEdgeIds: [] },
      evidence: [
        ...makeSnapshot().evidence,
        ...nodes.flatMap((n) => n.evidenceIds.map((id) => ({ evidenceId: id }))),
      ],
    });
    const pack = buildEvidencePack(snapshot, [], { maxEvidenceIdsPerAggregate: 3 });
    const menuCount = pack.structural.nodeCountsByType.find((n) => n.sourceType === 'MenuAction');
    expect(menuCount?.count).toBe(10);
    expect(menuCount?.evidenceIds.length).toBeLessThanOrEqual(3);
  });

  it('computes a reachability summary from the snapshot', () => {
    const snapshot = makeSnapshot();
    const pack = buildEvidencePack(snapshot, []);
    expect(pack.structural.reachability).toEqual({
      totalNodes: 2,
      reachableNodes: 2,
      unreachableNodes: 0,
      danglingEdges: 0,
    });
  });

  it('stamps a sha256 content hash derived from the pack itself', () => {
    const pack = buildEvidencePack(makeSnapshot(), []);
    expect(pack.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('changes content hash when the underlying flow name changes', () => {
    const a = buildEvidencePack(makeSnapshot(), []);
    const b = buildEvidencePack(
      makeSnapshot({ flow: { ...makeSnapshot().flow, name: 'Other' } }),
      [],
    );
    expect(a.contentHash).not.toBe(b.contentHash);
  });
});
