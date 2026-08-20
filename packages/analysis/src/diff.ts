// @genesys-archivist/analysis
// Semantic diff between two `FlowSnapshot`-shaped values. Pure: no filesystem,
// network, clock, or randomness. The same pair of snapshots always produces a
// byte-identical diff (see the determinism and self-diff tests in
// test/diff.test.ts).
//
// This module never imports `@genesys-archivist/normalization` directly --
// only `packages/domain` may be imported (enforced by eslint.config.mjs) --
// so every input type here is a structural mirror of the corresponding
// `FlowSnapshot*` type, wide enough that a real snapshot satisfies it and
// narrow enough that a hand-built fixture in a test needs no unrelated
// fields. `findings.ts` uses the same pattern for the same reason.
//
// AGENTS.md: flow names, prompt text, expressions, and similar tenant-authored
// strings are prompt-injection vectors and must never sit in a structural
// field a downstream consumer might mistake for identity. Every such string
// that must be carried at all is wrapped in `UntrustedText`, which is bounded
// on the way in. The classified `SemanticChange` layer goes further and
// carries no tenant text at all -- only the fact that a field changed.

/** How a matched node's identity was established. `trackingId` is the ADR-016
 * primary path: Architect's own stable, monotonically allocated id, present
 * on every node the real capture path observes. `derivedIdentity` covers
 * everything else the identity preference chain falls back to -- the raw
 * source GUID, or (if neither is present) a fully derived id computed from
 * structural position -- and is a strictly weaker claim: a derived id can
 * change when a node's array position changes even though the node itself
 * did not. A diff computed entirely on `trackingId` is the strongest claim
 * this package can make; one that had to fall back is reported as such so a
 * reviewer can weigh it accordingly. */
export type NodeIdentityBasis = 'trackingId' | 'derivedIdentity';

/** Tenant-controlled free text, explicitly typed as untrusted and bounded.
 * Never place a bare `string` carrying a flow name, node name, prompt label,
 * or similar in a field a consumer might read as structural. */
export interface UntrustedText {
  readonly kind: 'untrusted';
  readonly value: string;
}

const UNTRUSTED_TEXT_MAX_LENGTH = 500;

function untrustedText(
  value: string | null | undefined,
  maxLength: number,
): UntrustedText | undefined {
  if (value === null || value === undefined || value.length === 0) return undefined;
  const bounded = value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
  return { kind: 'untrusted', value: bounded };
}

// ---------------------------------------------------------------------------
// Structural input shapes (mirror FlowSnapshot; see packages/normalization).
// ---------------------------------------------------------------------------

export interface DiffNode {
  readonly nodeId: string;
  readonly trackingId: string | null;
  readonly kind: string;
  readonly sourceType: string;
  readonly name: string;
  readonly containerPath: readonly string[];
  readonly supportLevel: string;
  readonly variableReads: readonly string[];
  readonly variableWrites: readonly string[];
  readonly dependencyRefs: readonly string[];
  readonly promptRefs: readonly string[];
  readonly evidenceIds: readonly string[];
}

export interface DiffEdge {
  readonly edgeId: string;
  readonly from: string;
  readonly to: string;
  readonly role: string;
  readonly label?: string;
  readonly condition: string | null;
  readonly evidenceIds: readonly string[];
}

export interface DiffVariable {
  readonly variableId: string;
  readonly name: string;
  readonly scope: string;
  readonly dataType: string;
  readonly direction: string;
  readonly secure: boolean;
  readonly readNodeIds: readonly string[];
  readonly writeNodeIds: readonly string[];
  readonly evidenceIds: readonly string[];
}

export interface DiffDependency {
  readonly dependencyId: string;
  readonly type: string;
  readonly displayName: string | null;
  readonly resolutionStatus: string;
  readonly referencedByNodeIds: readonly string[];
  readonly evidenceIds: readonly string[];
}

/** Structural mirror of `FlowSnapshotFinding` (normalize.ts's `warnings`
 * entry shape). That array is hardcoded empty there today; another task is
 * populating it. This module never assumes it is present or non-empty. */
export interface DiffWarning {
  readonly code: string;
  readonly severity: string;
  readonly message: string;
  readonly evidenceIds: readonly string[];
}

export interface DiffFlowVersion {
  readonly selected: string | number;
  readonly state: string;
  readonly published?: string | number | null;
  readonly latestCheckedIn?: string | number | null;
  readonly workingCopyPresent?: boolean;
  readonly modifiedAt?: string | null;
}

export interface DiffFlow {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly secure: boolean;
  readonly version: DiffFlowVersion;
  readonly description?: string;
  readonly divisionId?: string | null;
  readonly divisionName?: string | null;
  readonly languages?: readonly string[];
}

export interface DiffGraph {
  readonly entryNodeIds: readonly string[];
  readonly nodes: readonly DiffNode[];
  readonly edges: readonly DiffEdge[];
}

/** Structural minimum this module needs from a snapshot. A real `FlowSnapshot`
 * satisfies this directly. */
export interface DiffSnapshot {
  readonly flow: DiffFlow;
  readonly graph: DiffGraph;
  readonly variables: readonly DiffVariable[];
  readonly dependencies: readonly DiffDependency[];
  readonly warnings?: readonly DiffWarning[];
  readonly hashes: { readonly normalizedGraph: string };
}

export interface DiffOptions {
  /** Overrides the default bound applied to every `UntrustedText` value this
   * diff produces. Exists for tests; production callers should not need it. */
  readonly untrustedTextMaxLength?: number;
}

// ---------------------------------------------------------------------------
// Node identity matching.
// ---------------------------------------------------------------------------

export interface NodeMatch {
  readonly beforeNodeId: string;
  readonly afterNodeId: string;
  readonly basis: NodeIdentityBasis;
}

/** `'mixed'` when some matches used `trackingId` and others fell back;
 * `'none'` when no node matched by identity at all (every node was added or
 * removed). Reported at the top of the diff so a caller never has to inspect
 * every match to learn how certain the whole comparison is. */
export type DiffMatchBasis = 'trackingId' | 'derivedIdentity' | 'mixed' | 'none';

export interface DiffMatching {
  readonly overallBasis: DiffMatchBasis;
  readonly matches: readonly NodeMatch[];
}

/**
 * Matches nodes between two snapshots by identity, never by position or
 * display name.
 *
 * `nodeId` (see `derive-node-id.ts` and `extract-nodes.ts`'s identity
 * preference chain) is already `trk_<trackingId>` when a tracking id is
 * present, so it is *itself* stable across a capture that changed nothing
 * about the node -- reordering the source configuration cannot change it.
 * Plain `nodeId` equality is therefore the entire matching algorithm; the
 * only work left is reporting *how strong* each match's claim is, which
 * matters because a node identified only by a fully derived id (no tracking
 * id, no source GUID) genuinely does lose its identity across a reorder --
 * that is the ADR-016 tradeoff this field exists to make visible, not to
 * paper over. Two nodes sharing a display name are never matched by that
 * name; a node's `name` never participates in this function at all.
 */
export function matchNodes(before: readonly DiffNode[], after: readonly DiffNode[]): DiffMatching {
  const beforeById = new Map(before.map((n) => [n.nodeId, n] as const));
  const matches: NodeMatch[] = [];

  for (const afterNode of after) {
    const beforeNode = beforeById.get(afterNode.nodeId);
    if (beforeNode === undefined) continue;
    const basis: NodeIdentityBasis =
      beforeNode.trackingId !== null && afterNode.trackingId !== null
        ? 'trackingId'
        : 'derivedIdentity';
    matches.push({ beforeNodeId: beforeNode.nodeId, afterNodeId: afterNode.nodeId, basis });
  }

  matches.sort((a, b) => compareStrings(a.afterNodeId, b.afterNodeId));

  const bases = new Set(matches.map((m) => m.basis));
  const overallBasis: DiffMatchBasis =
    matches.length === 0
      ? 'none'
      : bases.size > 1
        ? 'mixed'
        : (bases.values().next().value ?? 'none');

  return { overallBasis, matches };
}

// ---------------------------------------------------------------------------
// Shared helpers.
// ---------------------------------------------------------------------------

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function sortBy<T>(items: readonly T[], key: (item: T) => string): readonly T[] {
  return [...items].sort((a, b) => compareStrings(key(a), key(b)));
}

/** Order-insensitive equality: the field is a set in substance (Architect
 * places no meaning on the order `variableReads` etc. were collected in),
 * mirroring `contentHash`'s default array handling in canonical.ts. */
function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

/** Order-sensitive equality, for fields (like `containerPath`) whose order is
 * itself part of what they mean. */
function sameArray(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

// ---------------------------------------------------------------------------
// Diff sets: added / removed / changed, each entry citable both ways.
// ---------------------------------------------------------------------------

export interface DiffSet<T> {
  readonly added: readonly T[];
  readonly removed: readonly T[];
  readonly changed: readonly T[];
}

export interface NodeDiffEntry {
  readonly beforeNodeId: string | null;
  readonly afterNodeId: string | null;
  readonly basis: NodeIdentityBasis | 'unmatched';
  readonly sourceType: string | null;
  readonly kind: string | null;
  readonly changedFields: readonly string[];
  readonly evidenceIdsBefore: readonly string[];
  readonly evidenceIdsAfter: readonly string[];
  readonly untrustedNameBefore?: UntrustedText;
  readonly untrustedNameAfter?: UntrustedText;
}

const NODE_FIELD_COMPARISONS: readonly {
  readonly field: string;
  readonly same: (b: DiffNode, a: DiffNode) => boolean;
}[] = [
  { field: 'name', same: (b, a) => b.name === a.name },
  { field: 'containerPath', same: (b, a) => sameArray(b.containerPath, a.containerPath) },
  { field: 'sourceType', same: (b, a) => b.sourceType === a.sourceType },
  { field: 'supportLevel', same: (b, a) => b.supportLevel === a.supportLevel },
  { field: 'variableReads', same: (b, a) => sameSet(b.variableReads, a.variableReads) },
  { field: 'variableWrites', same: (b, a) => sameSet(b.variableWrites, a.variableWrites) },
  { field: 'dependencyRefs', same: (b, a) => sameSet(b.dependencyRefs, a.dependencyRefs) },
  { field: 'promptRefs', same: (b, a) => sameSet(b.promptRefs, a.promptRefs) },
];

function computeNodeChangedFields(before: DiffNode, after: DiffNode): readonly string[] {
  return NODE_FIELD_COMPARISONS.filter((c) => !c.same(before, after)).map((c) => c.field);
}

function makeNodeEntry(
  before: DiffNode | null,
  after: DiffNode | null,
  basis: NodeIdentityBasis | 'unmatched',
  maxLength: number,
  changedFields: readonly string[] = [],
): NodeDiffEntry {
  const nameBefore = untrustedText(before?.name, maxLength);
  const nameAfter = untrustedText(after?.name, maxLength);
  return {
    beforeNodeId: before?.nodeId ?? null,
    afterNodeId: after?.nodeId ?? null,
    basis,
    sourceType: after?.sourceType ?? before?.sourceType ?? null,
    kind: after?.kind ?? before?.kind ?? null,
    changedFields,
    evidenceIdsBefore: before?.evidenceIds ?? [],
    evidenceIdsAfter: after?.evidenceIds ?? [],
    ...(nameBefore !== undefined ? { untrustedNameBefore: nameBefore } : {}),
    ...(nameAfter !== undefined ? { untrustedNameAfter: nameAfter } : {}),
  };
}

function nodeEntryKey(e: NodeDiffEntry): string {
  return `${e.afterNodeId ?? ''} ${e.beforeNodeId ?? ''}`;
}

function diffNodes(
  before: readonly DiffNode[],
  after: readonly DiffNode[],
  matching: DiffMatching,
  maxLength: number,
): DiffSet<NodeDiffEntry> {
  const beforeById = new Map(before.map((n) => [n.nodeId, n] as const));
  const afterById = new Map(after.map((n) => [n.nodeId, n] as const));
  const matchedAfterIds = new Set(matching.matches.map((m) => m.afterNodeId));
  const matchedBeforeIds = new Set(matching.matches.map((m) => m.beforeNodeId));

  const added = after
    .filter((n) => !matchedAfterIds.has(n.nodeId))
    .map((n) => makeNodeEntry(null, n, 'unmatched', maxLength));
  const removed = before
    .filter((n) => !matchedBeforeIds.has(n.nodeId))
    .map((n) => makeNodeEntry(n, null, 'unmatched', maxLength));

  const changed: NodeDiffEntry[] = [];
  for (const m of matching.matches) {
    const b = beforeById.get(m.beforeNodeId);
    const a = afterById.get(m.afterNodeId);
    if (b === undefined || a === undefined) continue;
    const changedFields = computeNodeChangedFields(b, a);
    if (changedFields.length > 0)
      changed.push(makeNodeEntry(b, a, m.basis, maxLength, changedFields));
  }

  return {
    added: sortBy(added, nodeEntryKey),
    removed: sortBy(removed, nodeEntryKey),
    changed: sortBy(changed, nodeEntryKey),
  };
}

// ---------------------------------------------------------------------------
// Edges. edgeId already embeds (from, to, role) plus a structural site
// disambiguator (extract-edges.ts), so exact edgeId equality is itself an
// identity-strength match wherever the endpoints' node identity is stable --
// no separate node-translation step is needed. `label` is the one field an
// exactly-matched edge can still differ on. A reroute -- the same logical
// choice or path now pointing somewhere else -- changes `to` and therefore
// `edgeId` itself, so it appears as a same-slot (from, role) removed+added
// pair, which the correlation pass below re-pairs into one entry.
// ---------------------------------------------------------------------------

export interface EdgeDiffEntry {
  readonly beforeEdgeId: string | null;
  readonly afterEdgeId: string | null;
  readonly role: string | null;
  readonly fromNodeId: string | null;
  readonly toNodeId: string | null;
  readonly changedFields: readonly string[];
  readonly evidenceIdsBefore: readonly string[];
  readonly evidenceIdsAfter: readonly string[];
  readonly untrustedLabelBefore?: UntrustedText;
  readonly untrustedLabelAfter?: UntrustedText;
  readonly untrustedConditionBefore?: UntrustedText;
  readonly untrustedConditionAfter?: UntrustedText;
}

function makeEdgeEntry(
  before: DiffEdge | null,
  after: DiffEdge | null,
  maxLength: number,
  changedFields: readonly string[] = [],
): EdgeDiffEntry {
  const labelBefore = untrustedText(before?.label, maxLength);
  const labelAfter = untrustedText(after?.label, maxLength);
  const conditionBefore = untrustedText(before?.condition, maxLength);
  const conditionAfter = untrustedText(after?.condition, maxLength);
  return {
    beforeEdgeId: before?.edgeId ?? null,
    afterEdgeId: after?.edgeId ?? null,
    role: after?.role ?? before?.role ?? null,
    fromNodeId: after?.from ?? before?.from ?? null,
    toNodeId: after?.to ?? before?.to ?? null,
    changedFields,
    evidenceIdsBefore: before?.evidenceIds ?? [],
    evidenceIdsAfter: after?.evidenceIds ?? [],
    ...(labelBefore !== undefined ? { untrustedLabelBefore: labelBefore } : {}),
    ...(labelAfter !== undefined ? { untrustedLabelAfter: labelAfter } : {}),
    ...(conditionBefore !== undefined ? { untrustedConditionBefore: conditionBefore } : {}),
    ...(conditionAfter !== undefined ? { untrustedConditionAfter: conditionAfter } : {}),
  };
}

function edgeEntryKey(e: EdgeDiffEntry): string {
  return `${e.afterEdgeId ?? ''} ${e.beforeEdgeId ?? ''}`;
}

function slotKey(fromNodeId: string, role: string): string {
  return `${fromNodeId} ${role}`;
}

function diffEdges(
  before: readonly DiffEdge[],
  after: readonly DiffEdge[],
  maxLength: number,
): DiffSet<EdgeDiffEntry> {
  const beforeById = new Map(before.map((e) => [e.edgeId, e] as const));
  const afterById = new Map(after.map((e) => [e.edgeId, e] as const));

  const changed: EdgeDiffEntry[] = [];
  const leftoverBefore: DiffEdge[] = [];
  const leftoverAfter: DiffEdge[] = [];

  for (const b of before) {
    const a = afterById.get(b.edgeId);
    if (a === undefined) {
      leftoverBefore.push(b);
      continue;
    }
    if (b.label !== a.label) changed.push(makeEdgeEntry(b, a, maxLength, ['label']));
  }
  for (const a of after) {
    if (!beforeById.has(a.edgeId)) leftoverAfter.push(a);
  }

  // Reroute correlation: within the same (from, role) slot, a single leftover
  // removal paired with a single leftover addition is treated as one edge
  // that changed target/condition/label rather than an unrelated pair of
  // events. A slot with more than one candidate on either side is genuinely
  // ambiguous -- which choice replaced which -- and is left as separate add
  // and remove entries rather than guessed at.
  const removedBySlot = new Map<string, DiffEdge[]>();
  for (const e of leftoverBefore) {
    const key = slotKey(e.from, e.role);
    const list = removedBySlot.get(key);
    if (list === undefined) removedBySlot.set(key, [e]);
    else list.push(e);
  }
  const addedBySlot = new Map<string, DiffEdge[]>();
  for (const e of leftoverAfter) {
    const key = slotKey(e.from, e.role);
    const list = addedBySlot.get(key);
    if (list === undefined) addedBySlot.set(key, [e]);
    else list.push(e);
  }

  const correlatedBefore = new Set<string>();
  const correlatedAfter = new Set<string>();
  for (const [key, removedList] of removedBySlot) {
    const addedList = addedBySlot.get(key);
    if (addedList === undefined || removedList.length !== 1 || addedList.length !== 1) continue;
    const b = removedList[0];
    const a = addedList[0];
    if (b === undefined || a === undefined) continue;
    const fields: string[] = [];
    if (b.to !== a.to) fields.push('to');
    if (b.condition !== a.condition) fields.push('condition');
    if (b.label !== a.label) fields.push('label');
    changed.push(makeEdgeEntry(b, a, maxLength, fields));
    correlatedBefore.add(b.edgeId);
    correlatedAfter.add(a.edgeId);
  }

  const added = leftoverAfter
    .filter((e) => !correlatedAfter.has(e.edgeId))
    .map((e) => makeEdgeEntry(null, e, maxLength));
  const removed = leftoverBefore
    .filter((e) => !correlatedBefore.has(e.edgeId))
    .map((e) => makeEdgeEntry(e, null, maxLength));

  return {
    added: sortBy(added, edgeEntryKey),
    removed: sortBy(removed, edgeEntryKey),
    changed: sortBy(changed, edgeEntryKey),
  };
}

// ---------------------------------------------------------------------------
// Variables. `variableId` is Architect's own GUID (extract-variables.ts),
// stable regardless of declaration order, so plain id equality is the whole
// match -- no basis tracking needed, unlike nodes.
// ---------------------------------------------------------------------------

export interface VariableDiffEntry {
  readonly beforeVariableId: string | null;
  readonly afterVariableId: string | null;
  readonly scope: string | null;
  readonly dataType: string | null;
  /** `true` if either side marks this variable secure. Structural (a plain
   * boolean, never the value), and surfaced so change-classification.ts can
   * route a secure variable's change to security-sensitive review rather
   * than the default behavioral level. */
  readonly secure: boolean;
  readonly changedFields: readonly string[];
  readonly evidenceIdsBefore: readonly string[];
  readonly evidenceIdsAfter: readonly string[];
  readonly untrustedNameBefore?: UntrustedText;
  readonly untrustedNameAfter?: UntrustedText;
}

function makeVariableEntry(
  before: DiffVariable | null,
  after: DiffVariable | null,
  maxLength: number,
  changedFields: readonly string[] = [],
): VariableDiffEntry {
  const nameBefore = untrustedText(before?.name, maxLength);
  const nameAfter = untrustedText(after?.name, maxLength);
  return {
    beforeVariableId: before?.variableId ?? null,
    afterVariableId: after?.variableId ?? null,
    scope: after?.scope ?? before?.scope ?? null,
    dataType: after?.dataType ?? before?.dataType ?? null,
    secure: (before?.secure ?? false) || (after?.secure ?? false),
    changedFields,
    evidenceIdsBefore: before?.evidenceIds ?? [],
    evidenceIdsAfter: after?.evidenceIds ?? [],
    ...(nameBefore !== undefined ? { untrustedNameBefore: nameBefore } : {}),
    ...(nameAfter !== undefined ? { untrustedNameAfter: nameAfter } : {}),
  };
}

function variableEntryKey(e: VariableDiffEntry): string {
  return `${e.afterVariableId ?? ''} ${e.beforeVariableId ?? ''}`;
}

function diffVariables(
  before: readonly DiffVariable[],
  after: readonly DiffVariable[],
  maxLength: number,
): DiffSet<VariableDiffEntry> {
  const beforeById = new Map(before.map((v) => [v.variableId, v] as const));
  const afterById = new Map(after.map((v) => [v.variableId, v] as const));

  const added = after
    .filter((v) => !beforeById.has(v.variableId))
    .map((v) => makeVariableEntry(null, v, maxLength));
  const removed = before
    .filter((v) => !afterById.has(v.variableId))
    .map((v) => makeVariableEntry(v, null, maxLength));

  const changed: VariableDiffEntry[] = [];
  for (const b of before) {
    const a = afterById.get(b.variableId);
    if (a === undefined) continue;
    const fields: string[] = [];
    if (b.name !== a.name) fields.push('name');
    if (b.scope !== a.scope) fields.push('scope');
    if (b.dataType !== a.dataType) fields.push('dataType');
    if (b.direction !== a.direction) fields.push('direction');
    if (b.secure !== a.secure) fields.push('secure');
    if (!sameSet(b.readNodeIds, a.readNodeIds)) fields.push('readNodeIds');
    if (!sameSet(b.writeNodeIds, a.writeNodeIds)) fields.push('writeNodeIds');
    if (fields.length > 0) changed.push(makeVariableEntry(b, a, maxLength, fields));
  }

  return {
    added: sortBy(added, variableEntryKey),
    removed: sortBy(removed, variableEntryKey),
    changed: sortBy(changed, variableEntryKey),
  };
}

// ---------------------------------------------------------------------------
// Dependencies. `dependencyId` is the manifest entry's own id (S3), stable
// regardless of manifest ordering -- again no basis tracking needed.
// ---------------------------------------------------------------------------

export interface DependencyDiffEntry {
  readonly beforeDependencyId: string | null;
  readonly afterDependencyId: string | null;
  readonly type: string | null;
  readonly changedFields: readonly string[];
  readonly evidenceIdsBefore: readonly string[];
  readonly evidenceIdsAfter: readonly string[];
  readonly untrustedDisplayNameBefore?: UntrustedText;
  readonly untrustedDisplayNameAfter?: UntrustedText;
}

function makeDependencyEntry(
  before: DiffDependency | null,
  after: DiffDependency | null,
  maxLength: number,
  changedFields: readonly string[] = [],
): DependencyDiffEntry {
  const displayNameBefore = untrustedText(before?.displayName, maxLength);
  const displayNameAfter = untrustedText(after?.displayName, maxLength);
  return {
    beforeDependencyId: before?.dependencyId ?? null,
    afterDependencyId: after?.dependencyId ?? null,
    type: after?.type ?? before?.type ?? null,
    changedFields,
    evidenceIdsBefore: before?.evidenceIds ?? [],
    evidenceIdsAfter: after?.evidenceIds ?? [],
    ...(displayNameBefore !== undefined ? { untrustedDisplayNameBefore: displayNameBefore } : {}),
    ...(displayNameAfter !== undefined ? { untrustedDisplayNameAfter: displayNameAfter } : {}),
  };
}

function dependencyEntryKey(e: DependencyDiffEntry): string {
  return `${e.afterDependencyId ?? ''} ${e.beforeDependencyId ?? ''}`;
}

function diffDependencies(
  before: readonly DiffDependency[],
  after: readonly DiffDependency[],
  maxLength: number,
): DiffSet<DependencyDiffEntry> {
  const beforeById = new Map(before.map((d) => [d.dependencyId, d] as const));
  const afterById = new Map(after.map((d) => [d.dependencyId, d] as const));

  const added = after
    .filter((d) => !beforeById.has(d.dependencyId))
    .map((d) => makeDependencyEntry(null, d, maxLength));
  const removed = before
    .filter((d) => !afterById.has(d.dependencyId))
    .map((d) => makeDependencyEntry(d, null, maxLength));

  const changed: DependencyDiffEntry[] = [];
  for (const b of before) {
    const a = afterById.get(b.dependencyId);
    if (a === undefined) continue;
    const fields: string[] = [];
    if (b.type !== a.type) fields.push('type');
    if (b.displayName !== a.displayName) fields.push('displayName');
    if (b.resolutionStatus !== a.resolutionStatus) fields.push('resolutionStatus');
    if (!sameSet(b.referencedByNodeIds, a.referencedByNodeIds)) fields.push('referencedByNodeIds');
    if (fields.length > 0) changed.push(makeDependencyEntry(b, a, maxLength, fields));
  }

  return {
    added: sortBy(added, dependencyEntryKey),
    removed: sortBy(removed, dependencyEntryKey),
    changed: sortBy(changed, dependencyEntryKey),
  };
}

// ---------------------------------------------------------------------------
// Prompts. There is no separate "prompt" collection on FlowSnapshot yet --
// only each node's `promptRefs` -- so a prompt-reference change is reported
// per (node, promptId) pair, for nodes matched between the two snapshots.
// Always empty today (normalize.ts hardcodes `promptRefs: []`); this is
// still fully implemented so it does the right thing the day that changes.
// ---------------------------------------------------------------------------

export interface PromptDiffEntry {
  readonly nodeId: string;
  readonly promptId: string;
  readonly operation: 'added' | 'removed';
  readonly evidenceIdsBefore: readonly string[];
  readonly evidenceIdsAfter: readonly string[];
}

function promptEntryKey(e: PromptDiffEntry): string {
  return `${e.nodeId} ${e.promptId} ${e.operation}`;
}

function diffPrompts(
  before: readonly DiffNode[],
  after: readonly DiffNode[],
  matching: DiffMatching,
): DiffSet<PromptDiffEntry> {
  const beforeById = new Map(before.map((n) => [n.nodeId, n] as const));
  const afterById = new Map(after.map((n) => [n.nodeId, n] as const));

  const added: PromptDiffEntry[] = [];
  const removed: PromptDiffEntry[] = [];

  for (const m of matching.matches) {
    const b = beforeById.get(m.beforeNodeId);
    const a = afterById.get(m.afterNodeId);
    if (b === undefined || a === undefined) continue;
    const beforeRefs = new Set(b.promptRefs);
    const afterRefs = new Set(a.promptRefs);
    for (const promptId of a.promptRefs) {
      if (!beforeRefs.has(promptId)) {
        added.push({
          nodeId: a.nodeId,
          promptId,
          operation: 'added',
          evidenceIdsBefore: [],
          evidenceIdsAfter: a.evidenceIds,
        });
      }
    }
    for (const promptId of b.promptRefs) {
      if (!afterRefs.has(promptId)) {
        removed.push({
          nodeId: b.nodeId,
          promptId,
          operation: 'removed',
          evidenceIdsBefore: b.evidenceIds,
          evidenceIdsAfter: [],
        });
      }
    }
  }

  return {
    added: sortBy(added, promptEntryKey),
    removed: sortBy(removed, promptEntryKey),
    changed: [],
  };
}

// ---------------------------------------------------------------------------
// The eleven docs/07 semantic-diff categories, as a closed union. A category
// this module cannot place is `unclassified-change` -- AGENTS.md forbids
// silently dropping a change, so an unrecognised shape is reported, not
// omitted. `@typescript-eslint/switch-exhaustiveness-check` forces every
// `switch (change.category)` in this package (and in change-classification.ts)
// to handle all twelve, so a category added here without a classification
// rule fails the build rather than falling through unnoticed.
// ---------------------------------------------------------------------------

export type ChangeOperation = 'added' | 'removed' | 'changed';

interface SemanticChangeCommon {
  readonly operation: ChangeOperation;
  readonly evidenceIdsBefore: readonly string[];
  readonly evidenceIdsAfter: readonly string[];
}

export interface FlowMetadataChanged extends SemanticChangeCommon {
  readonly category: 'flow-metadata-changed';
  readonly field:
    'name' | 'description' | 'type' | 'secure' | 'divisionId' | 'divisionName' | 'languages';
}

export interface EntryPointChanged extends SemanticChangeCommon {
  readonly category: 'entry-point-changed';
  readonly nodeId: string;
  readonly basis: NodeIdentityBasis | 'unmatched';
}

export interface MenuChoiceChanged extends SemanticChangeCommon {
  readonly category: 'menu-choice-changed';
  readonly fromNodeId: string;
  readonly aspect: 'presence' | 'label' | 'route';
}

export interface ActionChanged extends SemanticChangeCommon {
  readonly category: 'action-changed';
  readonly nodeId: string;
  readonly basis: NodeIdentityBasis | 'unmatched';
  readonly aspect: 'presence' | 'position' | 'reconfigured' | 'relabeled';
}

export interface ConditionExpressionChanged extends SemanticChangeCommon {
  readonly category: 'condition-expression-changed';
  readonly fromNodeId: string;
}

export interface VariableChanged extends SemanticChangeCommon {
  readonly category: 'variable-changed';
  readonly variableId: string;
  readonly aspect: 'presence' | 'type' | 'usage-location';
  /** Carried through from `VariableDiffEntry.secure` so a secure variable's
   * change can be routed to security-sensitive review. */
  readonly secure: boolean;
}

export interface PromptReferenceChanged extends SemanticChangeCommon {
  readonly category: 'prompt-reference-changed';
  readonly subject:
    { readonly kind: 'node'; readonly nodeId: string } | { readonly kind: 'flow-languages' };
}

export interface DependencyChanged extends SemanticChangeCommon {
  readonly category: 'dependency-changed';
  readonly dependencyId: string;
  /** The manifest category this dependency belongs to (e.g. `queue`,
   * `dataAction`) -- structural, from the manifest's own key space
   * (extract-dependencies.ts), not tenant free text. Lets a consumer such
   * as change-classification.ts distinguish an ordinary integration
   * reference from an auth-related one without re-deriving it. */
  readonly dependencyType: string | null;
  readonly aspect: 'presence' | 'reference' | 'resolution' | 'displayName';
}

export interface OutcomePathChanged extends SemanticChangeCommon {
  readonly category: 'outcome-path-changed';
  readonly fromNodeId: string;
  /** The recognised outcome vocabulary this edge's `role` matched (e.g.
   * `no_match`, `timeout`) -- a bounded, Architect-controlled string, not
   * tenant free text. */
  readonly outcomeKind: string;
}

export interface PublishedVersionOnlyChanged extends SemanticChangeCommon {
  readonly category: 'published-version-only-changed';
}

export interface CoverageChanged extends SemanticChangeCommon {
  readonly category: 'coverage-changed';
  readonly nodeId: string | null;
  readonly basis: NodeIdentityBasis | 'unmatched' | null;
  readonly direction: 'regressed' | 'improved';
  readonly beforeSupportLevel: string | null;
  readonly afterSupportLevel: string | null;
}

/** The escape hatch AGENTS.md requires: a structural difference this module
 * detected but could not place in one of the eleven documented categories.
 * `note` is a structural description this module wrote itself (a field name,
 * a role string) -- never tenant text. */
export interface UnclassifiedChanged extends SemanticChangeCommon {
  readonly category: 'unclassified-change';
  readonly note: string;
}

export type SemanticChange =
  | FlowMetadataChanged
  | EntryPointChanged
  | MenuChoiceChanged
  | ActionChanged
  | ConditionExpressionChanged
  | VariableChanged
  | PromptReferenceChanged
  | DependencyChanged
  | OutcomePathChanged
  | PublishedVersionOnlyChanged
  | CoverageChanged
  | UnclassifiedChanged;

/** Recognised outcome-path vocabulary (docs/07's "Success/failure/timeout/
 * no-input/no-match path changed"). `branchRole` in extract-edges.ts strips
 * the `__...__` wrapper and lowercases, so Architect's `__NO_MATCH__` arrives
 * here as `no_match`; both the underscore and hyphen spellings are accepted
 * since nothing yet pins which one a given Architect release emits. */
const OUTCOME_ROLES: ReadonlySet<string> = new Set([
  'success',
  'failure',
  'timeout',
  'no-input',
  'no_input',
  'no-match',
  'no_match',
]);

/** Edge roles that are themselves node-identifying structural facts
 * (extract-edges.ts), as opposed to a decision's data-driven branch
 * discriminator. Used to decide whether an edge-level change belongs under
 * `menu-choice-changed` / `action-changed` / `outcome-path-changed`, or is a
 * `DecisionAction`-style branch whose condition can change independently of
 * its target. */
const STRUCTURAL_EDGE_ROLES: ReadonlySet<string> = new Set([
  'entry',
  'next',
  'transfer-menu',
  'transfer-task',
  'menu-choice',
]);

function changeSortKey(c: SemanticChange): string {
  const subject = changeSubjectKey(c);
  return `${c.category} ${c.operation} ${subject}`;
}

/** One string per category identifying what the change is about, purely for
 * deterministic ordering -- never surfaced as the change's meaning. The
 * switch is exhaustive over the same closed union `classifyChanges` (in
 * change-classification.ts) switches over, so a new category fails both
 * builds until handled in both places. */
function changeSubjectKey(c: SemanticChange): string {
  switch (c.category) {
    case 'flow-metadata-changed':
      return c.field;
    case 'entry-point-changed':
      return c.nodeId;
    case 'menu-choice-changed':
      return `${c.fromNodeId} ${c.aspect}`;
    case 'action-changed':
      return `${c.nodeId} ${c.aspect}`;
    case 'condition-expression-changed':
      return c.fromNodeId;
    case 'variable-changed':
      return `${c.variableId} ${c.aspect}`;
    case 'prompt-reference-changed':
      return c.subject.kind === 'node' ? c.subject.nodeId : 'flow-languages';
    case 'dependency-changed':
      return `${c.dependencyId} ${c.aspect}`;
    case 'outcome-path-changed':
      return `${c.fromNodeId} ${c.outcomeKind}`;
    case 'published-version-only-changed':
      return '';
    case 'coverage-changed':
      return c.nodeId ?? '';
    case 'unclassified-change':
      return c.note;
  }
}

function classifyEdgeChange(entry: EdgeDiffEntry): SemanticChange {
  const operation: ChangeOperation =
    entry.beforeEdgeId === null ? 'added' : entry.afterEdgeId === null ? 'removed' : 'changed';
  const common = {
    operation,
    evidenceIdsBefore: entry.evidenceIdsBefore,
    evidenceIdsAfter: entry.evidenceIdsAfter,
  };
  const role = entry.role ?? '';
  const fromNodeId = entry.fromNodeId ?? '';

  if (role === 'menu-choice') {
    const aspect: MenuChoiceChanged['aspect'] =
      operation !== 'changed' ? 'presence' : entry.changedFields.includes('to') ? 'route' : 'label';
    return { category: 'menu-choice-changed', fromNodeId, aspect, ...common };
  }

  if (OUTCOME_ROLES.has(role)) {
    return { category: 'outcome-path-changed', fromNodeId, outcomeKind: role, ...common };
  }

  if (!STRUCTURAL_EDGE_ROLES.has(role)) {
    // A DecisionAction-style branch (`yes` / `no` / `default` / a custom
    // branch name). Its condition is the branch discriminator itself
    // (extract-edges.ts's `branchRole`/`condition`), so a same-slot change
    // that altered only the condition is the flow's decision logic changing,
    // not merely which node it points at.
    if (operation === 'changed' && entry.changedFields.includes('condition')) {
      return { category: 'condition-expression-changed', fromNodeId, ...common };
    }
    const aspect: ActionChanged['aspect'] =
      operation !== 'changed'
        ? 'reconfigured'
        : entry.changedFields.includes('to')
          ? 'reconfigured'
          : 'relabeled';
    return {
      category: 'action-changed',
      nodeId: fromNodeId,
      basis: 'unmatched',
      aspect,
      ...common,
    };
  }

  // entry / next / transfer-menu / transfer-task: sequencing or an internal
  // jump target, not an external dependency (journeys.ts treats these as
  // intra-flow navigation, not hand-offs) and not a menu choice.
  const aspect: ActionChanged['aspect'] =
    operation !== 'changed'
      ? 'position'
      : entry.changedFields.includes('to')
        ? 'position'
        : 'relabeled';
  return {
    category: 'action-changed',
    nodeId: fromNodeId,
    basis: 'unmatched',
    aspect,
    ...common,
  };
}

const SUPPORT_LEVEL_RANK: Readonly<Record<string, number>> = {
  full: 3,
  partial: 2,
  opaque: 1,
  unsupported: 0,
};

function coverageDirection(before: string, after: string): 'regressed' | 'improved' | null {
  const beforeRank = SUPPORT_LEVEL_RANK[before];
  const afterRank = SUPPORT_LEVEL_RANK[after];
  if (beforeRank === undefined || afterRank === undefined || beforeRank === afterRank) return null;
  return afterRank < beforeRank ? 'regressed' : 'improved';
}

/** Warning codes that name a coverage problem, independent of whatever the
 * `warnings` array's final shape turns out to be -- deliberately a pattern
 * match rather than a fixed code list, since this package must keep working
 * once that array is populated for real. */
function isCoverageWarningCode(code: string): boolean {
  return /UNSUPPORTED|OPAQUE|COVERAGE/i.test(code);
}

/**
 * Builds the classified `changes` list from the raw per-collection diff
 * sets, plus the flow-level and hash-level comparisons no single collection
 * entry can express on its own (flow metadata, entry points, published
 * version drift). This is the only place category assignment happens; the
 * DiffSet layer above stays purely structural.
 */
function buildSemanticChanges(
  before: DiffSnapshot,
  after: DiffSnapshot,
  matching: DiffMatching,
  nodes: DiffSet<NodeDiffEntry>,
  edges: DiffSet<EdgeDiffEntry>,
  variables: DiffSet<VariableDiffEntry>,
  dependencies: DiffSet<DependencyDiffEntry>,
): readonly SemanticChange[] {
  const changes: SemanticChange[] = [];

  // 1. Flow metadata changed.
  const metadataFields: FlowMetadataChanged['field'][] = [];
  if (before.flow.name !== after.flow.name) metadataFields.push('name');
  if ((before.flow.description ?? null) !== (after.flow.description ?? null))
    metadataFields.push('description');
  if (before.flow.type !== after.flow.type) metadataFields.push('type');
  if (before.flow.secure !== after.flow.secure) metadataFields.push('secure');
  if ((before.flow.divisionId ?? null) !== (after.flow.divisionId ?? null))
    metadataFields.push('divisionId');
  if ((before.flow.divisionName ?? null) !== (after.flow.divisionName ?? null))
    metadataFields.push('divisionName');
  if (!sameSet(before.flow.languages ?? [], after.flow.languages ?? []))
    metadataFields.push('languages');
  for (const field of metadataFields) {
    if (field === 'languages') {
      changes.push({
        category: 'prompt-reference-changed',
        operation: 'changed',
        subject: { kind: 'flow-languages' },
        evidenceIdsBefore: [],
        evidenceIdsAfter: [],
      });
    } else {
      changes.push({
        category: 'flow-metadata-changed',
        operation: 'changed',
        field,
        evidenceIdsBefore: [],
        evidenceIdsAfter: [],
      });
    }
  }

  // 2. Entry point or start container changed.
  const beforeEntries = new Set(before.graph.entryNodeIds);
  const afterEntries = new Set(after.graph.entryNodeIds);
  const matchedAfterToBefore = new Map(matching.matches.map((m) => [m.afterNodeId, m] as const));
  const matchedBeforeToAfter = new Map(matching.matches.map((m) => [m.beforeNodeId, m] as const));
  for (const nodeId of after.graph.entryNodeIds) {
    const match = matchedAfterToBefore.get(nodeId);
    const stillAnEntry = match !== undefined && beforeEntries.has(match.beforeNodeId);
    if (stillAnEntry) continue;
    changes.push({
      category: 'entry-point-changed',
      operation: 'added',
      nodeId,
      basis: match?.basis ?? 'unmatched',
      evidenceIdsBefore: [],
      evidenceIdsAfter: [],
    });
  }
  for (const nodeId of before.graph.entryNodeIds) {
    const match = matchedBeforeToAfter.get(nodeId);
    const stillAnEntry = match !== undefined && afterEntries.has(match.afterNodeId);
    if (stillAnEntry) continue;
    changes.push({
      category: 'entry-point-changed',
      operation: 'removed',
      nodeId,
      basis: match?.basis ?? 'unmatched',
      evidenceIdsBefore: [],
      evidenceIdsAfter: [],
    });
  }

  // 4 (part): node presence. Node *reconfiguration* (the `changed` set,
  // including coverage) is classified by `buildChanges`, which -- unlike
  // this function -- has the actual before/after node objects on hand and so
  // can report the two support levels a coverage change names.
  for (const entry of nodes.added) {
    changes.push(classifyNodePresence(entry, 'added'));
  }
  for (const entry of nodes.removed) {
    changes.push(classifyNodePresence(entry, 'removed'));
  }

  // 3, 4, 6.route, 9: edges.
  for (const entry of [...edges.added, ...edges.removed, ...edges.changed]) {
    changes.push(classifyEdgeChange(entry));
  }

  // 6. Variables.
  for (const entry of variables.added) {
    changes.push(makeVariableChange(entry, 'added', 'presence'));
  }
  for (const entry of variables.removed) {
    changes.push(makeVariableChange(entry, 'removed', 'presence'));
  }
  for (const entry of variables.changed) {
    const aspect: VariableChanged['aspect'] = entry.changedFields.includes('dataType')
      ? 'type'
      : entry.changedFields.includes('readNodeIds') || entry.changedFields.includes('writeNodeIds')
        ? 'usage-location'
        : 'usage-location';
    changes.push(makeVariableChange(entry, 'changed', aspect));
  }

  // 7. Prompt references carried per-node (flow.languages handled above).
  for (const nodeEntry of nodes.changed) {
    if (!nodeEntry.changedFields.includes('promptRefs')) continue;
    changes.push({
      category: 'prompt-reference-changed',
      operation: 'changed',
      subject: { kind: 'node', nodeId: nodeEntry.afterNodeId ?? nodeEntry.beforeNodeId ?? '' },
      evidenceIdsBefore: nodeEntry.evidenceIdsBefore,
      evidenceIdsAfter: nodeEntry.evidenceIdsAfter,
    });
  }

  // 8. Dependencies.
  for (const entry of dependencies.added) {
    changes.push(makeDependencyChange(entry, 'added', 'presence'));
  }
  for (const entry of dependencies.removed) {
    changes.push(makeDependencyChange(entry, 'removed', 'presence'));
  }
  for (const entry of dependencies.changed) {
    const aspect: DependencyChanged['aspect'] = entry.changedFields.includes('resolutionStatus')
      ? 'resolution'
      : entry.changedFields.includes('referencedByNodeIds')
        ? 'reference'
        : 'displayName';
    changes.push(makeDependencyChange(entry, 'changed', aspect));
  }

  // 10. Published version changed without semantic graph change. Only fires
  // when the graph hash agrees -- if it also changed, that is real content
  // and is already covered by the categories above.
  const versionChanged =
    before.flow.version.selected !== after.flow.version.selected ||
    before.flow.version.state !== after.flow.version.state ||
    (before.flow.version.published ?? null) !== (after.flow.version.published ?? null) ||
    (before.flow.version.latestCheckedIn ?? null) !== (after.flow.version.latestCheckedIn ?? null);
  if (versionChanged && before.hashes.normalizedGraph === after.hashes.normalizedGraph) {
    changes.push({
      category: 'published-version-only-changed',
      operation: 'changed',
      evidenceIdsBefore: [],
      evidenceIdsAfter: [],
    });
  }

  // 11 (continued). Coverage signalled through a newly added warning, for
  // whenever the `warnings` array carries real content -- independent of the
  // per-node supportLevel path above, since a warning need not name a node.
  const beforeWarnings = before.warnings ?? [];
  const afterWarnings = after.warnings ?? [];
  const beforeWarningKeys = new Set(beforeWarnings.map(warningKey));
  for (const w of afterWarnings) {
    if (beforeWarningKeys.has(warningKey(w))) continue;
    if (!isCoverageWarningCode(w.code)) continue;
    changes.push({
      category: 'coverage-changed',
      operation: 'added',
      nodeId: null,
      basis: null,
      direction: 'regressed',
      beforeSupportLevel: null,
      afterSupportLevel: null,
      evidenceIdsBefore: [],
      evidenceIdsAfter: w.evidenceIds,
    });
  }

  return sortBy(changes, changeSortKey);
}

function warningKey(w: DiffWarning): string {
  return `${w.code} ${w.severity} ${[...w.evidenceIds].sort().join(',')}`;
}

function classifyNodePresence(
  entry: NodeDiffEntry,
  operation: 'added' | 'removed',
): SemanticChange {
  const common = {
    operation,
    evidenceIdsBefore: entry.evidenceIdsBefore,
    evidenceIdsAfter: entry.evidenceIdsAfter,
  };
  const nodeId = entry.afterNodeId ?? entry.beforeNodeId ?? '';
  return { category: 'action-changed', nodeId, basis: entry.basis, aspect: 'presence', ...common };
}

function classifyNodeReconfigured(entry: NodeDiffEntry): SemanticChange {
  const common = {
    operation: 'changed' as const,
    evidenceIdsBefore: entry.evidenceIdsBefore,
    evidenceIdsAfter: entry.evidenceIdsAfter,
  };
  const nodeId = entry.afterNodeId ?? entry.beforeNodeId ?? '';
  const onlyCosmetic =
    entry.changedFields.length > 0 &&
    entry.changedFields.every((f) => f === 'name' || f === 'containerPath');
  const aspect: ActionChanged['aspect'] = onlyCosmetic ? 'relabeled' : 'reconfigured';
  return { category: 'action-changed', nodeId, basis: entry.basis, aspect, ...common };
}

function makeVariableChange(
  entry: VariableDiffEntry,
  operation: ChangeOperation,
  aspect: VariableChanged['aspect'],
): SemanticChange {
  return {
    category: 'variable-changed',
    operation,
    variableId: entry.afterVariableId ?? entry.beforeVariableId ?? '',
    aspect,
    secure: entry.secure,
    evidenceIdsBefore: entry.evidenceIdsBefore,
    evidenceIdsAfter: entry.evidenceIdsAfter,
  };
}

function makeDependencyChange(
  entry: DependencyDiffEntry,
  operation: ChangeOperation,
  aspect: DependencyChanged['aspect'],
): SemanticChange {
  return {
    category: 'dependency-changed',
    operation,
    dependencyId: entry.afterDependencyId ?? entry.beforeDependencyId ?? '',
    dependencyType: entry.type,
    aspect,
    evidenceIdsBefore: entry.evidenceIdsBefore,
    evidenceIdsAfter: entry.evidenceIdsAfter,
  };
}

export interface SemanticDiff {
  readonly matching: DiffMatching;
  readonly nodes: DiffSet<NodeDiffEntry>;
  readonly edges: DiffSet<EdgeDiffEntry>;
  readonly variables: DiffSet<VariableDiffEntry>;
  readonly dependencies: DiffSet<DependencyDiffEntry>;
  readonly prompts: DiffSet<PromptDiffEntry>;
  readonly changes: readonly SemanticChange[];
  /** Whether `hashes.normalizedGraph` differs between the two snapshots. */
  readonly graphHashChanged: boolean;
  /**
   * True when the graph hash changed but every identity-matched
   * node/edge/variable/dependency comparison above found nothing -- the
   * `/edges` path is order-sensitive in canonical hashing (normalize.ts),
   * so re-ordering a menu's choices in the source configuration changes the
   * hash without changing any route, label, or target. Movement alone is
   * not a semantic change (docs/07); this is that fact surfaced explicitly
   * rather than left for a caller to infer from an otherwise-empty diff.
   */
  readonly positionalOnlyReorder: boolean;
}

export { UNTRUSTED_TEXT_MAX_LENGTH as UNTRUSTED_TEXT_DEFAULT_MAX_LENGTH };

/**
 * Computes the semantic difference between two `FlowSnapshot`-shaped values.
 * Pure and deterministic: calling this twice with the same arguments (in any
 * key order -- nothing here depends on object key enumeration order) produces
 * byte-identical results, because every collection is matched by stable
 * identity and every output collection is sorted by a structural key before
 * being returned.
 */
export function diffSnapshots(
  before: DiffSnapshot,
  after: DiffSnapshot,
  options: DiffOptions = {},
): SemanticDiff {
  const maxLength = options.untrustedTextMaxLength ?? UNTRUSTED_TEXT_MAX_LENGTH;

  const matching = matchNodes(before.graph.nodes, after.graph.nodes);
  const nodes = diffNodes(before.graph.nodes, after.graph.nodes, matching, maxLength);
  const edges = diffEdges(before.graph.edges, after.graph.edges, maxLength);
  const variables = diffVariables(before.variables, after.variables, maxLength);
  const dependencies = diffDependencies(before.dependencies, after.dependencies, maxLength);
  const prompts = diffPrompts(before.graph.nodes, after.graph.nodes, matching);

  const changes = buildChanges(before, after, matching, nodes, edges, variables, dependencies);

  const graphHashChanged = before.hashes.normalizedGraph !== after.hashes.normalizedGraph;
  const nothingIdentityLevelChanged =
    nodes.added.length === 0 &&
    nodes.removed.length === 0 &&
    nodes.changed.length === 0 &&
    edges.added.length === 0 &&
    edges.removed.length === 0 &&
    edges.changed.length === 0 &&
    variables.added.length === 0 &&
    variables.removed.length === 0 &&
    variables.changed.length === 0 &&
    dependencies.added.length === 0 &&
    dependencies.removed.length === 0 &&
    dependencies.changed.length === 0;

  return {
    matching,
    nodes,
    edges,
    variables,
    dependencies,
    prompts,
    changes,
    graphHashChanged,
    positionalOnlyReorder: graphHashChanged && nothingIdentityLevelChanged,
  };
}

function classifyCoverageWithLevels(
  entry: NodeDiffEntry,
  beforeSupportLevel: string,
  afterSupportLevel: string,
): SemanticChange | null {
  const direction = coverageDirection(beforeSupportLevel, afterSupportLevel);
  if (direction === null) return null;
  return {
    category: 'coverage-changed',
    operation: 'changed',
    nodeId: entry.afterNodeId ?? entry.beforeNodeId,
    basis: entry.basis,
    direction,
    beforeSupportLevel,
    afterSupportLevel,
    evidenceIdsBefore: entry.evidenceIdsBefore,
    evidenceIdsAfter: entry.evidenceIdsAfter,
  };
}

/**
 * The one function `diffSnapshots` actually calls. `buildSemanticChanges`
 * classifies everything except node *reconfiguration* (the `nodes.changed`
 * set): a `coverage-changed` entry must report both support levels, and
 * `NodeDiffEntry.changedFields` only records field *names*, not their
 * values, so that classification happens here instead, against the real
 * before/after node objects.
 */
function buildChanges(
  before: DiffSnapshot,
  after: DiffSnapshot,
  matching: DiffMatching,
  nodes: DiffSet<NodeDiffEntry>,
  edges: DiffSet<EdgeDiffEntry>,
  variables: DiffSet<VariableDiffEntry>,
  dependencies: DiffSet<DependencyDiffEntry>,
): readonly SemanticChange[] {
  const beforeNodesById = new Map(before.graph.nodes.map((n) => [n.nodeId, n] as const));
  const afterNodesById = new Map(after.graph.nodes.map((n) => [n.nodeId, n] as const));

  const changes: SemanticChange[] = [
    ...buildSemanticChanges(before, after, matching, nodes, edges, variables, dependencies),
  ];

  for (const entry of nodes.changed) {
    if (entry.changedFields.includes('supportLevel')) {
      const b = entry.beforeNodeId !== null ? beforeNodesById.get(entry.beforeNodeId) : undefined;
      const a = entry.afterNodeId !== null ? afterNodesById.get(entry.afterNodeId) : undefined;
      const coverage =
        b !== undefined && a !== undefined
          ? classifyCoverageWithLevels(entry, b.supportLevel, a.supportLevel)
          : null;
      if (coverage !== null) changes.push(coverage);
      const remainingFields = entry.changedFields.filter((f) => f !== 'supportLevel');
      if (remainingFields.length > 0) {
        changes.push(classifyNodeReconfigured({ ...entry, changedFields: remainingFields }));
      }
    } else {
      changes.push(classifyNodeReconfigured(entry));
    }
  }

  return sortBy(changes, changeSortKey);
}
