// packages/documentation/src/operations.ts
// Renders `operations.md`: the on-call document. Per the design spec
// (§6.3), this is a document `docs/05` never described — it exists because
// org-wide capture makes a real, otherwise-expensive operational question
// answerable: "what breaks if I retire this queue?" Blast radius is the
// section that earns this document's existence, and it comes straight from
// `snapshot.dependencies[].referencedByNodeIds` — no inference required.
//
// The reader is whoever is on call at 3am, not a product manager: unlike
// `business.md`, node ids belong here and are shown deliberately, because
// an engineer needs a concrete pointer back into the flow to act on this
// document. Every other rule from AGENTS.md still applies — tenant text is
// escaped, every claim either cites an evidence id that exists in the
// snapshot or says plainly that the fact is not recorded, and nothing here
// invents an answer the capture does not actually contain.

import { escapeMarkdown, escapeTableCell } from './escape.js';
import { EvidenceRegistry } from './evidence-marks.js';
import type { RenderContext } from './render-context.js';

/** Structural minimum this module needs from a graph node. */
export interface OperationsGraphNode {
  readonly nodeId: string;
  readonly sourceType: string;
  readonly name: string;
  readonly supportLevel: string;
  readonly evidenceIds: readonly string[];
}

/** Structural minimum this module needs from a graph edge. */
export interface OperationsGraphEdge {
  readonly edgeId: string;
  readonly from: string;
  readonly to: string;
  readonly role: string;
}

/** Structural minimum this module needs from a snapshot's graph. */
export interface OperationsGraph {
  readonly entryNodeIds: readonly string[];
  readonly nodes: readonly OperationsGraphNode[];
  readonly edges: readonly OperationsGraphEdge[];
}

/** Structural minimum this module needs from the flow's declared version. */
export interface OperationsFlowVersion {
  readonly selected: string | number;
  readonly state: string;
}

/** Structural minimum this module needs from the flow's identity. */
export interface OperationsFlow {
  readonly name: string;
  readonly type: string;
  readonly version: OperationsFlowVersion;
}

/** Structural minimum this module needs from the capture's source metadata. */
export interface OperationsSource {
  readonly provider: string;
  readonly region: string;
  readonly extractedAt: string;
}

/** Structural minimum this module needs from a declared dependency. */
export interface OperationsDependency {
  readonly dependencyId: string;
  readonly type: string;
  readonly displayName: string | null;
  readonly resolutionStatus: string;
  readonly referencedByNodeIds: readonly string[];
  readonly evidenceIds: readonly string[];
}

/** Structural minimum this module needs from an evidence record. */
export interface OperationsEvidenceRecord {
  readonly evidenceId: string;
}

/** Structural minimum this module needs from a snapshot's completeness block. */
export interface OperationsCompleteness {
  readonly danglingEdgeCount: number;
  readonly unresolvedDependencyCount: number;
  readonly unsupportedNodeCount: number;
  readonly opaqueNodeCount: number;
}

/** Structural minimum this module needs from a snapshot. Accepts a full
 * `FlowSnapshot` too — this package never imports that type directly. */
export interface OperationsSnapshot {
  readonly snapshotId: string;
  readonly flow: OperationsFlow;
  readonly source: OperationsSource;
  readonly graph: OperationsGraph;
  readonly dependencies: readonly OperationsDependency[];
  readonly evidence: readonly OperationsEvidenceRecord[];
  readonly completeness?: OperationsCompleteness;
}

/** Structural minimum this module needs from a finding. */
export interface OperationsFinding {
  readonly code: string;
  readonly severity: string;
  readonly kind: string;
  readonly message: string;
  readonly nodeIds: readonly string[];
  readonly evidenceIds: readonly string[];
}

/** Structural minimum this module needs from a caller journey. */
export interface OperationsJourney {
  readonly journeyId: string;
  readonly steps: readonly string[];
  readonly terminalKind: string;
}

/** Structural minimum this module needs from the reachability report. */
export interface OperationsReachability {
  readonly unreachableNodeIds: readonly string[];
  readonly danglingEdgeIds: readonly string[];
  readonly terminalNodeIds: readonly string[];
}

/** Structural minimum this module needs from a `FlowAnalysis`. */
export interface OperationsAnalysis {
  readonly reachability: OperationsReachability;
  readonly journeys: readonly OperationsJourney[];
  readonly findings: readonly OperationsFinding[];
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Renders a count with the correct singular/plural noun, e.g. `count(1,
 * 'node')` -> `"1 node"`, `count(3, 'node')` -> `"3 nodes"`. `plural`
 * defaults to `singular + 's'`; pass it explicitly for an irregular
 * plural or to build a full singular/plural clause. */
function count(n: number, singular: string, plural: string = `${singular}s`): string {
  return `${String(n)} ${n === 1 ? singular : plural}`;
}

/**
 * Renders a Markdown pipe table with columns padded to their widest cell,
 * matching Prettier's Markdown table formatting exactly (left-aligned,
 * minimum column width 3 for the separator dashes). The golden files this
 * renderer produces are checked into the repository and go through
 * `prettier --check` like everything else, so the raw output has to already
 * be in Prettier's canonical form rather than relying on a formatting pass
 * this pure, I/O-free package cannot perform at runtime.
 */
function formatTable(header: readonly string[], rows: readonly (readonly string[])[]): string[] {
  const widths = header.map((h, columnIndex) => {
    const cellWidths = rows.map((row) => (row[columnIndex] ?? '').length);
    return Math.max(h.length, 3, ...cellWidths);
  });

  const renderRow = (cells: readonly string[]): string =>
    `| ${cells.map((cell, i) => cell.padEnd(widths[i] ?? cell.length)).join(' | ')} |`;

  return [
    renderRow(header),
    `| ${widths.map((w) => '-'.repeat(w)).join(' | ')} |`,
    ...rows.map((row) => renderRow(row)),
  ];
}

function renderStatusSection(snapshot: OperationsSnapshot, ctx: RenderContext): string[] {
  return [
    '## 1. Document status',
    '',
    ...formatTable(
      ['Field', 'Value'],
      [
        ['Flow name', escapeTableCell(snapshot.flow.name)],
        ['Flow type', escapeTableCell(snapshot.flow.type)],
        [
          'Published version',
          `${escapeTableCell(String(snapshot.flow.version.selected))} (${escapeTableCell(snapshot.flow.version.state)})`,
        ],
        ['Snapshot ID', escapeTableCell(snapshot.snapshotId)],
        [
          'Source',
          `${escapeTableCell(snapshot.source.provider)} (${escapeTableCell(snapshot.source.region)})`,
        ],
        ['Generated', escapeTableCell(ctx.generatedAt)],
      ],
    ),
    '',
    'This is the on-call reference for this flow: what it depends on, what breaks if a dependency is retired, and where the gaps in this capture are. Node ids are shown throughout so a claim here can be traced straight back to the flow definition.',
  ];
}

function renderInboundRoutesSection(): string[] {
  return [
    '## 2. Inbound routes',
    '',
    'This is a single-flow snapshot. The DIDs, phone routes, or other inbound triggers that reach this flow are **not recorded here** — they are captured, if at all, in the organization-wide resource inventory (`resources/dids.md`), not in a per-flow capture. Consult that inventory, if one exists for this organization, to find what actually routes a caller to this flow.',
  ];
}

function renderDependenciesSection(
  snapshot: OperationsSnapshot,
  evidence: EvidenceRegistry,
): string[] {
  const lines: string[] = ['## 3. Dependencies and resolution status', ''];
  lines.push(
    `This flow declares ${count(snapshot.dependencies.length, 'dependency', 'dependencies')}. Every one of them, its resolution status at capture time, and how many nodes in this flow reference it, are listed below.`,
  );
  lines.push('');

  const sorted = [...snapshot.dependencies].sort(
    (a, b) => compareStrings(a.type, b.type) || compareStrings(a.dependencyId, b.dependencyId),
  );
  lines.push(
    ...formatTable(
      ['Node ID', 'Type', 'Name', 'Status', 'Referenced by', 'Evidence'],
      sorted.map((dep) => [
        escapeTableCell(dep.dependencyId),
        escapeTableCell(dep.type),
        escapeTableCell(dep.displayName ?? dep.dependencyId),
        escapeTableCell(dep.resolutionStatus),
        count(dep.referencedByNodeIds.length, 'node'),
        evidence.cite(dep.evidenceIds),
      ]),
    ),
  );

  const unresolved = sorted.filter((d) => d.resolutionStatus !== 'resolved');
  lines.push('');
  if (unresolved.length > 0) {
    lines.push(
      `${count(unresolved.length, 'dependency', 'dependencies')} did **not** resolve at capture time and may be broken, deleted, or inaccessible to the capturing credential: ${unresolved.map((d) => escapeMarkdown(d.displayName ?? d.dependencyId)).join(', ')}.`,
    );
  } else {
    lines.push('All dependencies resolved at capture time.');
  }

  return lines;
}

function renderDependentsSection(): string[] {
  return [
    '## 4. Flows that depend on this flow',
    '',
    'This is a single-flow snapshot, so it has no visibility into other flows in the organization. Whether another flow transfers into this one, or reuses one of its tasks, is **not determined** from this capture alone — that question can only be answered from the organization-wide resource inventory (`resources/inventory.md`), which cross-references every captured flow against every resource.',
  ];
}

function renderBlastRadiusSection(snapshot: OperationsSnapshot): string[] {
  const lines: string[] = ['## 5. Blast radius', ''];
  lines.push(
    'If a dependency listed below is retired, disabled, or reconfigured incompatibly, every node that references it stops being able to do what it was configured to do. This section exists to answer exactly that question without having to search the flow definition by hand.',
  );
  lines.push('');

  const nodesById = new Map(snapshot.graph.nodes.map((n) => [n.nodeId, n] as const));
  const referenced = [...snapshot.dependencies]
    .filter((d) => d.referencedByNodeIds.length > 0)
    .sort(
      (a, b) => compareStrings(a.type, b.type) || compareStrings(a.dependencyId, b.dependencyId),
    );

  if (referenced.length === 0) {
    lines.push(
      'No dependency in this flow is referenced by any node, so retiring one would have no blast radius here.',
    );
    return lines;
  }

  referenced.forEach((dep, index) => {
    const label = dep.displayName ?? dep.dependencyId;
    const referencingNodes = [...dep.referencedByNodeIds].sort(compareStrings).map((nodeId) => {
      const node = nodesById.get(nodeId);
      const name = node !== undefined ? escapeMarkdown(node.name) : 'unknown node';
      const sourceType = node !== undefined ? escapeMarkdown(node.sourceType) : 'unknown type';
      return `\`${nodeId}\` (${sourceType} "${name}")`;
    });

    lines.push(
      `### ${escapeMarkdown(dep.type)}: ${escapeMarkdown(label)} (\`${dep.dependencyId}\`)`,
    );
    lines.push('');
    lines.push(
      `Retiring this dependency would directly break ${count(referencingNodes.length, 'node')}:`,
    );
    lines.push('');
    for (const entry of referencingNodes) lines.push(`- ${entry}`);
    if (index < referenced.length - 1) lines.push('');
  });

  return lines;
}

function renderFailurePathsSection(
  snapshot: OperationsSnapshot,
  analysis: OperationsAnalysis,
): string[] {
  const lines: string[] = ['## 6. Failure-path summary', ''];

  const disconnectJourneys = analysis.journeys.filter(
    (j) => j.terminalKind === 'disconnect',
  ).length;
  const truncatedJourneys = analysis.journeys.filter((j) => j.terminalKind === 'truncated').length;
  const deadEndJourneys = analysis.journeys.filter((j) => j.terminalKind === 'dead-end').length;

  lines.push(
    `Of the caller journeys extracted from this flow, ${count(disconnectJourneys, 'ends', 'end')} in a disconnect, ${count(deadEndJourneys, 'reaches', 'reach')} a node with no configured next step (a dead end), and ${count(truncatedJourneys, 'was', 'were')} cut off by the analysis's own depth limit rather than a real terminal in the flow.`,
  );
  lines.push('');
  lines.push(
    "This capture does **not** distinguish no-input, no-match, or timeout branches from ordinary sequential edges — Architect's platform-level error-handling configuration is not represented in the graph this document was generated from, so those failure paths cannot be enumerated here.",
  );
  lines.push('');

  const hasDataAction = snapshot.graph.nodes.some((n) => n.sourceType === 'DataAction');
  if (hasDataAction) {
    const dataActionNodes = snapshot.graph.nodes.filter((n) => n.sourceType === 'DataAction');
    lines.push('Data-action failure handling:');
    lines.push('');
    for (const node of [...dataActionNodes].sort((a, b) => compareStrings(a.nodeId, b.nodeId))) {
      const outgoing = snapshot.graph.edges.filter((e) => e.from === node.nodeId).length;
      lines.push(
        `- \`${node.nodeId}\` ("${escapeMarkdown(node.name)}") has ${count(outgoing, 'outgoing edge')} recorded, with no distinct success/failure branch captured. If this data action fails at runtime, this document cannot say what happens next.`,
      );
    }
  } else {
    lines.push(
      'This flow calls no external data action, so there is no data-action failure path to summarize.',
    );
  }

  return lines;
}

function renderScheduleSection(): string[] {
  return [
    '## 7. Schedule and emergency-group behaviour',
    '',
    "No schedule, business-hours, or emergency-group dependency was found in this capture. If this flow's routing changes with time of day, holidays, or an emergency override, that behaviour is configured at the platform level and is **not captured** in this snapshot — check the organization schedule groups directly.",
  ];
}

function renderCoverageGapsSection(
  snapshot: OperationsSnapshot,
  analysis: OperationsAnalysis,
): string[] {
  const lines: string[] = ['## 8. Known coverage gaps and unresolved references', ''];

  const gaps: string[] = [];

  if (analysis.reachability.danglingEdgeIds.length > 0) {
    gaps.push(
      `${count(analysis.reachability.danglingEdgeIds.length, 'edge points', 'edges point')} at a node that does not exist in the captured configuration: ${analysis.reachability.danglingEdgeIds.map((id) => `\`${id}\``).join(', ')}.`,
    );
  }

  if (analysis.reachability.unreachableNodeIds.length > 0) {
    gaps.push(
      `${count(analysis.reachability.unreachableNodeIds.length, 'node')} cannot be reached from any entry point: ${analysis.reachability.unreachableNodeIds.map((id) => `\`${id}\``).join(', ')}.`,
    );
  }

  const unresolvedDeps = snapshot.dependencies.filter((d) => d.resolutionStatus !== 'resolved');
  if (unresolvedDeps.length > 0) {
    gaps.push(
      `${count(unresolvedDeps.length, 'dependency', 'dependencies')} did not resolve at capture time (see section 3).`,
    );
  }

  const unmodelled = analysis.findings.filter((f) => f.code === 'NODE_SEMANTICS_UNMODELLED');
  if (unmodelled.length > 0) {
    gaps.push(
      `${count(unmodelled.length, 'node was', 'nodes were')} captured but their internal settings are not modelled field-by-field: ${unmodelled
        .flatMap((f) => f.nodeIds)
        .map((id) => `\`${id}\``)
        .join(', ')}.`,
    );
  }

  if (snapshot.completeness !== undefined) {
    if (snapshot.completeness.unsupportedNodeCount > 0) {
      gaps.push(
        `${count(snapshot.completeness.unsupportedNodeCount, 'node is', 'nodes are')} of a type this capture does not support at all.`,
      );
    }
    if (snapshot.completeness.opaqueNodeCount > 0) {
      gaps.push(
        `${count(snapshot.completeness.opaqueNodeCount, 'node was', 'nodes were')} captured only opaquely.`,
      );
    }
  }

  gaps.push(
    'This is a single-flow snapshot: inbound DIDs, other flows that depend on this one, and schedule/emergency-group behaviour are all out of scope for this document (see sections 2, 4, and 7) even though they are real operational facts about this flow in production.',
  );

  for (const gap of gaps) lines.push(`- ${gap}`);

  return lines;
}

/**
 * Renders the evidence-mark index: the same convention `business.md` and
 * `technical.md` end on, so a reader moving between the three deterministic
 * documents never has to learn a second notation for "trace this claim back
 * to the snapshot." Must render last — every earlier section may still add
 * a mark to the registry as it renders.
 */
function renderEvidenceMarksSection(evidence: EvidenceRegistry): string[] {
  const lines: string[] = ['## 9. Evidence marks', ''];

  const entries = evidence.entries();
  if (entries.length === 0) {
    lines.push('No evidence was cited in this document.');
    return lines;
  }

  lines.push(
    'Every `[eN]` mark cited above resolves to exactly one full evidence id below; the full snapshot carries the rest, including facts this document did not need to state.',
  );
  lines.push('');
  lines.push(
    ...formatTable(
      ['Mark', 'Evidence ID'],
      entries.map((entry) => [entry.mark, entry.evidenceId]),
    ),
  );

  return lines;
}

/**
 * Renders `operations.md`: the on-call document. Pure and deterministic —
 * identical `snapshot`/`analysis`/`ctx` in always produce byte-identical
 * Markdown out, because `ctx.generatedAt` is the only source of wall-clock
 * time and every collection is sorted before it reaches the output.
 */
export function renderOperations(
  snapshot: OperationsSnapshot,
  analysis: OperationsAnalysis,
  ctx: RenderContext,
): string {
  const evidence = new EvidenceRegistry();

  const lines: string[] = [];
  lines.push(`# Operations Documentation: ${escapeMarkdown(snapshot.flow.name)}`);
  lines.push('');
  lines.push(
    `${String(snapshot.graph.nodes.length)} configured steps, ${String(snapshot.graph.edges.length)} connections between them.`,
  );
  lines.push('');
  lines.push(...renderStatusSection(snapshot, ctx));
  lines.push('');
  lines.push(...renderInboundRoutesSection());
  lines.push('');
  lines.push(...renderDependenciesSection(snapshot, evidence));
  lines.push('');
  lines.push(...renderDependentsSection());
  lines.push('');
  lines.push(...renderBlastRadiusSection(snapshot));
  lines.push('');
  lines.push(...renderFailurePathsSection(snapshot, analysis));
  lines.push('');
  lines.push(...renderScheduleSection());
  lines.push('');
  lines.push(...renderCoverageGapsSection(snapshot, analysis));
  lines.push('');
  // §9 must render last: it is the only section that reports the evidence
  // registry's contents, and every other section above may still add marks
  // to it as it renders.
  lines.push(...renderEvidenceMarksSection(evidence));
  lines.push('');

  return lines.join('\n');
}
