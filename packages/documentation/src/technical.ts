// packages/documentation/src/technical.ts
// Renders `technical.md`: the engineer-facing document for a single flow
// snapshot. Sections follow docs/05-documentation-generation.md's
// `technical.md` list. This module calls no model and invents no fact — it
// only reformats what `normalizeFlow` and `analyzeFlow` already established.
//
// Three rules make this more than a template:
//
//   1. Every piece of tenant-authored text (flow/node/variable names, edge
//      labels, dependency display names, container path segments) is
//      untrusted per AGENTS.md and is routed through `escapeMarkdown` or
//      `escapeTableCell` before it reaches the document.
//   2. Every evidence id printed here is read from the snapshot's own
//      `evidenceIds` fields — on a node, a variable, a dependency, or a
//      finding — never invented. A test greps the rendered document for
//      `sha256:[0-9a-f]{64}` and asserts every match exists in
//      `snapshot.evidence`. Inline citations use the shared short-mark
//      convention (`EvidenceRegistry`, from `evidence-marks.ts`, the same
//      class `business.md` and `operations.md` use): every claim cites
//      `[eN]`, and §10 maps each mark back to its full id. A 47-row node
//      table with two full 71-character ids per row is unreadable at
//      exactly the moment an engineer needs it; a mark is not.
//   3. Two variables in the same flow may share a name across scopes (a
//      flow-scoped and a task-scoped variable both called the same thing is
//      legal and unremarkable in Architect). §5's table disambiguates by
//      column; everywhere else a variable is named — prose and §9's
//      findings table — its scope and type are appended so a reader is
//      never one click away from deleting the wrong one. §9 resolves the
//      variable via `Finding.subject`, not by matching text in the message.
//
// `technical.md` may cite only `fact` and `derived` findings (never
// `inference` or `unknown`); `analyzeFlow` never produces those kinds, but
// this module filters defensively rather than trusting that invariant
// silently.

import type {
  CycleReport,
  Finding,
  FindingsGraphEdge,
  FindingsGraphNode,
  FindingsVariable,
  FindingsDependency,
  FindingsEvidenceRecord,
  Journey,
  ReachabilityReport,
} from '@genesys-archivist/analysis';
import { escapeMarkdown, escapeTableCell } from './escape.js';
import { EvidenceRegistry } from './evidence-marks.js';
import type { RenderContext } from './render-context.js';

export type { RenderContext };

// ---------------------------------------------------------------------------
// Input shape
//
// `packages/documentation` depends on `@genesys-archivist/analysis` and
// `@genesys-archivist/domain` only (see package.json) — `FlowSnapshot` lives
// in `@genesys-archivist/normalization`, a dev-only dependency used by
// tests. So, matching the pattern already established in diagrams.ts, this
// module declares the structural minimum it needs; a real `FlowSnapshot`
// satisfies it without either package importing the other's types.
// ---------------------------------------------------------------------------

export interface TechnicalSourceMetadata {
  readonly provider: string;
  readonly adapterVersion: string;
  readonly extractedAt: string;
  readonly region: string;
  readonly organizationId: string;
  readonly trackingIdsAvailable: boolean;
  readonly redactionApplied: boolean;
}

export interface TechnicalFlowVersion {
  readonly selected: string | number;
  readonly state: string;
}

export interface TechnicalFlowIdentity {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly secure: boolean;
  readonly version: TechnicalFlowVersion;
  readonly languages?: readonly string[];
}

export interface TechnicalGraphNode extends FindingsGraphNode {
  readonly kind: string;
  readonly containerPath: readonly string[];
}

export type TechnicalGraphEdge = FindingsGraphEdge;

export interface TechnicalGraph {
  readonly entryNodeIds: readonly string[];
  readonly nodes: readonly TechnicalGraphNode[];
  readonly edges: readonly TechnicalGraphEdge[];
}

export interface TechnicalVariable extends FindingsVariable {
  readonly dataType: string;
  readonly direction: string;
  readonly secure: boolean;
}

export interface TechnicalDependency extends FindingsDependency {
  readonly displayName: string | null;
}

export interface TechnicalEvidenceRecord extends FindingsEvidenceRecord {
  readonly sourcePointer: string;
  readonly field: string;
  readonly classification: string;
  readonly redacted: boolean;
}

export interface TechnicalCompleteness {
  readonly sourceObjectCount: number;
  readonly representedObjectCount: number;
  readonly unsupportedNodeCount: number;
  readonly opaqueNodeCount: number;
  readonly danglingEdgeCount: number;
  readonly unresolvedDependencyCount: number;
}

export interface TechnicalHashes {
  readonly canonicalizerVersion: string;
  readonly normalizedGraph: string;
}

/** Structural minimum this module needs from a `FlowSnapshot`. */
export interface TechnicalSnapshot {
  readonly schemaVersion: string;
  readonly snapshotId: string;
  readonly source: TechnicalSourceMetadata;
  readonly flow: TechnicalFlowIdentity;
  readonly graph: TechnicalGraph;
  readonly variables: readonly TechnicalVariable[];
  readonly dependencies: readonly TechnicalDependency[];
  readonly evidence: readonly TechnicalEvidenceRecord[];
  readonly completeness?: TechnicalCompleteness;
  readonly hashes: TechnicalHashes;
}

/** Structural minimum this module needs from a `FlowAnalysis`. */
export interface TechnicalAnalysis {
  readonly reachability: ReachabilityReport;
  readonly cycles: CycleReport;
  readonly journeys: readonly Journey[];
  readonly findings: readonly Finding[];
}

// This renderer's own version, independent of `schemaVersion` (the snapshot
// shape) and `hashes.canonicalizerVersion` (the canonicalization algorithm).
// Bump when the section structure or rendering rules of this file change.
const TECHNICAL_DOC_GENERATOR_VERSION = '1.0.0';

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function sortByKey<T>(items: readonly T[], key: (item: T) => string): readonly T[] {
  return [...items].sort((a, b) => compareStrings(key(a), key(b)));
}

/** `${n} ${n === 1 ? singular : plural}`, e.g. `count(1, 'node', 'nodes')` ->
 * `'1 node'`. The one pluralization rule this module needs, used everywhere
 * a count reaches the document instead of ad hoc `(s)` or `/-ies` suffixes. */
function count(n: number, singular: string, plural: string): string {
  return `${String(n)} ${n === 1 ? singular : plural}`;
}

/** The bare word form for when a count already appears elsewhere in the
 * sentence (a verb, a pronoun) and only agreement is needed, e.g.
 * `plural(n, 'was', 'were')`. */
function plural(n: number, singular: string, pluralForm: string): string {
  return n === 1 ? singular : pluralForm;
}

function code(text: string): string {
  return `\`${text}\``;
}

function countCell(ids: readonly string[]): string {
  return String(ids.length);
}

/** `${name} (scope, type)` — used everywhere a variable is named in prose or
 * in a table cell outside §5's own table, so that two variables sharing a
 * name across scopes are never ambiguous. */
function variableLabel(v: TechnicalVariable): string {
  return `${escapeMarkdown(v.name)} (${v.scope}, ${v.dataType})`;
}

function displayWidth(text: string): number {
  return text.length;
}

function padCell(text: string, width: number): string {
  const gap = width - displayWidth(text);
  return gap > 0 ? text + ' '.repeat(gap) : text;
}

/** Renders a GFM table, columns padded to a common width per column (matching
 * this repository's Prettier markdown formatting, so the golden file and
 * this renderer's raw output agree byte-for-byte without a separate
 * formatting pass). Every cell is expected to already be escaped by the
 * caller — this function does not know which columns carry tenant text and
 * which carry ids or counts our own code produced. */
function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((header, col) => {
    let maxWidth = displayWidth(header);
    for (const row of rows) {
      const width = displayWidth(row[col] ?? '');
      if (width > maxWidth) maxWidth = width;
    }
    return Math.max(maxWidth, 3);
  });

  const renderRow = (cells: readonly string[]): string =>
    `| ${cells.map((cell, col) => padCell(cell, widths[col] ?? 0)).join(' | ')} |`;

  const dividerRow = `| ${widths.map((w) => '-'.repeat(w)).join(' | ')} |`;

  return [renderRow(headers), dividerRow, ...rows.map((row) => renderRow(row))].join('\n');
}

function containerPathCell(containerPath: readonly string[]): string {
  if (containerPath.length === 0) return '—';
  return escapeTableCell(containerPath.join(' / '));
}

/** Evidence ids for a specific flow-level claim (`/name`, `/type`) — the two
 * `flowLevelEvidence` records `buildEvidence` always emits (see
 * `evidence.ts`), found by their pointer and field rather than assumed to
 * sit at a fixed array position. */
function flowLevelEvidenceIds(
  evidence: readonly TechnicalEvidenceRecord[],
  sourcePointer: string,
  field: string,
): readonly string[] {
  return evidence
    .filter((e) => e.sourcePointer === sourcePointer && e.field === field)
    .map((e) => e.evidenceId);
}

// ---------------------------------------------------------------------------
// Section 1: source identity, version, and completeness
// ---------------------------------------------------------------------------

function renderIdentitySection(
  snapshot: TechnicalSnapshot,
  ctx: RenderContext,
  evidence: EvidenceRegistry,
): string {
  const { flow, source, hashes, completeness } = snapshot;
  const nameEvidence = evidence.cite(flowLevelEvidenceIds(snapshot.evidence, '/name', 'name'));
  const typeEvidence = evidence.cite(flowLevelEvidenceIds(snapshot.evidence, '/type', 'type'));

  const lines: string[] = [
    '## 1. Source Identity, Version, and Completeness',
    '',
    `- **Flow name:** ${escapeMarkdown(flow.name)}${nameEvidence}`,
    `- **Flow id:** ${code(flow.id)}`,
    `- **Flow type:** ${escapeMarkdown(flow.type)}${typeEvidence}`,
    `- **Secure flow:** ${flow.secure ? 'yes' : 'no'}`,
    `- **Version:** ${escapeMarkdown(String(flow.version.selected))} (${escapeMarkdown(flow.version.state)})`,
    `- **Snapshot id:** ${code(snapshot.snapshotId)}`,
    `- **Snapshot schema version:** ${escapeMarkdown(snapshot.schemaVersion)}`,
    '',
    '### Capture source',
    '',
    `- **Provider:** ${escapeMarkdown(source.provider)}`,
    `- **Adapter version:** ${escapeMarkdown(source.adapterVersion)}`,
    `- **Extracted at:** ${escapeMarkdown(source.extractedAt)}`,
    `- **Region:** ${escapeMarkdown(source.region)}`,
    `- **Organization id:** ${code(source.organizationId)}`,
    `- **Tracking ids available:** ${source.trackingIdsAvailable ? 'yes' : 'no'}`,
    `- **Redaction applied at capture:** ${source.redactionApplied ? 'yes' : 'no'}`,
    '',
    '### Generation and normalization',
    '',
    `- **Generator (this technical.md renderer):** ${TECHNICAL_DOC_GENERATOR_VERSION}`,
    `- **Normalizer canonicalizer version:** ${escapeMarkdown(hashes.canonicalizerVersion)}`,
    // Rendered with the `sha256:` algorithm prefix split from the digest —
    // this is a whole-graph content hash, not an evidence citation, and must
    // not match the `sha256:[0-9a-f]{64}` pattern the evidence-citation test
    // scans for.
    `- **Normalized graph hash (sha256):** ${code(hashes.normalizedGraph.replace(/^sha256:/, ''))}`,
    `- **Document generated at:** ${escapeMarkdown(ctx.generatedAt)}`,
    '',
    '### Completeness',
    '',
  ];

  if (completeness === undefined) {
    lines.push('Completeness was not reported for this snapshot.');
  } else {
    lines.push(
      table(
        ['Metric', 'Count'],
        [
          ['Source objects', String(completeness.sourceObjectCount)],
          ['Represented objects', String(completeness.representedObjectCount)],
          ['Unsupported nodes', String(completeness.unsupportedNodeCount)],
          ['Opaque nodes', String(completeness.opaqueNodeCount)],
          ['Dangling edges', String(completeness.danglingEdgeCount)],
          ['Unresolved dependencies', String(completeness.unresolvedDependencyCount)],
        ],
      ),
    );
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Section 2: flow structure and entry points
// ---------------------------------------------------------------------------

function renderStructureSection(
  snapshot: TechnicalSnapshot,
  analysis: TechnicalAnalysis,
  evidence: EvidenceRegistry,
): string {
  const { graph } = snapshot;
  const { reachability } = analysis;

  const edgeRoleCounts = new Map<string, number>();
  for (const edge of graph.edges) {
    edgeRoleCounts.set(edge.role, (edgeRoleCounts.get(edge.role) ?? 0) + 1);
  }
  const roleRows = sortByKey([...edgeRoleCounts.entries()], ([role]) => role).map(([role, c]) => [
    escapeTableCell(role),
    String(c),
  ]);

  const nodesById = new Map(graph.nodes.map((n) => [n.nodeId, n] as const));
  const entryRows = sortByKey(graph.entryNodeIds, (id) => id).map((nodeId) => {
    const node = nodesById.get(nodeId);
    return [
      code(nodeId),
      node !== undefined ? escapeTableCell(node.name) : '—',
      node !== undefined ? escapeTableCell(node.sourceType) : '—',
      node !== undefined ? evidence.cite(node.evidenceIds) : '—',
    ];
  });

  const terminalRows = sortByKey(reachability.terminalNodeIds, (id) => id).map((nodeId) => {
    const node = nodesById.get(nodeId);
    return [
      code(nodeId),
      node !== undefined ? escapeTableCell(node.name) : '—',
      node !== undefined ? escapeTableCell(node.sourceType) : '—',
    ];
  });

  return [
    '## 2. Flow Structure and Entry Points',
    '',
    `- **Total nodes:** ${String(graph.nodes.length)}`,
    `- **Total edges:** ${String(graph.edges.length)}`,
    `- **Entry points:** ${String(graph.entryNodeIds.length)}`,
    `- **Terminal nodes (no outgoing edge):** ${String(reachability.terminalNodeIds.length)}`,
    `- **Reachable nodes:** ${String(reachability.reachableNodeIds.length)}`,
    `- **Unreachable nodes:** ${String(reachability.unreachableNodeIds.length)}`,
    '',
    '### Edge roles',
    '',
    table(['Role', 'Count'], roleRows),
    '',
    '### Entry nodes',
    '',
    table(['Node id', 'Name', 'Type', 'Evidence'], entryRows),
    '',
    '### Terminal nodes',
    '',
    table(['Node id', 'Name', 'Type'], terminalRows),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Section 3: action inventory
// ---------------------------------------------------------------------------

function renderActionInventorySection(
  snapshot: TechnicalSnapshot,
  evidence: EvidenceRegistry,
): string {
  const { graph } = snapshot;

  const countsByType = new Map<string, number>();
  for (const node of graph.nodes) {
    countsByType.set(node.sourceType, (countsByType.get(node.sourceType) ?? 0) + 1);
  }
  const typeRows = sortByKey([...countsByType.entries()], ([sourceType]) => sourceType).map(
    ([sourceType, c]) => [escapeTableCell(sourceType), String(c)],
  );

  const sortedNodes = sortByKey(graph.nodes, (n) => n.nodeId);
  const nodeRows = sortedNodes.map((node) => [
    code(node.nodeId),
    escapeTableCell(node.name),
    escapeTableCell(node.sourceType),
    escapeTableCell(node.kind),
    containerPathCell(node.containerPath),
    escapeTableCell(node.supportLevel),
    evidence.cite(node.evidenceIds),
  ]);

  return [
    '## 3. Action Inventory',
    '',
    'Node counts by type:',
    '',
    table(['Type', 'Count'], typeRows),
    '',
    'Every captured node, in node-id order. Evidence marks resolve to a full id in §10.',
    '',
    table(['Node id', 'Name', 'Type', 'Kind', 'Container', 'Support', 'Evidence'], nodeRows),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Section 4: branch table
// ---------------------------------------------------------------------------

function renderBranchTableSection(snapshot: TechnicalSnapshot): string {
  const { graph } = snapshot;
  const nodesById = new Map(graph.nodes.map((n) => [n.nodeId, n] as const));

  const rows = sortByKey(graph.edges, (e) => e.edgeId).map((edge) => {
    const from = nodesById.get(edge.from);
    const to = nodesById.get(edge.to);
    return [
      code(edge.edgeId),
      from !== undefined ? escapeTableCell(from.name) : code(edge.from),
      escapeTableCell(edge.role),
      edge.label !== undefined && edge.label !== '' ? escapeTableCell(edge.label) : '—',
      to !== undefined ? escapeTableCell(to.name) : code(edge.to),
    ];
  });

  return [
    '## 4. Branch Table',
    '',
    'Every edge in the flow graph, in edge-id order. A diagram covering the same graph — split ' +
      'by menu/task where a single diagram would be unreadable — accompanies this document. ' +
      'Edges do not carry their own evidence records in this normalizer version (see §10); an ' +
      "edge's evidence is its endpoint nodes' evidence in §3.",
    '',
    table(['Edge id', 'From', 'Role', 'Label', 'To'], rows),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Section 5: variables
// ---------------------------------------------------------------------------

function renderVariablesSection(snapshot: TechnicalSnapshot, evidence: EvidenceRegistry): string {
  const variables = sortByKey(snapshot.variables, (v) => v.variableId);

  const rows = variables.map((v) => [
    escapeTableCell(v.name),
    escapeTableCell(v.scope),
    escapeTableCell(v.dataType),
    escapeTableCell(v.direction),
    v.secure ? 'yes' : 'no',
    countCell(v.readNodeIds),
    countCell(v.writeNodeIds),
    evidence.cite(v.evidenceIds),
  ]);

  const readNeverWritten = variables.filter(
    (v) => v.readNodeIds.length > 0 && v.writeNodeIds.length === 0,
  );
  const declaredUnused = variables.filter(
    (v) => v.readNodeIds.length === 0 && v.writeNodeIds.length === 0,
  );

  const lines: string[] = [
    '## 5. Variables',
    '',
    table(
      ['Name', 'Scope', 'Type', 'Direction', 'Secure', 'Read by', 'Written by', 'Evidence'],
      rows,
    ),
    '',
  ];

  lines.push('### Variables read but never written');
  lines.push('');
  if (readNeverWritten.length === 0) {
    lines.push('None. Every variable this flow reads is written somewhere in the same flow.');
  } else {
    for (const v of readNeverWritten) {
      lines.push(
        `- **${variableLabel(v)}** is read but never written anywhere in this flow ` +
          `(${count(v.readNodeIds.length, 'read site', 'read sites')}). Any branch or prompt ` +
          'depending on its value cannot behave as the flow author intended — it always ' +
          'observes the platform default, never a value this flow set. ' +
          `Evidence: ${evidence.cite(v.evidenceIds)}.`,
      );
    }
  }
  lines.push('');

  lines.push('### Variables declared but unused');
  lines.push('');
  if (declaredUnused.length === 0) {
    lines.push('None. Every declared variable is read or written somewhere in this flow.');
  } else {
    for (const v of declaredUnused) {
      lines.push(
        `- **${variableLabel(v)}** is declared but never read or written. ` +
          `Evidence: ${evidence.cite(v.evidenceIds)}.`,
      );
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Section 6: prompt and language inventory
// ---------------------------------------------------------------------------

const PROMPT_NODE_TYPES: ReadonlySet<string> = new Set(['PlayAudioAction']);
const PROMPT_DEPENDENCY_TYPES: ReadonlySet<string> = new Set([
  'ttsEngine',
  'ttsVoice',
  'language',
  'systemPrompt',
]);

/** Architect records language two different ways, and this snapshot may
 * populate either, both, or neither: `flow.languages` is a flow-level
 * declaration; a `language`-type dependency is a resolved runtime resource.
 * Neither implies the other, so this states both explicitly rather than
 * reporting only whichever one happens to be present — a document that
 * reads only `flow.languages` and says "no languages" while a `language`
 * dependency sits resolved in the manifest would be true and misleading at
 * the same time. Wording agreed with the `business.md` renderer so the two
 * documents describe this snapshot the same way. */
function renderLanguageSubsection(
  snapshot: TechnicalSnapshot,
  evidence: EvidenceRegistry,
): string[] {
  const { flow, dependencies } = snapshot;
  const lines: string[] = ['### Declared languages', ''];

  const declaredLanguages =
    flow.languages !== undefined ? [...flow.languages].sort(compareStrings) : [];
  if (declaredLanguages.length > 0) {
    lines.push(
      `This flow declares ${count(declaredLanguages.length, 'language', 'languages')} at the flow level:`,
    );
    lines.push('');
    lines.push(
      table(
        ['Language'],
        declaredLanguages.map((lang) => [escapeTableCell(lang)]),
      ),
    );
    lines.push('');
  }

  const languageDependencies = sortByKey(
    dependencies.filter((d) => d.type === 'language'),
    (d) => d.dependencyId,
  );

  if (languageDependencies.length === 0) {
    lines.push(
      declaredLanguages.length > 0
        ? 'The capture records no separate language-related dependency for this flow.'
        : 'No language was declared at the flow level, and the capture records no language ' +
            'dependency either.',
    );
  } else {
    lines.push(
      (declaredLanguages.length > 0
        ? 'The capture also '
        : 'No language was declared at the flow level. The capture ') +
        `records ${count(languageDependencies.length, 'language-related dependency', 'language-related dependencies')} resolved for this flow:`,
    );
    lines.push('');
    for (const dep of languageDependencies) {
      const label = dep.displayName ?? dep.dependencyId;
      lines.push(`- ${escapeMarkdown(label)}${evidence.cite(dep.evidenceIds)}`);
    }
  }

  return lines;
}

function renderPromptAndLanguageSection(
  snapshot: TechnicalSnapshot,
  evidence: EvidenceRegistry,
): string {
  const { graph, dependencies } = snapshot;

  const promptNodes = sortByKey(
    graph.nodes.filter((n) => PROMPT_NODE_TYPES.has(n.sourceType)),
    (n) => n.nodeId,
  );
  const promptRows = promptNodes.map((n) => [
    code(n.nodeId),
    escapeTableCell(n.name),
    containerPathCell(n.containerPath),
    evidence.cite(n.evidenceIds),
  ]);

  const promptDependencies = sortByKey(
    dependencies.filter((d) => PROMPT_DEPENDENCY_TYPES.has(d.type) && d.type !== 'language'),
    (d) => d.dependencyId,
  );
  const dependencyRows = promptDependencies.map((d) => [
    escapeTableCell(d.type),
    escapeTableCell(d.displayName ?? d.dependencyId),
    escapeTableCell(d.resolutionStatus),
    evidence.cite(d.evidenceIds),
  ]);

  const lines: string[] = ['## 6. Prompt and Language Inventory', ''];
  lines.push(...renderLanguageSubsection(snapshot, evidence));
  lines.push('');

  lines.push('### Prompt-playing nodes');
  lines.push('');
  if (promptRows.length === 0) {
    lines.push('This flow contains no prompt-playing nodes.');
  } else {
    lines.push(table(['Node id', 'Name', 'Container', 'Evidence'], promptRows));
  }
  lines.push('');

  lines.push('### Text-to-speech and prompt-related dependencies');
  lines.push('');
  if (dependencyRows.length === 0) {
    lines.push('This flow declares no text-to-speech or prompt-related dependencies.');
  } else {
    lines.push(table(['Type', 'Display name', 'Resolution status', 'Evidence'], dependencyRows));
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Section 7: dependencies (including external calls)
// ---------------------------------------------------------------------------

function renderDependenciesSection(
  snapshot: TechnicalSnapshot,
  evidence: EvidenceRegistry,
): string {
  const dependencies = sortByKey(snapshot.dependencies, (d) => d.dependencyId);

  const rows = dependencies.map((d) => [
    escapeTableCell(d.type),
    escapeTableCell(d.displayName ?? d.dependencyId),
    escapeTableCell(d.resolutionStatus),
    countCell(d.referencedByNodeIds),
    evidence.cite(d.evidenceIds),
  ]);

  const dataActionDependencies = dependencies.filter((d) => d.type === 'dataAction');
  const dataActionNodes = sortByKey(
    snapshot.graph.nodes.filter((n) => n.sourceType === 'DataAction'),
    (n) => n.nodeId,
  );

  const lines: string[] = [
    '## 7. Dependencies',
    '',
    'Every external resource this flow references — queues, data actions, text-to-speech ' +
      'configuration, and similar. No credential, secret, or endpoint URL is reproduced here; ' +
      'see docs/05 §"External calls" for what this document deliberately omits.',
    '',
    table(['Type', 'Display name', 'Resolution status', 'Referenced by', 'Evidence'], rows),
    '',
    '### External calls (data actions)',
    '',
  ];

  if (dataActionDependencies.length === 0 && dataActionNodes.length === 0) {
    lines.push('This flow makes no external data-action calls.');
  } else {
    lines.push(
      `This flow calls out to ${count(dataActionDependencies.length, 'data-action dependency', 'data-action dependencies')} ` +
        `from ${count(dataActionNodes.length, '`DataAction` node', '`DataAction` nodes')}. Its ` +
        'success/failure branching is recorded in the branch table (§4) by role and label; ' +
        'no request or response payload is captured here.',
    );
    if (dataActionNodes.length > 0) {
      lines.push('');
      lines.push(
        table(
          ['Node id', 'Name', 'Container', 'Evidence'],
          dataActionNodes.map((n) => [
            code(n.nodeId),
            escapeTableCell(n.name),
            containerPathCell(n.containerPath),
            evidence.cite(n.evidenceIds),
          ]),
        ),
      );
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Section 8: error, retry, and loop handling
// ---------------------------------------------------------------------------

function renderErrorAndRetrySection(
  snapshot: TechnicalSnapshot,
  analysis: TechnicalAnalysis,
  evidence: EvidenceRegistry,
): string {
  const decisionNodes = sortByKey(
    snapshot.graph.nodes.filter((n) => n.sourceType === 'DecisionAction'),
    (n) => n.nodeId,
  );

  const decisionRows = decisionNodes.map((n) => [
    code(n.nodeId),
    escapeTableCell(n.name),
    containerPathCell(n.containerPath),
    evidence.cite(n.evidenceIds),
  ]);

  const components = [...analysis.cycles.stronglyConnectedComponents]
    .map((component) => [...component].sort(compareStrings))
    .sort((a, b) => compareStrings(a.join(','), b.join(',')));

  const lines: string[] = [
    '## 8. Error, Retry, and Loop Handling',
    '',
    'This section records what the graph itself proves about branching and retry structure. ' +
      'It does not infer _why_ a branch exists — only that it does, and where.',
    '',
    '### Decision points',
    '',
  ];

  if (decisionRows.length === 0) {
    lines.push('This flow contains no decision nodes.');
  } else {
    lines.push(
      `${count(decisionNodes.length, '`DecisionAction` node', '`DecisionAction` nodes')} ` +
        "implement this flow's yes/no branching; see the branch table (§4) for each one's " +
        'outgoing edges.',
    );
    lines.push('');
    lines.push(table(['Node id', 'Name', 'Container', 'Evidence'], decisionRows));
  }
  lines.push('');

  lines.push('### Loops and retries');
  lines.push('');
  if (components.length === 0) {
    lines.push('This flow contains no cycles: every path through it is acyclic.');
  } else {
    lines.push(
      `This flow's graph contains ${count(components.length, 'non-trivial strongly connected component', 'non-trivial strongly connected components')} ` +
        '— a caller can loop back to a node already visited on the same path, which is normal ' +
        'for a menu or retry loop and is not itself a defect.',
    );
    lines.push('');
    lines.push(table(['Component size', 'Node ids (sample)'], componentRows(components)));
  }

  return lines.join('\n');
}

const MAX_SAMPLE_NODE_IDS = 3;

function componentRows(components: readonly (readonly string[])[]): readonly (readonly string[])[] {
  return components.map((component) => {
    const shown = component.slice(0, MAX_SAMPLE_NODE_IDS).map(code).join(', ');
    const remaining = component.length - MAX_SAMPLE_NODE_IDS;
    const sample = remaining > 0 ? `${shown} (+${String(remaining)} more)` : shown;
    return [String(component.length), sample];
  });
}

// ---------------------------------------------------------------------------
// Section 9: graph findings
// ---------------------------------------------------------------------------

/** `technical.md` may cite only `fact` and `derived` findings — `inference`
 * and `unknown` exist for a later, model-backed layer and must never appear
 * here, even if `analyzeFlow` (which never produces them today) changed. */
function deterministicFindings(findings: readonly Finding[]): readonly Finding[] {
  return findings.filter((f) => f.kind === 'fact' || f.kind === 'derived');
}

/** What a finding is about, for the "Subject" column: resolved from
 * `Finding.subject` — the typed field `analyzeFlow` now attaches for
 * variable findings — rather than by matching text in `message`. A
 * variable-declared-unused finding has no node sites at all (`nodeIds` is
 * empty), so `subject` is the only structured trace of which variable it
 * names; falling back to a plain node count for findings with no subject
 * keeps every other finding kind informative too. */
function findingSubjectCell(
  f: Finding,
  variablesById: ReadonlyMap<string, TechnicalVariable>,
): string {
  if (f.subject === undefined) {
    return f.nodeIds.length > 0 ? count(f.nodeIds.length, 'node', 'nodes') : '—';
  }
  if (f.subject.kind === 'variable') {
    const v = variablesById.get(f.subject.id);
    return v !== undefined ? `variable: ${variableLabel(v)}` : `variable: ${code(f.subject.id)}`;
  }
  return `${escapeTableCell(f.subject.kind)}: ${code(f.subject.id)}`;
}

function indexVariablesById(
  variables: readonly TechnicalVariable[],
): ReadonlyMap<string, TechnicalVariable> {
  return new Map(variables.map((v) => [v.variableId, v] as const));
}

function renderGraphFindingsSection(
  analysis: TechnicalAnalysis,
  variables: readonly TechnicalVariable[],
  evidence: EvidenceRegistry,
): string {
  const { reachability, cycles } = analysis;
  const findings = sortByKey(deterministicFindings(analysis.findings), (f) => f.code + f.message);
  const variablesById = indexVariablesById(variables);

  const largestComponent = cycles.stronglyConnectedComponents.reduce<readonly string[]>(
    (largest, component) => (component.length > largest.length ? component : largest),
    [],
  );

  const findingRows = findings.map((f) => [
    escapeTableCell(f.code),
    escapeTableCell(f.severity),
    escapeTableCell(f.kind),
    escapeMarkdown(f.message),
    findingSubjectCell(f, variablesById),
    evidence.cite(f.evidenceIds),
  ]);

  const errorCount = findings.filter(
    (f) => f.severity === 'error' || f.severity === 'critical',
  ).length;
  const infoCount = findings.filter((f) => f.severity === 'info').length;
  const warningCount = findings.filter((f) => f.severity === 'warning').length;

  return [
    '## 9. Graph Findings',
    '',
    `- **Unreachable nodes:** ${String(reachability.unreachableNodeIds.length)}`,
    `- **Dangling edges:** ${String(reachability.danglingEdgeIds.length)}`,
    `- **Strongly connected components:** ${String(cycles.stronglyConnectedComponents.length)}` +
      (largestComponent.length > 0
        ? ` (largest: ${count(largestComponent.length, 'node', 'nodes')})`
        : ''),
    `- **Findings below:** ${String(findings.length)} (${String(errorCount)} error, ` +
      `${String(warningCount)} warning, ${String(infoCount)} info)`,
    '',
    'Only `fact` and `derived` findings are reported here. `technical.md` never presents an ' +
      '`inference` as a fact.',
    '',
    table(['Code', 'Severity', 'Kind', 'Message', 'Subject', 'Evidence'], findingRows),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Section 10: evidence index and known limitations
// ---------------------------------------------------------------------------

function renderEvidenceIndexSection(
  snapshot: TechnicalSnapshot,
  evidence: EvidenceRegistry,
): string {
  const { evidence: evidenceRecords, completeness } = snapshot;

  const countsByClassification = new Map<string, number>();
  let redactedCount = 0;
  for (const record of evidenceRecords) {
    countsByClassification.set(
      record.classification,
      (countsByClassification.get(record.classification) ?? 0) + 1,
    );
    if (record.redacted) redactedCount += 1;
  }
  const classificationRows = sortByKey(
    [...countsByClassification.entries()],
    ([classification]) => classification,
  ).map(([classification, c]) => [escapeTableCell(classification), String(c)]);

  const limitations: string[] = [];
  if (completeness !== undefined) {
    if (completeness.unsupportedNodeCount > 0) {
      const n = completeness.unsupportedNodeCount;
      limitations.push(
        `${count(n, 'node', 'nodes')} ${plural(n, 'was', 'were')} captured but ` +
          `${plural(n, 'its', 'their')} type is unsupported by this normalizer version; ` +
          `${plural(n, 'it is', 'they are')} preserved verbatim rather than modelled. See the ` +
          `action inventory (§3) for which ${plural(n, 'node', 'nodes')}.`,
      );
    }
    if (completeness.opaqueNodeCount > 0) {
      const n = completeness.opaqueNodeCount;
      limitations.push(
        `${count(n, 'node', 'nodes')} ${plural(n, 'was', 'were')} captured opaquely: ` +
          `${plural(n, 'its', 'their')} settings could not be interpreted beyond identity.`,
      );
    }
    if (completeness.unresolvedDependencyCount > 0) {
      const n = completeness.unresolvedDependencyCount;
      limitations.push(
        `${count(n, 'dependency', 'dependencies')} did not resolve at capture time. See the ` +
          `dependency table (§7) for which ${plural(n, 'one', 'ones')}.`,
      );
    }
  }
  if (redactedCount > 0) {
    limitations.push(
      `${count(redactedCount, 'evidence record', 'evidence records')} ` +
        `${plural(redactedCount, 'documents', 'document')} that a secure value exists without ` +
        `capturing that value; ${plural(redactedCount, 'its', 'their')} content is never ` +
        'present in this snapshot or this document.',
    );
  }
  limitations.push(
    'Edges do not yet carry their own evidence records in this normalizer version; a ' +
      "branch's evidence is its endpoints' evidence in the action inventory (§3).",
  );

  const entries = evidence.entries();

  const lines: string[] = [
    '## 10. Evidence Index and Known Limitations',
    '',
    `This snapshot carries ${count(evidenceRecords.length, 'evidence record', 'evidence records')} ` +
      'in total. Every technical claim above that cites a mark resolves to one of them below; ' +
      'the full snapshot carries the rest, including facts this document did not need to state.',
    '',
    '### Evidence by classification',
    '',
    table(['Classification', 'Count'], classificationRows),
    '',
    '### Evidence marks',
    '',
  ];

  if (entries.length === 0) {
    lines.push('No evidence was cited in this document.');
  } else {
    lines.push(
      table(
        ['Mark', 'Evidence ID'],
        entries.map((e) => [e.mark, e.evidenceId]),
      ),
    );
  }
  lines.push('');

  lines.push('### Known limitations');
  lines.push('');
  lines.push(...limitations.map((l) => `- ${l}`));

  return lines.join('\n');
}

/**
 * Renders `technical.md` for a single flow snapshot: source identity and
 * completeness, structure and entry points, the action inventory, the
 * branch table, variables with read/write locations, the prompt and
 * language inventory, dependencies (including external calls), error/retry/
 * loop handling, graph findings, and an evidence index with known
 * limitations. Deterministic — the same snapshot, analysis, and `ctx`
 * always render byte-identical Markdown.
 */
export function renderTechnical(
  snapshot: TechnicalSnapshot,
  analysis: TechnicalAnalysis,
  ctx: RenderContext,
): string {
  const evidence = new EvidenceRegistry();

  const sections = [
    `# Technical Documentation: ${escapeMarkdown(snapshot.flow.name)}`,
    '',
    `_Generated ${escapeMarkdown(ctx.generatedAt)} for audience: contact-center engineers and ` +
      'developers._',
    '',
    renderIdentitySection(snapshot, ctx, evidence),
    '',
    renderStructureSection(snapshot, analysis, evidence),
    '',
    renderActionInventorySection(snapshot, evidence),
    '',
    renderBranchTableSection(snapshot),
    '',
    renderVariablesSection(snapshot, evidence),
    '',
    renderPromptAndLanguageSection(snapshot, evidence),
    '',
    renderDependenciesSection(snapshot, evidence),
    '',
    renderErrorAndRetrySection(snapshot, analysis, evidence),
    '',
    renderGraphFindingsSection(analysis, snapshot.variables, evidence),
    '',
    // §10 must render last: it is the only section that reports the
    // evidence registry's contents, and every other section above may still
    // add marks to it as it renders.
    renderEvidenceIndexSection(snapshot, evidence),
    '',
  ];

  return sections.join('\n');
}
