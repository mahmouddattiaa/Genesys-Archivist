// packages/narrative/test/fixtures.ts
//
// Shared, deterministic test fixtures for this package's suite: a minimal
// EvidencePackSnapshot and Finding builder small enough to read at a
// glance, but structurally real enough to exercise evidence-id wiring,
// subject indexing, and truncation the way a real FlowSnapshot would.

import type { Finding } from '@genesys-archivist/analysis';
import type { EvidencePackSnapshot, PackGraphNode } from '../src/evidence-pack.js';

/** Not a real sha256 of anything -- just stable per label and shaped like
 * the real `sha256:<64hex>` scheme (normalization/src/evidence.ts), which
 * is all these tests need. */
export function evidenceId(label: string): string {
  const hex = Buffer.from(label, 'utf8').toString('hex').padEnd(64, '0').slice(0, 64);
  return `sha256:${hex}`;
}

export function makeNode(fields: {
  readonly nodeId: string;
  readonly sourceType?: string;
  readonly name?: string;
  readonly evidenceIds?: readonly string[];
}): PackGraphNode {
  return {
    nodeId: fields.nodeId,
    sourceType: fields.sourceType ?? 'MenuAction',
    name: fields.name ?? fields.nodeId,
    evidenceIds: fields.evidenceIds ?? [evidenceId(`node:${fields.nodeId}`)],
  };
}

export function makeSnapshot(overrides: Partial<EvidencePackSnapshot> = {}): EvidencePackSnapshot {
  const entry = makeNode({ nodeId: 'n1', sourceType: 'MenuAction', name: 'Main Menu' });
  const terminal = makeNode({ nodeId: 'n2', sourceType: 'DisconnectAction', name: 'Goodbye' });
  const nodes = [entry, terminal];
  const flowEvidenceId = evidenceId('flow:name');
  const edgeEvidenceId = evidenceId('edge:n1-n2');
  const varEvidenceId = evidenceId('var:v1');
  const depEvidenceId = evidenceId('dep:d1');

  const base: EvidencePackSnapshot = {
    snapshotId: 'snap_1',
    flow: {
      name: 'Test Flow',
      type: 'inboundcall',
      description: 'A test flow.',
      flowEvidenceId,
    },
    graph: {
      entryNodeIds: ['n1'],
      nodes,
      edges: [{ role: 'next', evidenceIds: [edgeEvidenceId] }],
    },
    variables: [
      {
        variableId: 'v1',
        name: 'CustomerId',
        scope: 'Flow',
        readNodeIds: ['n1'],
        writeNodeIds: [],
        evidenceIds: [varEvidenceId],
      },
    ],
    dependencies: [
      {
        dependencyId: 'd1',
        type: 'queue',
        displayName: 'Support Queue',
        resolutionStatus: 'resolved',
        evidenceIds: [depEvidenceId],
      },
    ],
    reachability: {
      terminalNodeIds: ['n2'],
      unreachableNodeIds: [],
      danglingEdgeIds: [],
    },
    cycles: { stronglyConnectedComponents: [] },
    evidence: [
      { evidenceId: flowEvidenceId },
      ...nodes.flatMap((n) => n.evidenceIds.map((id) => ({ evidenceId: id }))),
      { evidenceId: edgeEvidenceId },
      { evidenceId: varEvidenceId },
      { evidenceId: depEvidenceId },
    ],
  };

  return { ...base, ...overrides };
}

export function makeFinding(overrides: Partial<Finding> = {}): Finding {
  const base: Finding = {
    code: 'VARIABLE_DECLARED_UNUSED',
    severity: 'info',
    kind: 'derived',
    message: 'Variable "CustomerId" (Flow scope) is declared but never read or written.',
    nodeIds: [],
    evidenceIds: [evidenceId('var:v1')],
    subject: { kind: 'variable', id: 'v1' },
  };
  return { ...base, ...overrides };
}
