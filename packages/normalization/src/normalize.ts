// packages/normalization/src/normalize.ts
import {
  contentHash,
  type CanonicalOptions,
  type DependencyResolutionStatus,
  type EdgeId,
  type NodeId,
} from '@genesys-archivist/domain';
import { parseFlowConfig } from './config-schema.js';
import { extractNodes, type ExtractedNode, type NodeSupportLevel } from './extract-nodes.js';
import { extractDependencies, type ExtractedDependency } from './extract-dependencies.js';
import { extractEdges, type ExtractedEdge } from './extract-edges.js';
import {
  extractVariables,
  indexVariableUsage,
  type ExtractedVariable,
  type VariableDirection,
  type VariableUsageIndex,
} from './extract-variables.js';
import { buildEvidence, type Evidence } from './evidence.js';
import { extractPromptReferences } from './extract-prompts.js';
import { extractSettings } from './extract-settings.js';
import { finalizeWarnings, type NormalizationWarning } from './warnings.js';

/**
 * Everything a caller must already know before a raw configuration can be
 * turned into a `FlowSnapshot`: which source path produced it, and which
 * flow/version it belongs to. `config` is untrusted input and is validated
 * by `parseFlowConfig` before anything else touches it.
 *
 * `extractedAt` always comes from this input, never from `new Date()` —
 * introducing wall-clock time here would break the determinism the plan's
 * own tests assert.
 */
export interface NormalizeInput {
  readonly config: unknown;
  readonly source: SourceMetadata;
  readonly flow: FlowIdentity;
}

/** Mirrors `$defs.source` in `schemas/flow-snapshot.schema.json` exactly —
 * every key here, and no others, is legal under that definition's
 * `additionalProperties: false`. */
export interface SourceMetadata {
  readonly provider: 'platform-api' | 'archy-cli' | 'manual-yaml' | 'fixture';
  readonly adapterVersion: string;
  readonly extractedAt: string;
  readonly region: string;
  readonly organizationId: string;
  readonly trackingIdsAvailable: boolean;
  readonly redactionApplied: boolean;
  readonly sdkVersion?: string;
  readonly organizationName?: string;
  readonly sourceContentHash?: string;
  readonly redactedSourceHash?: string;
  readonly captureId?: string;
}

/** Mirrors `$defs.version`. */
export interface FlowVersionInfo {
  readonly selected: string | number;
  readonly state: 'published' | 'checked-in' | 'working-copy' | 'manual';
  readonly published?: string | number | null;
  readonly latestCheckedIn?: string | number | null;
  readonly workingCopyPresent?: boolean;
  readonly modifiedAt?: string | null;
}

/** Mirrors `$defs.flow`. */
export interface FlowIdentity {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly secure: boolean;
  readonly version: FlowVersionInfo;
  readonly description?: string;
  readonly divisionId?: string | null;
  readonly divisionName?: string | null;
  readonly languages?: readonly string[];
}

/** Mirrors `$defs.node`. */
export interface FlowSnapshotNode {
  readonly nodeId: NodeId;
  readonly trackingId: string | null;
  readonly kind: string;
  readonly sourceType: string;
  readonly name: string;
  readonly containerPath: readonly string[];
  readonly supportLevel: NodeSupportLevel;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly variableReads: readonly string[];
  readonly variableWrites: readonly string[];
  readonly dependencyRefs: readonly string[];
  readonly promptRefs: readonly string[];
  readonly evidenceIds: readonly string[];
}

/** Mirrors `$defs.edge`. `label` is omitted rather than set to `null` — the
 * schema types `label` as `string` only, with no `null` variant. */
export interface FlowSnapshotEdge {
  readonly edgeId: EdgeId;
  readonly from: NodeId;
  readonly to: NodeId;
  readonly role: string;
  readonly label?: string;
  readonly condition: string | null;
  readonly evidenceIds: readonly string[];
}

/** Mirrors `$defs.variable`. */
export interface FlowSnapshotVariable {
  readonly variableId: string;
  readonly name: string;
  readonly scope: string;
  readonly dataType: string;
  readonly direction: 'input' | 'output' | 'input-output' | 'local' | 'unknown';
  readonly secure: boolean;
  readonly readNodeIds: readonly string[];
  readonly writeNodeIds: readonly string[];
  readonly evidenceIds: readonly string[];
}

/** Mirrors `$defs.dependency`. */
export interface FlowSnapshotDependency {
  readonly dependencyId: string;
  readonly type: string;
  readonly displayName: string | null;
  readonly resolutionStatus: DependencyResolutionStatus;
  readonly safeMetadata?: Readonly<Record<string, unknown>>;
  readonly referencedByNodeIds: readonly string[];
  readonly evidenceIds: readonly string[];
}

/**
 * Mirrors `$defs.finding`. Populated from every extractor's
 * `NormalizationWarning`s: an uncatalogued node type, a reference field the
 * generic walk had never seen before, a dangling reference, a derived node
 * identity, or a structural deviation from the expected shape — each a
 * fact this normalizer itself established while building the snapshot.
 *
 * This is *not* where graph analysis (reachability, dead branches, cycles)
 * lands — that is a different `Finding` type, produced by
 * `packages/analysis` from the snapshot this module returns, and is a later
 * pipeline stage entirely. The two are easy to conflate because both end up
 * called "findings" in prose; only this module's own extraction-time
 * warnings are represented here.
 */
export interface FlowSnapshotFinding {
  readonly code: string;
  readonly severity: 'info' | 'warning' | 'error' | 'critical';
  readonly message: string;
  readonly evidenceIds: readonly string[];
}

/** Mirrors `$defs.completeness`. */
export interface FlowSnapshotCompleteness {
  readonly sourceObjectCount: number;
  readonly representedObjectCount: number;
  readonly unsupportedNodeCount: number;
  readonly opaqueNodeCount: number;
  readonly danglingEdgeCount: number;
  readonly unresolvedDependencyCount: number;
}

/** Mirrors `$defs.hashes`. `evidencePack` and `finalDocumentSet` are later
 * pipeline stages' concerns and are omitted here rather than guessed at. */
export interface FlowSnapshotHashes {
  readonly canonicalizerVersion: string;
  readonly normalizedGraph: string;
}

export interface FlowSnapshotGraph {
  readonly entryNodeIds: readonly NodeId[];
  readonly nodes: readonly FlowSnapshotNode[];
  readonly edges: readonly FlowSnapshotEdge[];
}

/** The published contract: `schemas/flow-snapshot.schema.json`. */
export interface FlowSnapshot {
  readonly schemaVersion: '1.1';
  readonly snapshotId: string;
  readonly source: SourceMetadata;
  readonly flow: FlowIdentity;
  readonly graph: FlowSnapshotGraph;
  readonly variables: readonly FlowSnapshotVariable[];
  readonly dependencies: readonly FlowSnapshotDependency[];
  readonly evidence: readonly Evidence[];
  readonly warnings: readonly FlowSnapshotFinding[];
  /** Optional per the schema; always populated here — normalizeFlow always
   * has enough information from the extractors to report completeness. */
  readonly completeness?: FlowSnapshotCompleteness;
  readonly hashes: FlowSnapshotHashes;
}

/** Version of the canonicalization *algorithm* applied before hashing —
 * independent of `schemaVersion`, which versions the snapshot shape. */
const CANONICALIZER_VERSION = '1.0.0';

/**
 * `/edges` is the only order-sensitive path: edge order encodes sequential
 * and branch execution order, which is semantically meaningful (per the
 * plan's determinism hazard). Every other collection reachable from `graph`
 * — `entryNodeIds`, `nodes`, and every per-node id list — is a set in
 * substance even where it is an array in shape, so `contentHash`'s default
 * sort keeps the hash stable under reordering that carries no meaning.
 * `graph` itself carries no volatile fields (no timestamps, no run-specific
 * data), so `volatileKeys` is empty.
 */
const CANONICAL_OPTIONS: CanonicalOptions = {
  canonicalizerVersion: CANONICALIZER_VERSION,
  volatileKeys: new Set(),
  orderSensitivePaths: new Set(['/edges']),
};

function dedupe(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

/** Groups evidence records by the exact configuration pointer they cite, so
 * a node or variable can look up the evidence that documents it without
 * re-deriving that pointer. Node and variable source pointers never collide
 * (a task-scoped variable's pointer always carries a `/variables/<n>` suffix
 * its owning container's pointer does not have). */
function groupEvidenceByPointer(evidence: readonly Evidence[]): ReadonlyMap<string, string[]> {
  const byPointer = new Map<string, string[]>();
  for (const record of evidence) {
    const existing = byPointer.get(record.sourcePointer);
    if (existing === undefined) byPointer.set(record.sourcePointer, [record.evidenceId]);
    else existing.push(record.evidenceId);
  }
  return byPointer;
}

/** Inverts `VariableUsageIndex` (variable id -> node ids) into node id ->
 * variable ids, in both the read and write direction, so each node can
 * carry its own `variableReads` / `variableWrites`. */
function invertVariableUsage(usage: VariableUsageIndex): {
  readonly reads: ReadonlyMap<string, string[]>;
  readonly writes: ReadonlyMap<string, string[]>;
} {
  const reads = new Map<string, string[]>();
  const writes = new Map<string, string[]>();

  const addTo = (map: Map<string, string[]>, nodeId: string, variableId: string): void => {
    const existing = map.get(nodeId);
    if (existing === undefined) map.set(nodeId, [variableId]);
    else existing.push(variableId);
  };

  for (const [variableId, nodeUsage] of usage) {
    for (const nodeId of nodeUsage.readBy) addTo(reads, nodeId, variableId);
    for (const nodeId of nodeUsage.writtenBy) addTo(writes, nodeId, variableId);
  }

  return { reads, writes };
}

/** Inverts each dependency's `referencedByNodeIds` into node id -> the
 * dependency ids that node references, for the node's own `dependencyRefs`. */
function invertDependencyReferences(
  dependencies: readonly ExtractedDependency[],
): ReadonlyMap<string, string[]> {
  const byNode = new Map<string, string[]>();
  for (const dependency of dependencies) {
    for (const nodeId of dependency.referencedByNodeIds) {
      const existing = byNode.get(nodeId);
      if (existing === undefined) byNode.set(nodeId, [dependency.dependencyId]);
      else existing.push(dependency.dependencyId);
    }
  }
  return byNode;
}

/**
 * A container that no edge points into is where flow execution starts.
 * Never hardcoded — derived from the graph itself, so a fixture with more
 * than one true entry point is represented honestly rather than guessed at.
 */
function computeEntryNodeIds(
  nodes: readonly ExtractedNode[],
  edges: readonly ExtractedEdge[],
): readonly NodeId[] {
  const targeted = new Set(edges.map((edge) => edge.to));
  return nodes
    .filter((node) => node.kind === 'container' && !targeted.has(node.nodeId))
    .map((node) => node.nodeId);
}

/** `VariableDirection` (`extract-variables.ts`) uses camelCase and a `none`
 * case for "declared but neither input nor output"; the schema's `direction`
 * enum uses a hyphen and calls that same case `local`. */
function toSnapshotDirection(direction: VariableDirection): FlowSnapshotVariable['direction'] {
  switch (direction) {
    case 'input':
      return 'input';
    case 'output':
      return 'output';
    case 'inputOutput':
      return 'input-output';
    case 'none':
      return 'local';
  }
}

function toSnapshotNode(
  node: ExtractedNode,
  evidenceByPointer: ReadonlyMap<string, string[]>,
  variableReadsByNode: ReadonlyMap<string, string[]>,
  variableWritesByNode: ReadonlyMap<string, string[]>,
  dependencyRefsByNode: ReadonlyMap<string, string[]>,
  promptRefsByNode: ReadonlyMap<string, readonly string[]>,
  settingsByNode: ReadonlyMap<string, Readonly<Record<string, unknown>>>,
): FlowSnapshotNode {
  return {
    nodeId: node.nodeId,
    trackingId: node.trackingId,
    kind: node.kind,
    sourceType: node.sourceType,
    name: node.name,
    containerPath: node.containerPath,
    supportLevel: node.supportLevel,
    settings: settingsByNode.get(node.nodeId) ?? {},
    variableReads: dedupe(variableReadsByNode.get(node.nodeId) ?? []),
    variableWrites: dedupe(variableWritesByNode.get(node.nodeId) ?? []),
    dependencyRefs: dedupe(dependencyRefsByNode.get(node.nodeId) ?? []),
    promptRefs: dedupe(promptRefsByNode.get(node.nodeId) ?? []),
    evidenceIds: dedupe(evidenceByPointer.get(node.sourcePointer) ?? []),
  };
}

function toSnapshotEdge(edge: ExtractedEdge): FlowSnapshotEdge {
  return {
    edgeId: edge.edgeId,
    from: edge.from,
    to: edge.to,
    role: edge.role,
    condition: edge.condition,
    evidenceIds: [],
    ...(edge.label !== null ? { label: edge.label } : {}),
  };
}

function toSnapshotVariable(
  variable: ExtractedVariable,
  usage: VariableUsageIndex,
  evidenceByPointer: ReadonlyMap<string, string[]>,
): FlowSnapshotVariable {
  const nodeUsage = usage.get(variable.variableId);
  return {
    variableId: variable.variableId,
    name: variable.name,
    scope: variable.scope,
    dataType: variable.dataType,
    direction: toSnapshotDirection(variable.direction),
    secure: variable.secure,
    readNodeIds: dedupe(nodeUsage?.readBy ?? []),
    writeNodeIds: dedupe(nodeUsage?.writtenBy ?? []),
    evidenceIds: dedupe(evidenceByPointer.get(variable.sourcePointer) ?? []),
  };
}

/**
 * `evidence.ts`'s `dependencyEvidence` appends exactly one evidence record
 * per dependency, in `dependencies` order, as the last block of the evidence
 * array `buildEvidence` returns. That ordering contract is what lets this
 * function recover, for each dependency by position, the one evidence
 * record that cites it — without re-deriving the `/manifest/<type>/<index>`
 * pointer `evidence.ts` computes internally.
 */
function dependencyEvidenceIds(
  evidence: readonly Evidence[],
  dependencyCount: number,
): readonly (string | undefined)[] {
  const start = evidence.length - dependencyCount;
  const ids: (string | undefined)[] = [];
  for (let i = 0; i < dependencyCount; i += 1) {
    ids.push(evidence[start + i]?.evidenceId);
  }
  return ids;
}

function toSnapshotDependency(
  dependency: ExtractedDependency,
  evidenceId: string | undefined,
): FlowSnapshotDependency {
  return {
    dependencyId: dependency.dependencyId,
    type: dependency.type,
    displayName: dependency.displayName,
    resolutionStatus: dependency.resolutionStatus,
    referencedByNodeIds: dedupe(dependency.referencedByNodeIds),
    evidenceIds: evidenceId !== undefined ? [evidenceId] : [],
    ...(dependency.nonNodeContexts.length > 0
      ? { safeMetadata: { nonNodeContexts: dependency.nonNodeContexts } }
      : {}),
  };
}

/**
 * Converts a `NormalizationWarning` into the schema's `$defs.finding` shape.
 * `finding` has no room for `path` or `nodeIds` (`additionalProperties:
 * false`), so both are folded into `message` — still built entirely from
 * structural identifiers the warning itself already restricted itself to,
 * never tenant-authored text, so folding them in adds no new prompt-injection
 * surface. `evidenceIds` is always `[]`: no extractor attaches an evidence
 * record to a warning today, and the schema does not require one.
 */
function toSnapshotFinding(warning: NormalizationWarning): FlowSnapshotFinding {
  const parts = [warning.message];
  if (warning.path !== null) parts.push(`path: ${warning.path}`);
  if (warning.nodeIds.length > 0) parts.push(`nodes: ${warning.nodeIds.join(', ')}`);
  return {
    code: warning.code,
    severity: warning.severity,
    message: parts.join(' | '),
    evidenceIds: [],
  };
}

function computeCompleteness(
  nodes: readonly ExtractedNode[],
  edges: readonly ExtractedEdge[],
  dependencies: readonly ExtractedDependency[],
): FlowSnapshotCompleteness {
  const nodeIds = new Set(nodes.map((node) => node.nodeId));
  return {
    sourceObjectCount: nodes.length,
    representedObjectCount: nodes.filter((node) => node.supportLevel !== 'unsupported').length,
    unsupportedNodeCount: nodes.filter((node) => node.supportLevel === 'unsupported').length,
    opaqueNodeCount: nodes.filter((node) => node.supportLevel === 'opaque').length,
    danglingEdgeCount: edges.filter((edge) => !nodeIds.has(edge.from) || !nodeIds.has(edge.to))
      .length,
    unresolvedDependencyCount: dependencies.filter(
      (dependency) => dependency.resolutionStatus !== 'resolved',
    ).length,
  };
}

/**
 * Composes every extractor into one `FlowSnapshot` that validates against
 * `schemas/flow-snapshot.schema.json`. This is pure assembly: each
 * extractor's own module owns its extraction logic and is never
 * reimplemented here.
 *
 * `nodes` is threaded into `extractDependencies` and `extractEdges`
 * deliberately — both take raw GUID references and must resolve them into
 * the `trk_<n>`-shaped identity space `extractNodes` uses, or every
 * dependency and edge reference in the snapshot would dangle.
 */
export function normalizeFlow(input: NormalizeInput): FlowSnapshot {
  const cfg = parseFlowConfig(input.config);

  const { nodes, warnings: nodeWarnings } = extractNodes(cfg);
  const { dependencies, warnings: dependencyWarnings } = extractDependencies(cfg, nodes);
  const { edges, warnings: edgeWarnings } = extractEdges(cfg, nodes, dependencies);
  const { variables, warnings: variableWarnings } = extractVariables(cfg);
  const { promptRefsByNode, warnings: promptWarnings } = extractPromptReferences(
    cfg,
    nodes,
    dependencies,
  );
  const { settingsByNode, warnings: settingsWarnings } = extractSettings(cfg, nodes);
  const usage = indexVariableUsage(cfg, nodes);
  const evidence = buildEvidence(cfg, nodes, variables, dependencies);
  const warnings = finalizeWarnings([
    ...nodeWarnings,
    ...edgeWarnings,
    ...dependencyWarnings,
    ...variableWarnings,
    ...promptWarnings,
    ...settingsWarnings,
  ]);

  const evidenceByPointer = groupEvidenceByPointer(evidence);
  const { reads: variableReadsByNode, writes: variableWritesByNode } = invertVariableUsage(usage);
  const dependencyRefsByNode = invertDependencyReferences(dependencies);

  const graph: FlowSnapshotGraph = {
    entryNodeIds: computeEntryNodeIds(nodes, edges),
    nodes: nodes.map((node) =>
      toSnapshotNode(
        node,
        evidenceByPointer,
        variableReadsByNode,
        variableWritesByNode,
        dependencyRefsByNode,
        promptRefsByNode,
        settingsByNode,
      ),
    ),
    edges: edges.map(toSnapshotEdge),
  };

  const depEvidenceIds = dependencyEvidenceIds(evidence, dependencies.length);

  return {
    schemaVersion: '1.1',
    snapshotId: `${input.flow.id}@${String(input.flow.version.selected)}`,
    source: input.source,
    flow: input.flow,
    graph,
    variables: variables.map((variable) => toSnapshotVariable(variable, usage, evidenceByPointer)),
    dependencies: dependencies.map((dependency, index) =>
      toSnapshotDependency(dependency, depEvidenceIds[index]),
    ),
    evidence,
    warnings: warnings.map(toSnapshotFinding),
    completeness: computeCompleteness(nodes, edges, dependencies),
    hashes: {
      canonicalizerVersion: CANONICALIZER_VERSION,
      normalizedGraph: contentHash(graph, CANONICAL_OPTIONS),
    },
  };
}
