// @genesys-archivist/analysis
// The findings engine: composes reachability, cycle, and journey analysis
// into a single `FlowAnalysis`, and derives a list of `Finding`s that are
// each provable from the snapshot alone. This module calls no model. Every
// finding is `kind: 'fact'` (true regardless of interpretation, e.g. a cycle
// exists) or `kind: 'derived'` (a mechanical consequence of the snapshot's
// own data, e.g. a variable nobody writes). `inference` and `unknown` are
// part of the shared vocabulary for later, model-backed layers and are never
// produced here.

import {
  analyzeReachability,
  type ReachabilityGraphEdge,
  type ReachabilityGraphNode,
  type ReachabilityReport,
} from './reachability.js';
import { findCycles, type CycleReport } from './cycles.js';
import {
  extractJourneys,
  type Journey,
  type JourneyGraphEdge,
  type JourneyGraphNode,
  type JourneyOptions,
} from './journeys.js';

/** Structural minimum this module needs from a node: everything the
 * reachability and journey analyzers need, plus what a finding must cite. */
export interface FindingsGraphNode extends ReachabilityGraphNode, JourneyGraphNode {
  readonly name: string;
  readonly supportLevel: string;
  readonly evidenceIds: readonly string[];
}

/** Structural minimum this module needs from an edge. */
export interface FindingsGraphEdge extends ReachabilityGraphEdge, JourneyGraphEdge {
  readonly label?: string;
  readonly evidenceIds: readonly string[];
}

/** Structural minimum this module needs from a snapshot's graph. */
export interface FindingsGraph {
  readonly entryNodeIds: readonly string[];
  readonly nodes: readonly FindingsGraphNode[];
  readonly edges: readonly FindingsGraphEdge[];
}

/** Structural minimum this module needs from a declared variable. */
export interface FindingsVariable {
  readonly variableId: string;
  readonly name: string;
  /** Architect scopes variables (`Flow`, `Task`, …) and permits the same
   * name in two scopes, so a name alone does not identify a variable. */
  readonly scope: string;
  readonly readNodeIds: readonly string[];
  readonly writeNodeIds: readonly string[];
  readonly evidenceIds: readonly string[];
}

/** Structural minimum this module needs from a declared dependency. */
export interface FindingsDependency {
  readonly dependencyId: string;
  readonly type: string;
  readonly resolutionStatus: string;
  readonly referencedByNodeIds: readonly string[];
  readonly evidenceIds: readonly string[];
}

/** Structural minimum this module needs from an evidence record. */
export interface FindingsEvidenceRecord {
  readonly evidenceId: string;
}

/** Structural minimum this module needs from a snapshot. Accepts a full
 * `FlowSnapshot` (from `@genesys-archivist/normalization`) too — this
 * package never imports that type directly, since it must not depend on
 * anything above `domain`. */
export interface FlowAnalysisSnapshot {
  readonly graph: FindingsGraph;
  readonly variables: readonly FindingsVariable[];
  readonly dependencies: readonly FindingsDependency[];
  readonly evidence: readonly FindingsEvidenceRecord[];
}

/** Never `inference` or `unknown` out of this package — those kinds exist
 * for a later, model-backed layer. */
export type FindingKind = 'fact' | 'derived' | 'inference' | 'unknown';
export type FindingSeverity = 'info' | 'warning' | 'error' | 'critical';

/**
 * What a finding is *about*, when that is not a node.
 *
 * `nodeIds` alone cannot identify the subject of a variable finding: a
 * declared-but-unused variable has no node sites at all, so its `nodeIds` is
 * empty and the only trace of which variable it names is prose inside
 * `message`. A renderer, a migration tool, or a reviewer filtering findings
 * would have to parse English to know. This carries the id instead.
 */
export interface FindingSubject {
  readonly kind: 'variable' | 'node' | 'edge' | 'dependency';
  readonly id: string;
}

export interface Finding {
  readonly code: string;
  readonly severity: FindingSeverity;
  readonly kind: FindingKind;
  readonly message: string;
  readonly nodeIds: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly subject?: FindingSubject;
}

export interface AnalyzeFlowOptions {
  readonly journeys?: JourneyOptions;
}

export interface FlowAnalysis<S extends FlowAnalysisSnapshot = FlowAnalysisSnapshot> {
  readonly snapshot: S;
  readonly reachability: ReachabilityReport;
  readonly cycles: CycleReport;
  readonly journeys: readonly Journey[];
  readonly findings: readonly Finding[];
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort(compareStrings);
}

/** Node types that are a genuine hand-off out of the flow, or its natural
 * end. A terminal node of one of these types is a designed conclusion, not
 * a branch that quietly goes nowhere. Mirrors journeys.ts's own
 * `isTransferNode`/`isDisconnectNode` split between an external hand-off
 * and internal navigation, since a `TransferMenuAction`-style jump is not a
 * business-relevant conclusion either. */
const INTRA_FLOW_NAVIGATION: ReadonlySet<string> = new Set([
  'TransferMenuAction',
  'TransferTaskAction',
  'CallTaskAction',
  'TaskAction',
  'MenuAction',
  'PreviousMenuAction',
]);

function isDesignedTerminal(sourceType: string): boolean {
  if (sourceType === 'DisconnectAction') return true;
  if (INTRA_FLOW_NAVIGATION.has(sourceType)) return false;
  return sourceType.includes('Transfer');
}

/** A variable is read somewhere but written nowhere in this flow. Whatever
 * branch depends on its value cannot behave as the flow author intended —
 * the value it observes is always whatever the platform default is, never
 * anything the flow itself set. */
function variableReadNeverWrittenFindings(variables: readonly FindingsVariable[]): Finding[] {
  return variables
    .filter((v) => v.readNodeIds.length > 0 && v.writeNodeIds.length === 0)
    .map((v) => ({
      code: 'VARIABLE_READ_NEVER_WRITTEN',
      severity: 'error' as const,
      kind: 'derived' as const,
      message: `Variable "${v.name}" (${v.scope} scope) is read but never written anywhere in this flow. Any branch or prompt depending on its value cannot behave as intended.`,
      nodeIds: sortedUnique(v.readNodeIds),
      evidenceIds: sortedUnique(v.evidenceIds),
      subject: { kind: 'variable' as const, id: v.variableId },
    }));
}

/** A variable is declared but neither read nor written. Harmless, but dead
 * configuration a maintainer may want to remove. */
function variableDeclaredUnusedFindings(variables: readonly FindingsVariable[]): Finding[] {
  return variables
    .filter((v) => v.readNodeIds.length === 0 && v.writeNodeIds.length === 0)
    .map((v) => ({
      code: 'VARIABLE_DECLARED_UNUSED',
      severity: 'info' as const,
      kind: 'derived' as const,
      message: `Variable "${v.name}" (${v.scope} scope) is declared but never read or written.`,
      nodeIds: [],
      evidenceIds: sortedUnique(v.evidenceIds),
      subject: { kind: 'variable' as const, id: v.variableId },
    }));
}

/** A node no entry point can reach. Whatever it configures can never run
 * for a real caller. */
function nodeUnreachableFindings(
  reachability: ReachabilityReport,
  nodesById: ReadonlyMap<string, FindingsGraphNode>,
): Finding[] {
  return [...reachability.unreachableNodeIds].sort(compareStrings).map((nodeId) => {
    const node = nodesById.get(nodeId);
    return {
      code: 'NODE_UNREACHABLE',
      severity: 'warning' as const,
      kind: 'derived' as const,
      message: `Node "${node?.name ?? nodeId}" is not reachable from any entry point.`,
      nodeIds: [nodeId],
      evidenceIds: sortedUnique(node?.evidenceIds ?? []),
    };
  });
}

/** An edge whose target node does not exist in the graph — a broken
 * reference in the captured configuration. */
function edgeDanglingFindings(
  reachability: ReachabilityReport,
  edgesById: ReadonlyMap<string, FindingsGraphEdge>,
): Finding[] {
  return [...reachability.danglingEdgeIds].sort(compareStrings).map((edgeId) => {
    const edge = edgesById.get(edgeId);
    return {
      code: 'EDGE_DANGLING',
      severity: 'error' as const,
      kind: 'derived' as const,
      message: `Edge "${edgeId}" points at a node that does not exist in the captured configuration.`,
      nodeIds: sortedUnique(edge !== undefined ? [edge.from] : []),
      evidenceIds: sortedUnique(edge?.evidenceIds ?? []),
    };
  });
}

/** A labelled outcome — a named branch or menu choice, not a plain
 * sequential step — that lands on a terminal node which is not itself a
 * designed conclusion (a disconnect or a genuine hand-off). The branch was
 * given a distinct identity by the flow author but nothing follows it: the
 * caller's path simply stops. */
function branchTerminatesNowhereFindings(
  graph: FindingsGraph,
  terminalNodeIds: readonly string[],
  nodesById: ReadonlyMap<string, FindingsGraphNode>,
): Finding[] {
  const terminalSet = new Set(terminalNodeIds);
  const labelledIncomingByTarget = new Map<string, FindingsGraphEdge[]>();

  for (const edge of graph.edges) {
    if (edge.label === undefined || edge.label.length === 0) continue;
    if (!terminalSet.has(edge.to)) continue;
    const targetNode = nodesById.get(edge.to);
    if (targetNode === undefined || isDesignedTerminal(targetNode.sourceType)) continue;
    const existing = labelledIncomingByTarget.get(edge.to);
    if (existing === undefined) labelledIncomingByTarget.set(edge.to, [edge]);
    else existing.push(edge);
  }

  return [...labelledIncomingByTarget.keys()].sort(compareStrings).map((nodeId) => {
    const node = nodesById.get(nodeId);
    const edges = labelledIncomingByTarget.get(nodeId) ?? [];
    const edgeEvidence = edges.flatMap((e) => e.evidenceIds);
    return {
      code: 'BRANCH_TERMINATES_NOWHERE',
      severity: 'warning' as const,
      kind: 'derived' as const,
      message: `A labelled outcome leads to "${node?.name ?? nodeId}", which has no further outgoing path and is not a disconnect or hand-off.`,
      nodeIds: [nodeId],
      evidenceIds: sortedUnique([...(node?.evidenceIds ?? []), ...edgeEvidence]),
    };
  });
}

/** A strongly connected component in the graph. IVRs legitimately contain
 * retries and loops (docs/04) — this is recorded for the reader, not
 * treated as a defect. */
function cyclePresentFindings(
  cycles: CycleReport,
  nodesById: ReadonlyMap<string, FindingsGraphNode>,
): Finding[] {
  return cycles.stronglyConnectedComponents.map((component) => {
    const nodeIds = [...component].sort(compareStrings);
    const evidenceIds = sortedUnique(
      nodeIds.flatMap((nodeId) => nodesById.get(nodeId)?.evidenceIds ?? []),
    );
    return {
      code: 'CYCLE_PRESENT',
      severity: 'info' as const,
      kind: 'fact' as const,
      message: `${String(nodeIds.length)} node(s) form a cycle: the flow can revisit this state, which is normal for a menu or retry.`,
      nodeIds,
      evidenceIds,
    };
  });
}

/** A dependency (queue, data action, prompt resource, and similar) that did
 * not resolve at capture time. */
function dependencyUnresolvedFindings(dependencies: readonly FindingsDependency[]): Finding[] {
  return dependencies
    .filter((d) => d.resolutionStatus !== 'resolved')
    .map((d) => ({
      code: 'DEPENDENCY_UNRESOLVED',
      severity: 'warning' as const,
      kind: 'fact' as const,
      message: `Dependency "${d.dependencyId}" (${d.type}) has resolution status "${d.resolutionStatus}".`,
      nodeIds: sortedUnique(d.referencedByNodeIds),
      evidenceIds: sortedUnique(d.evidenceIds),
    }));
}

/** A node whose type was captured but not interpreted — its settings are
 * preserved verbatim rather than modelled field by field. Recorded so the
 * reader knows this node's behaviour was not analysed in detail. */
function nodeSemanticsUnmodelledFindings(nodes: readonly FindingsGraphNode[]): Finding[] {
  return nodes
    .filter((n) => n.supportLevel === 'partial')
    .map((n) => ({
      code: 'NODE_SEMANTICS_UNMODELLED',
      severity: 'info' as const,
      kind: 'fact' as const,
      message: `Node "${n.name}" (${n.sourceType}) was captured but its semantics are not modelled.`,
      nodeIds: [n.nodeId],
      evidenceIds: sortedUnique(n.evidenceIds),
    }));
}

function findingSortKey(f: Finding): string {
  // The subject participates in the key so that two findings differing only
  // in which same-named variable they are about still order deterministically.
  const subject = f.subject === undefined ? '' : `${f.subject.kind}:${f.subject.id}`;
  return `${f.code}\u0000${subject}\u0000${f.nodeIds.join(',')}\u0000${f.evidenceIds.join(',')}\u0000${f.message}`;
}

function buildFindings(
  snapshot: FlowAnalysisSnapshot,
  reachability: ReachabilityReport,
  cycles: CycleReport,
): readonly Finding[] {
  const nodesById = new Map(snapshot.graph.nodes.map((n) => [n.nodeId, n] as const));
  const edgesById = new Map(snapshot.graph.edges.map((e) => [e.edgeId, e] as const));

  const findings: Finding[] = [
    ...variableReadNeverWrittenFindings(snapshot.variables),
    ...variableDeclaredUnusedFindings(snapshot.variables),
    ...nodeUnreachableFindings(reachability, nodesById),
    ...edgeDanglingFindings(reachability, edgesById),
    ...branchTerminatesNowhereFindings(snapshot.graph, reachability.terminalNodeIds, nodesById),
    ...cyclePresentFindings(cycles, nodesById),
    ...dependencyUnresolvedFindings(snapshot.dependencies),
    ...nodeSemanticsUnmodelledFindings(snapshot.graph.nodes),
  ];

  return findings.sort((a, b) => compareStrings(findingSortKey(a), findingSortKey(b)));
}

/**
 * Composes reachability, cycle, and journey analysis over a `FlowSnapshot`
 * (or anything with the same shape) into a single `FlowAnalysis`, plus a
 * sorted list of `Finding`s. Calls no model: every finding is either a
 * `fact` about the graph's shape (a cycle exists, a dependency did not
 * resolve, a node's semantics are unmodelled) or `derived` mechanically
 * from the snapshot's own data (a variable nobody writes, an unreachable
 * node, a dangling edge, a branch that terminates nowhere).
 */
export function analyzeFlow<S extends FlowAnalysisSnapshot>(
  snapshot: S,
  options: AnalyzeFlowOptions = {},
): FlowAnalysis<S> {
  const reachability = analyzeReachability(snapshot);
  const cycles = findCycles(snapshot);
  const journeys = extractJourneys(snapshot, options.journeys);
  const findings = buildFindings(snapshot, reachability, cycles);

  return { snapshot, reachability, cycles, journeys, findings };
}
