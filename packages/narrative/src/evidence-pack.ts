// packages/narrative/src/evidence-pack.ts
//
// The typed evidence pack: the ONLY structure this package ever exposes to
// a model. Never the raw snapshot, never raw YAML, never a flow config's
// own field names -- a closed set of fields, each either a plain
// structural fact (a count, an id, a status) or an explicitly typed
// `UntrustedText` (text.ts) carrying tenant-authored content. This is what
// AGENTS.md means by "typed evidence packs ... are the control, not prompt
// wording": whatever a model does with this pack, it cannot smuggle a
// field that was never modelled here, because there is no field to
// smuggle it into. In particular, a data action's request/response
// mapping, endpoint, and header configuration have no slot in
// `EvidencePackSnapshot` below at all -- not redacted, not present -- so a
// secret planted in one of those fields cannot reach a pack no matter what
// buildEvidencePack does with the rest of the snapshot.
//
// Every entry carries the evidence id that resolves it back to an exact
// field in the captured configuration (packages/normalization/src/
// evidence.ts mints these; this module only ever reads and cites them --
// it never invents one).
//
// Determinism: buildEvidencePack takes no clock and no randomness, and
// every collection is sorted by a stable key before it is capped. The same
// snapshot and findings therefore always produce a byte-identical pack --
// required so the work queue can key a job on the pack's own content hash
// (work-queue.ts) and so a test can assert `JSON.stringify` equality
// directly.
//
// Bounding: every list below is hard-capped at a fixed count
// (`BuildEvidencePackOptions`), and every `UntrustedText` field is
// hard-capped in length (text.ts). Nothing is truncated silently --
// `EvidencePack.truncations` records exactly what and how much was left
// out, per AGENTS.md's "never silently drop".

import { contentHash, type CanonicalOptions } from '@genesys-archivist/domain';
import type {
  Finding,
  FindingKind,
  FindingSeverity,
  FindingSubject,
} from '@genesys-archivist/analysis';
import { makeUntrustedText, type UntrustedText } from './text.js';

// ---------------------------------------------------------------------------
// Input shape.
//
// `packages/narrative` depends on `@genesys-archivist/domain` (pure
// canonicalization/hashing) and `@genesys-archivist/analysis` (pure
// findings types, no I/O) but not on `@genesys-archivist/normalization` in
// production -- `FlowSnapshot` lives there. Matching the pattern already
// established in `packages/documentation` (see technical.ts's own note),
// this module declares the structural minimum it needs; a real
// `FlowSnapshot` plus a real `FlowAnalysis` satisfy these shapes without
// either package needing to import narrative's types.
// ---------------------------------------------------------------------------

export interface PackGraphNode {
  readonly nodeId: string;
  readonly sourceType: string;
  readonly name: string;
  readonly evidenceIds: readonly string[];
}

export interface PackGraphEdge {
  readonly role: string;
  readonly evidenceIds: readonly string[];
}

export interface PackGraph {
  readonly entryNodeIds: readonly string[];
  readonly nodes: readonly PackGraphNode[];
  readonly edges: readonly PackGraphEdge[];
}

export interface PackFlow {
  readonly name: string;
  readonly type: string;
  readonly description?: string;
  /** Evidence id for the flow's own `/name` field (see
   * `normalization/src/evidence.ts`'s `flowLevelEvidence`). Normalization
   * does not currently mint a distinct evidence record for `/description`,
   * so this pack cites the nearest real flow-level evidence for both
   * fields rather than inventing one that does not exist. */
  readonly flowEvidenceId: string;
}

export interface PackVariable {
  readonly variableId: string;
  readonly name: string;
  readonly scope: string;
  readonly readNodeIds: readonly string[];
  readonly writeNodeIds: readonly string[];
  readonly evidenceIds: readonly string[];
}

export interface PackDependency {
  readonly dependencyId: string;
  readonly type: string;
  readonly displayName: string | null;
  readonly resolutionStatus: string;
  readonly evidenceIds: readonly string[];
}

export interface PackReachability {
  readonly terminalNodeIds: readonly string[];
  readonly unreachableNodeIds: readonly string[];
  readonly danglingEdgeIds: readonly string[];
}

export interface PackCycles {
  readonly stronglyConnectedComponents: readonly (readonly string[])[];
}

export interface EvidencePackSnapshot {
  readonly snapshotId: string;
  readonly flow: PackFlow;
  readonly graph: PackGraph;
  readonly variables: readonly PackVariable[];
  readonly dependencies: readonly PackDependency[];
  readonly reachability: PackReachability;
  readonly cycles: PackCycles;
  /** The snapshot's full evidence set. Used only to cross-check that every
   * evidence id this module is about to cite genuinely exists -- see the
   * "dangling evidence id" handling in `buildEvidencePack`. */
  readonly evidence: readonly { readonly evidenceId: string }[];
}

// ---------------------------------------------------------------------------
// Output shape.
// ---------------------------------------------------------------------------

/** What an evidence id in this pack is "about", for the claim validator's
 * structural-support check: a claim citing evidence attributed to variable
 * X but declaring itself to be about node Y is not grounded, even though
 * both evidence ids are real. `'flow'` covers flow-wide structural facts
 * (aggregate counts, reachability summary) that are not about any single
 * node, variable, or dependency. */
export type PackSubjectKind = FindingSubject['kind'] | 'flow';

export interface PackSubject {
  readonly kind: PackSubjectKind;
  readonly id: string;
}

export interface EvidencePackSubjectIndexEntry {
  readonly evidenceId: string;
  readonly subject: PackSubject;
}

export interface EvidencePackNodeTypeCount {
  readonly sourceType: string;
  readonly count: number;
  readonly evidenceIds: readonly string[];
}

export interface EvidencePackEdgeRoleCount {
  readonly role: string;
  readonly count: number;
  readonly evidenceIds: readonly string[];
}

export interface EvidencePackEntryPoint {
  readonly nodeId: string;
  readonly sourceType: string;
  readonly name: UntrustedText;
}

export interface EvidencePackTerminalNode {
  readonly nodeId: string;
  readonly sourceType: string;
  readonly name: UntrustedText;
}

export interface EvidencePackReachabilitySummary {
  readonly totalNodes: number;
  readonly reachableNodes: number;
  readonly unreachableNodes: number;
  readonly danglingEdges: number;
}

export interface EvidencePackCycle {
  readonly nodeCount: number;
  readonly nodeIds: readonly string[];
}

export interface EvidencePackVariable {
  readonly variableId: string;
  readonly name: UntrustedText;
  readonly scope: string;
  readonly isRead: boolean;
  readonly isWritten: boolean;
  readonly evidenceIds: readonly string[];
}

export interface EvidencePackDependency {
  readonly dependencyId: string;
  readonly type: string;
  readonly displayName: UntrustedText | null;
  readonly resolutionStatus: string;
  readonly evidenceIds: readonly string[];
}

export interface EvidencePackWarning {
  readonly code: string;
  readonly severity: FindingSeverity;
  readonly kind: FindingKind;
  readonly message: UntrustedText;
  readonly subject?: FindingSubject;
  readonly evidenceIds: readonly string[];
}

export interface EvidencePackTruncation {
  readonly field: string;
  readonly omittedCount: number;
  readonly reason: string;
}

export interface EvidencePack {
  readonly packVersion: '1';
  readonly snapshotId: string;
  readonly flow: {
    readonly name: UntrustedText;
    readonly type: string;
    readonly description: UntrustedText | null;
  };
  readonly structural: {
    readonly nodeCountsByType: readonly EvidencePackNodeTypeCount[];
    readonly edgeCountsByRole: readonly EvidencePackEdgeRoleCount[];
    readonly entryPoints: readonly EvidencePackEntryPoint[];
    readonly terminalNodes: readonly EvidencePackTerminalNode[];
    readonly reachability: EvidencePackReachabilitySummary;
    readonly cycles: readonly EvidencePackCycle[];
  };
  readonly variables: readonly EvidencePackVariable[];
  readonly dependencies: readonly EvidencePackDependency[];
  readonly warnings: readonly EvidencePackWarning[];
  /** Every evidence id anywhere else in this pack, sorted and de-duplicated
   * -- the closed set claim-validator.ts checks a narration claim's
   * citations against. A citation not in this set is fabricated by
   * definition, regardless of whether it happens to be a real evidence id
   * somewhere else in the snapshot. */
  readonly evidenceIds: readonly string[];
  readonly subjectIndex: readonly EvidencePackSubjectIndexEntry[];
  readonly truncations: readonly EvidencePackTruncation[];
  readonly contentHash: string;
}

export interface BuildEvidencePackOptions {
  readonly maxUntrustedTextLength?: number;
  readonly maxVariables?: number;
  readonly maxDependencies?: number;
  readonly maxWarnings?: number;
  readonly maxEntryPoints?: number;
  readonly maxTerminalNodes?: number;
  readonly maxCycles?: number;
  readonly maxCycleNodesPerComponent?: number;
  /** Cap on the evidence ids attached to one aggregate count (node-type or
   * edge-role). An aggregate over hundreds of nodes does not need hundreds
   * of citations to be useful evidence -- a bounded, representative sample
   * is enough to ground a claim about the count. */
  readonly maxEvidenceIdsPerAggregate?: number;
}

interface ResolvedOptions {
  readonly maxUntrustedTextLength: number;
  readonly maxVariables: number;
  readonly maxDependencies: number;
  readonly maxWarnings: number;
  readonly maxEntryPoints: number;
  readonly maxTerminalNodes: number;
  readonly maxCycles: number;
  readonly maxCycleNodesPerComponent: number;
  readonly maxEvidenceIdsPerAggregate: number;
}

// Worst-case pack size with these defaults is bounded well under a
// megabyte: roughly (200 + 200 + 200 + 50 + 50) list entries, each holding
// at most one ~1000-character UntrustedText plus a handful of ids -- see
// the property test in test/evidence-pack.property.test.ts.
const DEFAULT_OPTIONS: ResolvedOptions = {
  maxUntrustedTextLength: 1000,
  maxVariables: 200,
  maxDependencies: 200,
  maxWarnings: 200,
  maxEntryPoints: 50,
  maxTerminalNodes: 50,
  maxCycles: 50,
  maxCycleNodesPerComponent: 100,
  maxEvidenceIdsPerAggregate: 20,
};

function resolveOptions(options: BuildEvidencePackOptions): ResolvedOptions {
  return { ...DEFAULT_OPTIONS, ...options };
}

const PACK_CANONICAL: CanonicalOptions = {
  canonicalizerVersion: '1',
  volatileKeys: new Set(),
  orderSensitivePaths: new Set(),
};

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort(compareStrings);
}

function capList<T>(
  items: readonly T[],
  max: number,
  field: string,
  truncations: EvidencePackTruncation[],
): readonly T[] {
  if (items.length <= max) return items;
  truncations.push({
    field,
    omittedCount: items.length - max,
    reason: `More than ${String(max)} ${field} entries were present; only the first ${String(max)} (by stable sort order) are included.`,
  });
  return items.slice(0, max);
}

function countBy<T>(items: readonly T[], key: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const k = key(item);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}

function findingSortKey(f: Finding): string {
  const subject = f.subject === undefined ? '' : `${f.subject.kind}:${f.subject.id}`;
  return `${f.code} ${subject} ${f.nodeIds.join(',')} ${f.evidenceIds.join(',')} ${f.message}`;
}

function dedupeSubjectIndex(
  entries: readonly EvidencePackSubjectIndexEntry[],
): readonly EvidencePackSubjectIndexEntry[] {
  const key = (e: EvidencePackSubjectIndexEntry): string =>
    `${e.evidenceId} ${e.subject.kind} ${e.subject.id}`;
  const seen = new Set<string>();
  const out: EvidencePackSubjectIndexEntry[] = [];
  for (const entry of entries) {
    const k = key(entry);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(entry);
  }
  return out.sort((a, b) => compareStrings(key(a), key(b)));
}

/**
 * Builds the typed evidence pack a narration provider is allowed to see.
 * Pure and deterministic: no clock, no randomness, no network. Every
 * evidence id this function cites is drawn from a field the caller
 * supplied (a node's, variable's, dependency's, or finding's own
 * `evidenceIds`) -- it is never synthesised.
 */
export function buildEvidencePack(
  snapshot: EvidencePackSnapshot,
  findings: readonly Finding[],
  options: BuildEvidencePackOptions = {},
): EvidencePack {
  const resolved = resolveOptions(options);
  const truncations: EvidencePackTruncation[] = [];
  const subjectIndex: EvidencePackSubjectIndexEntry[] = [];
  const referencedEvidenceIds = new Set<string>();

  const noteEvidence = (ids: readonly string[]): void => {
    for (const id of ids) referencedEvidenceIds.add(id);
  };
  const indexSubject = (ids: readonly string[], subject: PackSubject): void => {
    for (const id of ids) subjectIndex.push({ evidenceId: id, subject });
  };
  const flowSubject: PackSubject = { kind: 'flow', id: snapshot.snapshotId };
  const cappedAggregateIds = (ids: readonly string[], field: string): readonly string[] =>
    capList(sortedUnique(ids), resolved.maxEvidenceIdsPerAggregate, field, truncations);

  // Flow identity -----------------------------------------------------
  noteEvidence([snapshot.flow.flowEvidenceId]);
  indexSubject([snapshot.flow.flowEvidenceId], flowSubject);
  const flowName = makeUntrustedText(
    snapshot.flow.name,
    snapshot.flow.flowEvidenceId,
    resolved.maxUntrustedTextLength,
  );
  const flowDescription =
    snapshot.flow.description !== undefined && snapshot.flow.description.length > 0
      ? makeUntrustedText(
          snapshot.flow.description,
          snapshot.flow.flowEvidenceId,
          resolved.maxUntrustedTextLength,
        )
      : null;

  // Structural aggregates -----------------------------------------------
  const nodesById = new Map(snapshot.graph.nodes.map((n) => [n.nodeId, n] as const));

  const nodeCountsByType: EvidencePackNodeTypeCount[] = [
    ...countBy(snapshot.graph.nodes, (n) => n.sourceType).entries(),
  ]
    .sort(([a], [b]) => compareStrings(a, b))
    .map(([sourceType, count]) => {
      const ids = snapshot.graph.nodes
        .filter((n) => n.sourceType === sourceType)
        .flatMap((n) => n.evidenceIds);
      const capped = cappedAggregateIds(ids, `structural.nodeCountsByType[${sourceType}]`);
      noteEvidence(capped);
      indexSubject(capped, flowSubject);
      return { sourceType, count, evidenceIds: capped };
    });

  const edgeCountsByRole: EvidencePackEdgeRoleCount[] = [
    ...countBy(snapshot.graph.edges, (e) => e.role).entries(),
  ]
    .sort(([a], [b]) => compareStrings(a, b))
    .map(([role, count]) => {
      const ids = snapshot.graph.edges.filter((e) => e.role === role).flatMap((e) => e.evidenceIds);
      const capped = cappedAggregateIds(ids, `structural.edgeCountsByRole[${role}]`);
      noteEvidence(capped);
      indexSubject(capped, flowSubject);
      return { role, count, evidenceIds: capped };
    });

  const entryNodesSorted = [...snapshot.graph.entryNodeIds].sort(compareStrings);
  const entryPoints: EvidencePackEntryPoint[] = capList(
    entryNodesSorted,
    resolved.maxEntryPoints,
    'structural.entryPoints',
    truncations,
  ).map((nodeId) => {
    const node = nodesById.get(nodeId);
    const evidenceIds = node?.evidenceIds ?? [];
    noteEvidence(evidenceIds);
    indexSubject(evidenceIds, { kind: 'node', id: nodeId });
    const primaryEvidenceId = evidenceIds[0] ?? snapshot.flow.flowEvidenceId;
    return {
      nodeId,
      sourceType: node?.sourceType ?? 'unknown',
      name: makeUntrustedText(
        node?.name ?? nodeId,
        primaryEvidenceId,
        resolved.maxUntrustedTextLength,
      ),
    };
  });

  const terminalNodesSorted = [...snapshot.reachability.terminalNodeIds].sort(compareStrings);
  const terminalNodes: EvidencePackTerminalNode[] = capList(
    terminalNodesSorted,
    resolved.maxTerminalNodes,
    'structural.terminalNodes',
    truncations,
  ).map((nodeId) => {
    const node = nodesById.get(nodeId);
    const evidenceIds = node?.evidenceIds ?? [];
    noteEvidence(evidenceIds);
    indexSubject(evidenceIds, { kind: 'node', id: nodeId });
    const primaryEvidenceId = evidenceIds[0] ?? snapshot.flow.flowEvidenceId;
    return {
      nodeId,
      sourceType: node?.sourceType ?? 'unknown',
      name: makeUntrustedText(
        node?.name ?? nodeId,
        primaryEvidenceId,
        resolved.maxUntrustedTextLength,
      ),
    };
  });

  const reachability: EvidencePackReachabilitySummary = {
    totalNodes: snapshot.graph.nodes.length,
    reachableNodes: snapshot.graph.nodes.length - snapshot.reachability.unreachableNodeIds.length,
    unreachableNodes: snapshot.reachability.unreachableNodeIds.length,
    danglingEdges: snapshot.reachability.danglingEdgeIds.length,
  };

  const componentsSorted = snapshot.cycles.stronglyConnectedComponents
    .map((component) => [...component].sort(compareStrings))
    .sort((a, b) => compareStrings(a.join(','), b.join(',')));
  const cycles: EvidencePackCycle[] = capList(
    componentsSorted,
    resolved.maxCycles,
    'structural.cycles',
    truncations,
  ).map((component) => ({
    nodeCount: component.length,
    nodeIds: capList(
      component,
      resolved.maxCycleNodesPerComponent,
      'structural.cycles[].nodeIds',
      truncations,
    ),
  }));

  // Variables -----------------------------------------------------------
  const variablesSorted = [...snapshot.variables].sort((a, b) =>
    compareStrings(a.variableId, b.variableId),
  );
  const variables: EvidencePackVariable[] = capList(
    variablesSorted,
    resolved.maxVariables,
    'variables',
    truncations,
  ).map((v) => {
    noteEvidence(v.evidenceIds);
    indexSubject(v.evidenceIds, { kind: 'variable', id: v.variableId });
    const primaryEvidenceId = v.evidenceIds[0] ?? snapshot.flow.flowEvidenceId;
    return {
      variableId: v.variableId,
      name: makeUntrustedText(v.name, primaryEvidenceId, resolved.maxUntrustedTextLength),
      scope: v.scope,
      isRead: v.readNodeIds.length > 0,
      isWritten: v.writeNodeIds.length > 0,
      evidenceIds: sortedUnique(v.evidenceIds),
    };
  });

  // Dependencies ----------------------------------------------------------
  const dependenciesSorted = [...snapshot.dependencies].sort((a, b) =>
    compareStrings(a.dependencyId, b.dependencyId),
  );
  const dependencies: EvidencePackDependency[] = capList(
    dependenciesSorted,
    resolved.maxDependencies,
    'dependencies',
    truncations,
  ).map((d) => {
    noteEvidence(d.evidenceIds);
    indexSubject(d.evidenceIds, { kind: 'dependency', id: d.dependencyId });
    const primaryEvidenceId = d.evidenceIds[0] ?? snapshot.flow.flowEvidenceId;
    return {
      dependencyId: d.dependencyId,
      type: d.type,
      displayName:
        d.displayName !== null
          ? makeUntrustedText(d.displayName, primaryEvidenceId, resolved.maxUntrustedTextLength)
          : null,
      resolutionStatus: d.resolutionStatus,
      evidenceIds: sortedUnique(d.evidenceIds),
    };
  });

  // Warnings (findings) ----------------------------------------------------
  const findingsSorted = [...findings].sort((a, b) =>
    compareStrings(findingSortKey(a), findingSortKey(b)),
  );
  const warnings: EvidencePackWarning[] = capList(
    findingsSorted,
    resolved.maxWarnings,
    'warnings',
    truncations,
  ).map((f) => {
    noteEvidence(f.evidenceIds);
    if (f.subject !== undefined) indexSubject(f.evidenceIds, f.subject);
    const primaryEvidenceId = f.evidenceIds[0] ?? snapshot.flow.flowEvidenceId;
    return {
      code: f.code,
      severity: f.severity,
      kind: f.kind,
      message: makeUntrustedText(f.message, primaryEvidenceId, resolved.maxUntrustedTextLength),
      ...(f.subject !== undefined ? { subject: f.subject } : {}),
      evidenceIds: sortedUnique(f.evidenceIds),
    };
  });

  // Cross-check: every referenced id must genuinely exist in the
  // snapshot's own evidence set. A mismatch is a caller-supplied data bug,
  // not something to cite anyway -- dropped from the pack's closed set
  // rather than left in to silently misrepresent what this pack proves.
  const validEvidenceIds = new Set(snapshot.evidence.map((e) => e.evidenceId));
  const referenced = [...referencedEvidenceIds];
  const validReferenced = referenced.filter((id) => validEvidenceIds.has(id));
  const invalidCount = referenced.length - validReferenced.length;
  if (invalidCount > 0) {
    truncations.push({
      field: 'evidenceIds',
      omittedCount: invalidCount,
      reason: `${String(invalidCount)} evidence id(s) referenced while building this pack were not present in the snapshot's evidence set and were dropped rather than cited.`,
    });
  }

  const packWithoutHash = {
    packVersion: '1' as const,
    snapshotId: snapshot.snapshotId,
    flow: { name: flowName, type: snapshot.flow.type, description: flowDescription },
    structural: {
      nodeCountsByType,
      edgeCountsByRole,
      entryPoints,
      terminalNodes,
      reachability,
      cycles,
    },
    variables,
    dependencies,
    warnings,
    evidenceIds: sortedUnique(validReferenced),
    subjectIndex: dedupeSubjectIndex(subjectIndex),
    truncations,
  };

  return { ...packWithoutHash, contentHash: contentHash(packWithoutHash, PACK_CANONICAL) };
}
