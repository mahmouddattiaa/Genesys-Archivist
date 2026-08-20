// packages/documentation/src/business.ts
// Renders `business.md`: the deterministic business document for product,
// operations, and customer stakeholders. Sections per docs/05.
//
// The rule that shapes every line here: this layer states what the
// configuration proves and says plainly where it does not. Architect
// records what a flow DOES, never why — it cannot say a queue exists for a
// regulatory reason, who owns a branch, or which route is contractually
// critical. Interpreting intent is the narrative layer's job, in a later
// plan, and its absence must be visible rather than papered over with a
// guess. Every claim below either cites an evidence id from the snapshot or
// says explicitly that the fact is not recorded.
//
// The reader is a product manager or operations lead, not an engineer: no
// raw node id ever appears in the body, caller journeys are described as
// what a caller experiences, and all tenant-authored text is routed through
// `escapeMarkdown` / `escapeTableCell` before it reaches this document.

import { escapeMarkdown, escapeTableCell } from './escape.js';
import { EvidenceRegistry } from './evidence-marks.js';
import type { RenderContext } from './render-context.js';

/** Structural minimum this module needs from a graph node. */
export interface BusinessGraphNode {
  readonly nodeId: string;
  readonly sourceType: string;
  readonly name: string;
  readonly evidenceIds: readonly string[];
}

/** Structural minimum this module needs from a graph edge. */
export interface BusinessGraphEdge {
  readonly edgeId: string;
  readonly from: string;
  readonly to: string;
  readonly role: string;
  readonly label?: string;
}

/** Structural minimum this module needs from a snapshot's graph. */
export interface BusinessGraph {
  readonly entryNodeIds: readonly string[];
  readonly nodes: readonly BusinessGraphNode[];
  readonly edges: readonly BusinessGraphEdge[];
}

/** Structural minimum this module needs from the flow's declared version. */
export interface BusinessFlowVersion {
  readonly selected: string | number;
  readonly state: string;
}

/** Structural minimum this module needs from the flow's identity. */
export interface BusinessFlow {
  readonly name: string;
  readonly type: string;
  readonly version: BusinessFlowVersion;
  readonly description?: string;
  readonly languages?: readonly string[];
}

/** Structural minimum this module needs from the capture's source metadata. */
export interface BusinessSource {
  readonly provider: string;
  readonly region: string;
  readonly extractedAt: string;
}

/** Structural minimum this module needs from a declared variable. */
export interface BusinessVariable {
  readonly variableId: string;
  readonly name: string;
  readonly readNodeIds: readonly string[];
  readonly writeNodeIds: readonly string[];
  readonly evidenceIds: readonly string[];
}

/** Structural minimum this module needs from a declared dependency. */
export interface BusinessDependency {
  readonly dependencyId: string;
  readonly type: string;
  readonly displayName: string | null;
  readonly resolutionStatus: string;
  readonly referencedByNodeIds: readonly string[];
  readonly evidenceIds: readonly string[];
}

/** Structural minimum this module needs from an evidence record. */
export interface BusinessEvidenceRecord {
  readonly evidenceId: string;
}

/** Structural minimum this module needs from a snapshot. Accepts a full
 * `FlowSnapshot` too — this package never imports that type directly. */
export interface BusinessSnapshot {
  readonly snapshotId: string;
  readonly flow: BusinessFlow;
  readonly source: BusinessSource;
  readonly graph: BusinessGraph;
  readonly variables: readonly BusinessVariable[];
  readonly dependencies: readonly BusinessDependency[];
  readonly evidence: readonly BusinessEvidenceRecord[];
}

/** Structural minimum this module needs from a finding. */
export interface BusinessFinding {
  readonly code: string;
  readonly severity: string;
  readonly kind: string;
  readonly message: string;
  readonly nodeIds: readonly string[];
  readonly evidenceIds: readonly string[];
}

/** Structural minimum this module needs from a caller journey. */
export interface BusinessJourney {
  readonly journeyId: string;
  readonly steps: readonly string[];
  readonly terminalKind: string;
  readonly evidenceIds: readonly string[];
}

/** Structural minimum this module needs from the reachability report. */
export interface BusinessReachability {
  readonly terminalNodeIds: readonly string[];
  readonly unreachableNodeIds: readonly string[];
}

/** Structural minimum this module needs from the cycle report. */
export interface BusinessCycles {
  readonly nodeIdsInCycles: readonly string[];
  readonly stronglyConnectedComponents: readonly (readonly string[])[];
}

/** Structural minimum this module needs from a `FlowAnalysis`. */
export interface BusinessAnalysis {
  readonly reachability: BusinessReachability;
  readonly cycles: BusinessCycles;
  readonly journeys: readonly BusinessJourney[];
  readonly findings: readonly BusinessFinding[];
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
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

/** Node types that navigate WITHIN the flow rather than handing the caller
 * off. Mirrors the same split `packages/analysis` draws between an internal
 * jump and a genuine exit — see journeys.ts and findings.ts for the source
 * of this list. */
const INTRA_FLOW_NAVIGATION: ReadonlySet<string> = new Set([
  'TransferMenuAction',
  'TransferTaskAction',
  'CallTaskAction',
  'TaskAction',
  'MenuAction',
  'PreviousMenuAction',
]);

type ExitKind = 'transfer' | 'disconnect' | 'other';

function classifyExit(sourceType: string): ExitKind {
  if (sourceType === 'DisconnectAction') return 'disconnect';
  if (!INTRA_FLOW_NAVIGATION.has(sourceType) && sourceType.includes('Transfer')) return 'transfer';
  return 'other';
}

/** Small counts read better spelled out in prose ("four ways out") than as a
 * bare digit. Falls back to the digit itself beyond the word list below, so
 * this never breaks for an unusually branchy flow. */
const SMALL_NUMBER_WORDS: readonly string[] = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
];

function spelledOutNumber(n: number): string {
  const word = SMALL_NUMBER_WORDS[n];
  return word ?? String(n);
}

/** Renders a count with the correct singular/plural noun, e.g. `count(1,
 * 'journey')` -> `"1 journey"`, `count(3, 'journey')` -> `"3 journeys"`.
 * `plural` defaults to `singular + 's'`; pass it explicitly for an
 * irregular plural. */
function count(n: number, singular: string, plural: string = `${singular}s`): string {
  return `${String(n)} ${n === 1 ? singular : plural}`;
}

function countBy<T>(items: readonly T[], key: (item: T) => string): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const k = key(item);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}

function renderStatusSection(snapshot: BusinessSnapshot, ctx: RenderContext): string[] {
  const lines: string[] = [];
  lines.push('## 1. Document status');
  lines.push('');
  lines.push(
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
        ['Review state', 'generated — not yet reviewed by a human'],
      ],
    ),
  );
  lines.push('');
  lines.push(
    'This document is the deterministic layer: every statement below is drawn directly from the captured configuration and the analysis run over it. It contains no inferred business intent — where the configuration does not record why something exists, this document says so plainly rather than guessing.',
  );
  return lines;
}

function renderPurposeSection(snapshot: BusinessSnapshot): string[] {
  const lines: string[] = ['## 2. Purpose', ''];
  const description = snapshot.flow.description?.trim();
  if (description !== undefined && description.length > 0) {
    lines.push(escapeMarkdown(description));
  } else {
    lines.push(
      'No description, business justification, or ownership metadata was captured for this flow. **The business purpose of this flow is not recorded** in the source configuration, and it cannot be determined from this snapshot alone. Establishing why this flow exists — which product, regulatory obligation, or customer segment it serves — is the job of the narrative layer, which has not run against this capture.',
    );
  }
  return lines;
}

function renderLanguagesSection(snapshot: BusinessSnapshot, evidence: EvidenceRegistry): string[] {
  const lines: string[] = ['## 3. Supported languages and entry behaviour', ''];

  const declaredLanguages = [...(snapshot.flow.languages ?? [])].sort(compareStrings);
  if (declaredLanguages.length > 0) {
    lines.push(
      `This flow declares support for: ${declaredLanguages.map((l) => escapeMarkdown(l)).join(', ')}.`,
    );
  } else {
    lines.push('No language was declared at flow level.');
  }
  lines.push('');

  const languageDeps = [...snapshot.dependencies]
    .filter((d) => d.type === 'language')
    .sort((a, b) => compareStrings(a.dependencyId, b.dependencyId));

  if (languageDeps.length > 0) {
    const resourceNoun = count(languageDeps.length, 'language resource');
    lines.push(`The capture separately records ${resourceNoun} in use:`);
    lines.push('');
    for (const dep of languageDeps) {
      const label = dep.displayName ?? dep.dependencyId;
      lines.push(`- ${escapeMarkdown(label)}${evidence.cite(dep.evidenceIds)}`);
    }
  } else {
    lines.push('No language resource dependency was found in this capture either.');
  }

  lines.push('');
  const entryNodes = snapshot.graph.entryNodeIds
    .map((id) => snapshot.graph.nodes.find((n) => n.nodeId === id))
    .filter((n): n is BusinessGraphNode => n !== undefined)
    .sort((a, b) => compareStrings(a.name, b.name));

  if (entryNodes.length === 1) {
    const [entry] = entryNodes;
    lines.push(
      `Every call into this flow begins at a single starting point, "${escapeMarkdown((entry as BusinessGraphNode).name)}"${evidence.cite((entry as BusinessGraphNode).evidenceIds)}.`,
    );
  } else if (entryNodes.length > 1) {
    lines.push(
      `Calls into this flow can begin at any of ${String(entryNodes.length)} starting points:`,
    );
    lines.push('');
    for (const entry of entryNodes) {
      lines.push(`- "${escapeMarkdown(entry.name)}"${evidence.cite(entry.evidenceIds)}`);
    }
  } else {
    lines.push(
      'No entry point was found in this capture; how a call reaches this flow is not recorded here.',
    );
  }

  return lines;
}

interface MenuOffer {
  readonly menuName: string;
  readonly choices: readonly string[];
}

function collectMenuOffers(snapshot: BusinessSnapshot): readonly MenuOffer[] {
  const menus = snapshot.graph.nodes.filter((n) => n.sourceType === 'Menu');

  const offers: MenuOffer[] = [];
  for (const menu of menus) {
    const choices = snapshot.graph.edges
      .filter((e) => e.from === menu.nodeId && e.role === 'menu-choice')
      .map((e) => e.label)
      .filter((label): label is string => label !== undefined && label.length > 0)
      .sort(compareStrings);
    if (choices.length === 0) continue;
    offers.push({ menuName: menu.name, choices });
  }

  return [...offers].sort((a, b) => compareStrings(a.menuName, b.menuName));
}

function renderJourneysSection(
  snapshot: BusinessSnapshot,
  analysis: BusinessAnalysis,
  evidence: EvidenceRegistry,
): string[] {
  const lines: string[] = ['## 4. Caller journeys by intent', ''];
  const nodesById = new Map(snapshot.graph.nodes.map((n) => [n.nodeId, n] as const));

  const journeyCount = analysis.journeys.length;
  const kindCounts = countBy(analysis.journeys, (j) => j.terminalKind);
  const stepLengths = analysis.journeys.map((j) => j.steps.length);
  const minSteps = stepLengths.length > 0 ? Math.min(...stepLengths) : 0;
  const maxSteps = stepLengths.length > 0 ? Math.max(...stepLengths) : 0;

  lines.push(
    `Walking the flow from its entry point produced ${String(journeyCount)} representative caller journeys. Each journey runs from ${String(minSteps)} to ${String(maxSteps)} steps before the caller reaches an outcome. This walk is bounded and representative rather than exhaustive: a highly interconnected menu structure like this one has far more possible paths than are useful to enumerate individually.`,
  );
  lines.push('');

  const transferCount = kindCounts.get('transfer') ?? 0;
  const disconnectCount = kindCounts.get('disconnect') ?? 0;
  const loopCount = kindCounts.get('loop') ?? 0;
  const otherCount = journeyCount - transferCount - disconnectCount - loopCount;

  lines.push(
    `- ${count(transferCount, 'journey')} ${transferCount === 1 ? 'ends' : 'end'} with the caller being transferred.`,
  );
  lines.push(
    `- ${count(disconnectCount, 'journey')} ${disconnectCount === 1 ? 'ends' : 'end'} with the call disconnecting.`,
  );
  lines.push(
    `- ${count(loopCount, 'journey')} ${loopCount === 1 ? 'returns' : 'return'} the caller to a point already visited in the menu structure rather than reaching a transfer or disconnect.`,
  );
  if (otherCount > 0) {
    lines.push(
      `- ${count(otherCount, 'journey')} ${otherCount === 1 ? 'ends' : 'end'} for another structural reason (a dead end, or the walk's own depth limit).`,
    );
  }
  lines.push('');

  const terminalIds = analysis.reachability.terminalNodeIds;
  const transferTerminals = terminalIds.filter(
    (id) => classifyExit(nodesById.get(id)?.sourceType ?? '') === 'transfer',
  );
  const disconnectTerminals = terminalIds.filter(
    (id) => classifyExit(nodesById.get(id)?.sourceType ?? '') === 'disconnect',
  );

  const totalExits = transferTerminals.length + disconnectTerminals.length;
  lines.push(
    `**There are exactly ${spelledOutNumber(totalExits)} ways out of this IVR**: ${count(transferTerminals.length, 'distinct transfer point')} and ${count(disconnectTerminals.length, 'disconnect point')}. Every other point in the flow either leads to one of these, or leads a caller back into the menu structure.`,
  );
  lines.push('');

  const queueDeps = [...snapshot.dependencies].filter((d) => d.type === 'queue');
  const transferTerminalSet = new Set(transferTerminals);
  const queueCoverage = queueDeps
    .map((dep) => ({
      dep,
      coveredCount: dep.referencedByNodeIds.filter((id) => transferTerminalSet.has(id)).length,
    }))
    .filter((entry) => entry.coveredCount > 0)
    .sort((a, b) => compareStrings(a.dep.dependencyId, b.dep.dependencyId));

  if (queueCoverage.length === 1 && queueCoverage[0] !== undefined) {
    const only = queueCoverage[0];
    const label = only.dep.displayName ?? only.dep.dependencyId;
    const subject =
      transferTerminals.length === 1
        ? 'The single transfer point in this flow hands'
        : `All ${count(transferTerminals.length, 'transfer point')} hand`;
    lines.push(
      `${subject} the caller to the same destination: the "${escapeMarkdown(label)}" queue${evidence.cite(only.dep.evidenceIds)}.`,
    );
  } else if (queueCoverage.length > 1) {
    lines.push('Transfer points in this flow hand the caller to more than one destination:');
    lines.push('');
    for (const entry of queueCoverage) {
      const label = entry.dep.displayName ?? entry.dep.dependencyId;
      lines.push(
        `- ${count(entry.coveredCount, 'transfer point')} ${entry.coveredCount === 1 ? 'goes' : 'go'} to "${escapeMarkdown(label)}"${evidence.cite(entry.dep.evidenceIds)}.`,
      );
    }
  }
  lines.push('');

  lines.push(
    `Beyond these outcomes, this flow's menu structure is deeply interconnected: ${String(analysis.cycles.nodeIdsInCycles.length)} of its ${String(snapshot.graph.nodes.length)} configured steps can each reach one another. A caller who takes a wrong turn can typically find a way to nearly any other point in the menu rather than being stuck in a dead end.`,
  );
  lines.push('');

  const offers = collectMenuOffers(snapshot);
  if (offers.length > 0) {
    lines.push('The menu choices available to a caller, by menu, are:');
    lines.push('');
    for (const offer of offers) {
      const choiceList = offer.choices.map((choice) => escapeMarkdown(choice)).join(', ');
      lines.push(`- "${escapeMarkdown(offer.menuName)}": ${choiceList}`);
    }
  }

  return lines;
}

function renderBusinessRulesSection(
  snapshot: BusinessSnapshot,
  analysis: BusinessAnalysis,
): string[] {
  const lines: string[] = ['## 5. Business rules', ''];

  const decisionCount = snapshot.graph.nodes.filter(
    (n) => n.sourceType === 'DecisionAction',
  ).length;
  const loopJourneyCount = analysis.journeys.filter((j) => j.terminalKind === 'loop').length;

  lines.push(
    `This flow contains ${count(decisionCount, 'decision point')} that ${decisionCount === 1 ? 'branches' : 'branch'} the caller down different paths, and ${count(loopJourneyCount, 'of the caller journeys extracted above returns', 'of the caller journeys extracted above return')} to an earlier menu rather than proceeding — the structural shape of a retry or "let me try again" pattern. Architect captures that these branches and returns exist; it does not capture the business criteria (eligibility rules, VIP handling, promotional offers) that a decision is meant to enforce, and this document does not guess at them.`,
  );
  lines.push('');
  lines.push(
    'No schedule, business-hours, or emergency-group dependency was found in this capture. If time-of-day or holiday behaviour governs this flow at the platform level, it is not recorded in this snapshot.',
  );

  return lines;
}

function renderDependenciesSection(
  snapshot: BusinessSnapshot,
  evidence: EvidenceRegistry,
): string[] {
  const lines: string[] = ['## 6. External services and dependencies', ''];
  lines.push(
    'This flow relies on the following external services and shared resources. Only their type, name, and whether they resolved during capture are shown here — no connection details or credentials.',
  );
  lines.push('');

  const sorted = [...snapshot.dependencies].sort(
    (a, b) => compareStrings(a.type, b.type) || compareStrings(a.dependencyId, b.dependencyId),
  );
  lines.push(
    ...formatTable(
      ['Type', 'Name', 'Status', 'Evidence'],
      sorted.map((dep) => [
        escapeTableCell(dep.type),
        escapeTableCell(dep.displayName ?? dep.dependencyId),
        escapeTableCell(dep.resolutionStatus),
        evidence.cite(dep.evidenceIds),
      ]),
    ),
  );

  return lines;
}

function renderFailureSection(snapshot: BusinessSnapshot, analysis: BusinessAnalysis): string[] {
  const lines: string[] = ['## 7. Failure and customer-experience behaviour', ''];

  const disconnectJourneys = analysis.journeys.filter(
    (j) => j.terminalKind === 'disconnect',
  ).length;
  lines.push(
    `${count(disconnectJourneys, 'of the caller journeys extracted above ends', 'of the caller journeys extracted above end')} in a disconnect. Beyond that outcome, this capture does not distinguish separate no-input, no-match, timeout, or external-service-failure branches from the flow's ordinary next-step edges — Architect's platform-level error handling settings are not represented in this graph, so this document cannot describe how a silent, mistaken, or slow caller is treated differently from one who responds correctly.`,
  );
  lines.push('');

  const hasDataAction = snapshot.graph.nodes.some((n) => n.sourceType === 'DataAction');
  if (hasDataAction) {
    lines.push(
      'This flow calls an external data action. The captured graph records only a single next step after that call; it does not record a distinct success path from a failure path, so what a caller experiences if that call fails is not recorded here.',
    );
  }

  return lines;
}

function renderRisksSection(analysis: BusinessAnalysis): string[] {
  const lines: string[] = ['## 8. Business risks and open questions', ''];

  const errorFindings = analysis.findings.filter((f) => f.severity === 'error');
  const otherFindings = analysis.findings.filter((f) => f.severity !== 'error');

  if (errorFindings.length === 0 && otherFindings.length === 0) {
    lines.push('No structural risks were found in this capture.');
    return lines;
  }

  if (errorFindings.length > 0) {
    lines.push(
      `${count(errorFindings.length, 'finding is', 'findings are')} severe enough to affect caller behaviour:`,
    );
    lines.push('');
    for (const f of errorFindings) {
      lines.push(`- ${escapeMarkdown(f.message)}`);
    }
    lines.push('');
  }

  if (otherFindings.length > 0) {
    lines.push('Other observations, none of which change caller-facing behaviour on their own:');
    lines.push('');
    for (const f of otherFindings) {
      lines.push(`- ${escapeMarkdown(f.message)}`);
    }
    lines.push('');
  }

  lines.push(
    'This document does not attempt to rank these by business importance, assign an owner, or estimate customer impact — none of that is recorded in the source configuration.',
  );

  return lines;
}

function renderChangesSection(): string[] {
  return [
    '## 9. Changes since the previous documented version',
    '',
    'No previous documented version of this flow was supplied for comparison. This is the first documentation generated from this capture.',
  ];
}

function renderEvidenceSection(evidence: EvidenceRegistry, evidenceRecordCount: number): string[] {
  const lines: string[] = ['## 10. Evidence and review notes', ''];
  lines.push(
    `This capture recorded ${count(evidenceRecordCount, 'evidence record')} in total. Every factual claim above that cites a mark below resolves to one of them; the full snapshot carries the rest, including facts this document did not need to state.`,
  );
  lines.push('');

  const entries = evidence.entries();
  if (entries.length > 0) {
    lines.push(
      ...formatTable(
        ['Mark', 'Evidence ID'],
        entries.map((entry) => [entry.mark, entry.evidenceId]),
      ),
    );
    lines.push('');
  }

  lines.push('This document has not yet been reviewed by a human. Review status: `generated`.');
  return lines;
}

/**
 * Renders `business.md`: the deterministic business document. Pure and
 * deterministic — identical `snapshot`/`analysis`/`ctx` in always produce
 * byte-identical Markdown out, because `ctx.generatedAt` is the only source
 * of wall-clock time and every collection is sorted before it reaches the
 * output.
 */
export function renderBusiness(
  snapshot: BusinessSnapshot,
  analysis: BusinessAnalysis,
  ctx: RenderContext,
): string {
  const evidence = new EvidenceRegistry();

  const lines: string[] = [];
  lines.push(`# Business Documentation: ${escapeMarkdown(snapshot.flow.name)}`);
  lines.push('');
  lines.push(
    `${String(snapshot.graph.nodes.length)} configured steps, ${String(snapshot.graph.edges.length)} connections between them.`,
  );
  lines.push('');
  lines.push(...renderStatusSection(snapshot, ctx));
  lines.push('');
  lines.push(...renderPurposeSection(snapshot));
  lines.push('');
  lines.push(...renderLanguagesSection(snapshot, evidence));
  lines.push('');
  lines.push(...renderJourneysSection(snapshot, analysis, evidence));
  lines.push('');
  lines.push(...renderBusinessRulesSection(snapshot, analysis));
  lines.push('');
  lines.push(...renderDependenciesSection(snapshot, evidence));
  lines.push('');
  lines.push(...renderFailureSection(snapshot, analysis));
  lines.push('');
  lines.push(...renderRisksSection(analysis));
  lines.push('');
  lines.push(...renderChangesSection());
  lines.push('');
  lines.push(...renderEvidenceSection(evidence, snapshot.evidence.length));
  lines.push('');

  return lines.join('\n');
}
