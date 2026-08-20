// packages/documentation/src/diagrams.ts
// Renders a flow graph as one or more Mermaid `flowchart` diagrams.
//
// Two things make this module more than string concatenation:
//
//   1. Every piece of tenant-authored text — node names, edge labels,
//      container names — is untrusted per AGENTS.md and is routed through
//      `escapeMermaidLabel` before it reaches Mermaid source. A node named
//      `evil --> injected` must render as text, never as a new edge.
//   2. A single diagram with more than `maxNodes` nodes is unreadable, and
//      docs/05 requires splitting by container (task/menu) instead. Each
//      node is drawn with a short, stable synthetic id (`n1`, `n2`, …); a
//      `%%`-comment legend maps the short label drawn on the node back to
//      the real node id, because neither the raw node id nor the full
//      tenant-authored name makes a good on-diagram label.
//
// Everything here is pure and deterministic: inputs are sorted before use
// so that Map/Set iteration order never reaches the output.

import { escapeMermaidLabel } from './escape.js';

/** Structural minimum this module needs from a graph node. */
export interface DiagramGraphNode {
  readonly nodeId: string;
  readonly sourceType: string;
  readonly name: string;
  readonly containerPath: readonly string[];
}

/** Structural minimum this module needs from a graph edge. */
export interface DiagramGraphEdge {
  readonly edgeId: string;
  readonly from: string;
  readonly to: string;
  readonly role: string;
  // The snapshot omits this key entirely for an unlabelled edge rather than
  // setting it to null (see normalize.ts), so both an explicit null and a
  // missing key mean "no label" here.
  readonly label?: string | null;
}

/** Structural minimum this module needs from a snapshot's graph. */
export interface DiagramGraph {
  readonly entryNodeIds: readonly string[];
  readonly nodes: readonly DiagramGraphNode[];
  readonly edges: readonly DiagramGraphEdge[];
}

/** Structural minimum this module needs from a snapshot's flow identity. */
export interface DiagramFlow {
  readonly name: string;
}

/** Structural minimum this module needs from a snapshot. */
export interface DiagramSnapshot {
  readonly flow: DiagramFlow;
  readonly graph: DiagramGraph;
}

/** Structural minimum this module needs from a cycle report. */
export interface DiagramCycles {
  readonly nodeIdsInCycles: readonly string[];
}

/** Structural minimum this module needs from a flow analysis. */
export interface DiagramAnalysis {
  readonly cycles: DiagramCycles;
}

export interface BuildDiagramsOptions {
  /** Maximum nodes drawn in a single diagram before splitting. Defaults to 30 per docs/05. */
  readonly maxNodes?: number;
}

export interface Diagram {
  readonly id: string;
  readonly title: string;
  readonly mermaid: string;
  readonly nodeIds: readonly string[];
}

const DEFAULT_MAX_NODES = 30;

// A raw node id or a full tenant-authored name both make a poor on-diagram
// label — one is meaningless, the other dominates the layout — so the
// visible label is escaped and further bounded here, tighter than
// escapeMermaidLabel's general 80-character safety cap.
const MAX_DISPLAY_LABEL_LENGTH = 40;

function shortLabel(text: string): string {
  const escaped = escapeMermaidLabel(text);
  if (escaped.length <= MAX_DISPLAY_LABEL_LENGTH) return escaped;
  return `${escaped.slice(0, MAX_DISPLAY_LABEL_LENGTH - 1)}…`;
}

function chunk<T>(items: readonly T[], size: number): (readonly T[])[] {
  if (size <= 0) return [items];
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

interface ContainerGroup {
  readonly containerPath: readonly string[];
  readonly nodes: readonly DiagramGraphNode[];
}

/** Groups nodes by containerPath, sorted by a canonical key so grouping order never depends on input order. */
function groupByContainerPath(nodes: readonly DiagramGraphNode[]): readonly ContainerGroup[] {
  const byKey = new Map<string, { containerPath: readonly string[]; nodes: DiagramGraphNode[] }>();
  for (const node of nodes) {
    const key = JSON.stringify(node.containerPath);
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, { containerPath: node.containerPath, nodes: [node] });
    } else {
      existing.nodes.push(node);
    }
  }
  return [...byKey.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, group]) => group);
}

function groupTitle(flowName: string, containerPath: readonly string[]): string {
  if (containerPath.length === 0) return shortLabel(flowName);
  return containerPath.map((segment) => shortLabel(segment)).join(' / ');
}

interface RenderDiagramParams {
  readonly id: string;
  readonly title: string;
  readonly nodes: readonly DiagramGraphNode[];
  readonly edges: readonly DiagramGraphEdge[];
  readonly cyclicNodeIds: ReadonlySet<string>;
}

function renderDiagram(params: RenderDiagramParams): Diagram {
  const { id, title, nodes, edges, cyclicNodeIds } = params;

  // Sort once here: everything downstream (short-id assignment, legend
  // order, node definition order) derives from this order, so the whole
  // diagram is deterministic regardless of the order nodes/edges arrived in.
  const sortedNodes = [...nodes].sort((a, b) => a.nodeId.localeCompare(b.nodeId));

  const shortIdByNodeId = new Map<string, string>();
  sortedNodes.forEach((node, index) => {
    shortIdByNodeId.set(node.nodeId, `n${String(index + 1)}`);
  });

  const nodeIdSet = new Set(sortedNodes.map((node) => node.nodeId));
  const sortedEdges = [...edges]
    .filter((edge) => nodeIdSet.has(edge.from) && nodeIdSet.has(edge.to))
    .sort((a, b) => a.edgeId.localeCompare(b.edgeId));

  const lines: string[] = ['flowchart TD', '%% Legend: short label -> node id'];

  for (const node of sortedNodes) {
    const label = shortLabel(node.name);
    const realNodeId = escapeMermaidLabel(node.nodeId);
    lines.push(`%% "${label}" -> ${realNodeId}`);
  }

  for (const node of sortedNodes) {
    const shortId = shortIdByNodeId.get(node.nodeId);
    if (shortId === undefined) continue;
    lines.push(`${shortId}["${shortLabel(node.name)}"]`);
  }

  for (const edge of sortedEdges) {
    const fromId = shortIdByNodeId.get(edge.from);
    const toId = shortIdByNodeId.get(edge.to);
    if (fromId === undefined || toId === undefined) continue;
    if (edge.label !== null && edge.label !== undefined && edge.label !== '') {
      lines.push(`${fromId} -->|"${escapeMermaidLabel(edge.label)}"| ${toId}`);
    } else {
      lines.push(`${fromId} --> ${toId}`);
    }
  }

  // A reader benefits from seeing which nodes participate in a loop —
  // this is styling only, built entirely from node ids we assigned
  // ourselves, so it carries no tenant text.
  const cyclicShortIds = sortedNodes
    .filter((node) => cyclicNodeIds.has(node.nodeId))
    .map((node) => shortIdByNodeId.get(node.nodeId))
    .filter((shortId): shortId is string => shortId !== undefined);
  if (cyclicShortIds.length > 0) {
    lines.push('classDef cyclic stroke:#d97706,stroke-width:2px;');
    lines.push(`class ${cyclicShortIds.join(',')} cyclic;`);
  }

  return {
    id,
    title,
    mermaid: lines.join('\n'),
    nodeIds: sortedNodes.map((node) => node.nodeId),
  };
}

/**
 * Renders a flow graph as one or more Mermaid flowchart diagrams.
 *
 * When the graph fits within `maxNodes`, a single diagram covers every
 * node. Otherwise the graph is split by `containerPath` — per docs/05,
 * splitting by task/menu rather than drawing one unreadable diagram with a
 * large cycle in the middle — and any container that is itself still over
 * the cap is further chunked so no single diagram ever exceeds it.
 */
export function buildDiagrams(
  snapshot: DiagramSnapshot,
  analysis: DiagramAnalysis,
  options?: BuildDiagramsOptions,
): readonly Diagram[] {
  const maxNodes = options?.maxNodes ?? DEFAULT_MAX_NODES;
  const cyclicNodeIds = new Set(analysis.cycles.nodeIdsInCycles);
  const { graph } = snapshot;

  if (graph.nodes.length <= maxNodes) {
    return [
      renderDiagram({
        id: 'flow',
        title: shortLabel(snapshot.flow.name),
        nodes: graph.nodes,
        edges: graph.edges,
        cyclicNodeIds,
      }),
    ];
  }

  const groups = groupByContainerPath(graph.nodes);
  const diagrams: Diagram[] = [];

  groups.forEach((group, groupIndex) => {
    const sortedGroupNodes = [...group.nodes].sort((a, b) => a.nodeId.localeCompare(b.nodeId));
    const chunks = chunk(sortedGroupNodes, maxNodes);
    const title = groupTitle(snapshot.flow.name, group.containerPath);

    chunks.forEach((chunkNodes, chunkIndex) => {
      const id =
        chunks.length > 1
          ? `diagram-${String(groupIndex + 1)}-part-${String(chunkIndex + 1)}`
          : `diagram-${String(groupIndex + 1)}`;
      const chunkTitle =
        chunks.length > 1
          ? `${title} (part ${String(chunkIndex + 1)} of ${String(chunks.length)})`
          : title;
      const chunkNodeIds = new Set(chunkNodes.map((node) => node.nodeId));
      const chunkEdges = graph.edges.filter(
        (edge) => chunkNodeIds.has(edge.from) && chunkNodeIds.has(edge.to),
      );

      diagrams.push(
        renderDiagram({
          id,
          title: chunkTitle,
          nodes: chunkNodes,
          edges: chunkEdges,
          cyclicNodeIds,
        }),
      );
    });
  });

  return diagrams;
}
