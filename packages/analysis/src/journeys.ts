// @genesys-archivist/analysis
// Caller journey extraction over the flow graph.
//
// docs/05 is explicit: never enumerate all paths in a highly branching cyclic
// graph. The reference flow has a single strongly connected component
// spanning 35 of its 47 nodes, so a caller can reach almost any point from
// almost any other — naive path enumeration does not terminate in any useful
// sense. This module walks the graph depth-first with an explicit per-path
// visited set (so a revisited node stops that path rather than looping
// forever), and bounds both how deep a single path may go and how many
// journeys the walk may produce in total. The result is a bounded, honest
// sample of representative complete paths, not an exhaustive enumeration.

import type { ReachabilityGraphEdge, ReachabilityGraphNode } from './reachability.js';

/** Structural minimum this module needs from a node. Accepts a full FlowSnapshot node too. */
export interface JourneyGraphNode extends ReachabilityGraphNode {
  readonly sourceType: string;
  readonly evidenceIds?: readonly string[];
}

/** Structural minimum this module needs from an edge. */
export interface JourneyGraphEdge extends ReachabilityGraphEdge {
  readonly evidenceIds?: readonly string[];
}

/** Structural minimum this module needs from a snapshot's graph. */
export interface JourneyGraph {
  readonly entryNodeIds: readonly string[];
  readonly nodes: readonly JourneyGraphNode[];
  readonly edges: readonly JourneyGraphEdge[];
}

/** Structural minimum this module needs from a snapshot. */
export interface JourneySnapshot {
  readonly graph: JourneyGraph;
}

/**
 * Why a journey stopped:
 *  - `transfer`   the caller left this flow at a transfer node. Traversal
 *                  does not continue past it even if it has outgoing edges.
 *  - `disconnect`  the call ended.
 *  - `loop`        the walk would have revisited a node already on this
 *                  path. Stopped and labelled, not treated as an error.
 *  - `truncated`   the depth cap was hit before a natural terminal was found.
 *  - `dead-end`    no outgoing edges, and not a recognised terminal type.
 */
export type JourneyTerminalKind = 'transfer' | 'disconnect' | 'loop' | 'truncated' | 'dead-end';

export interface Journey {
  readonly journeyId: string;
  readonly steps: readonly string[];
  readonly terminalKind: JourneyTerminalKind;
  readonly evidenceIds: readonly string[];
}

export interface JourneyOptions {
  /** Maximum number of edges a single journey may traverse before it is truncated. */
  readonly maxDepth?: number;
  /** Maximum number of journeys the walk may produce in total. */
  readonly maxJourneys?: number;
}

/** Generous enough to cover the reference flow's 47 nodes with margin, small
 * enough that a pathological linear fixture still truncates quickly. */
const DEFAULT_MAX_DEPTH = 60;
/** Representative, not exhaustive — docs/05's rule in numeric form. */
const DEFAULT_MAX_JOURNEYS = 50;

/**
 * Node types whose name contains "Transfer" but which navigate WITHIN the
 * flow rather than handing the caller off.
 *
 * Spike S1 established the mapping from Architect YAML: `TransferMenuAction`
 * comes from `jumpToMenu` and `TransferTaskAction` from `menuJumpToTask` --
 * both are internal jumps. Only `TransferPureMatchAction`, from
 * `transferToAcd`, actually hands the caller to a queue.
 *
 * Treating the internal jumps as exits ended every journey at the first menu
 * hop, so the 35-node menu component was never explored and the flow appeared
 * to have three caller journeys instead of its real structure. Business
 * documentation built on that would have described the wrong IVR.
 */
const INTRA_FLOW_NAVIGATION: ReadonlySet<string> = new Set([
  'TransferMenuAction',
  'TransferTaskAction',
  'CallTaskAction',
  'TaskAction',
  'MenuAction',
  'PreviousMenuAction',
]);

/**
 * Recognises a genuine hand-off out of the flow.
 *
 * The name check still scales -- spike S1b found 41 node types beyond the ten
 * seen in the reference flow -- but it must exclude the internal-navigation
 * types above, which are jumps rather than exits. A new Transfer* type is
 * treated as an exit by default, which is the safer error: an over-short
 * journey is visibly incomplete, whereas walking through a hand-off invents a
 * caller experience that does not exist.
 */
function isTransferNode(sourceType: string): boolean {
  if (INTRA_FLOW_NAVIGATION.has(sourceType)) return false;
  return sourceType.includes('Transfer');
}

function isDisconnectNode(sourceType: string): boolean {
  return sourceType === 'DisconnectAction';
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function dedupeSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort(compareStrings);
}

interface StackFrame {
  readonly path: readonly string[];
  readonly visited: ReadonlySet<string>;
  readonly edgesTraversed: readonly JourneyGraphEdge[];
}

function buildJourney(
  frame: StackFrame,
  terminalKind: JourneyTerminalKind,
  nodesById: ReadonlyMap<string, JourneyGraphNode>,
  idDetail?: string,
): Journey {
  const nodeEvidence = frame.path.flatMap((nodeId) => nodesById.get(nodeId)?.evidenceIds ?? []);
  const edgeEvidence = frame.edgesTraversed.flatMap((edge) => edge.evidenceIds ?? []);
  const base = frame.path.join('>');
  const journeyId =
    idDetail !== undefined ? `${base}>${idDetail}:${terminalKind}` : `${base}:${terminalKind}`;

  return {
    journeyId,
    steps: frame.path,
    terminalKind,
    evidenceIds: dedupeSorted([...nodeEvidence, ...edgeEvidence]),
  };
}

/**
 * Walks the flow graph from every entry point to produce a bounded set of
 * representative caller journeys. Each journey is a simple path (no node
 * repeated within it) that ends at a business-relevant terminal: a transfer,
 * a disconnect, a dead end, a would-be repeat visit (`loop`), or the depth
 * cap (`truncated`).
 *
 * Traversal is an explicit-stack depth-first search rather than recursion,
 * consistent with the rest of this package's graph modules, and carries a
 * fresh visited set per path so cycles — normal in this genuinely cyclic
 * graph — stop a path instead of hanging the walk.
 */
export function extractJourneys(
  snapshot: JourneySnapshot,
  options: JourneyOptions = {},
): readonly Journey[] {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxJourneys = options.maxJourneys ?? DEFAULT_MAX_JOURNEYS;

  const { graph } = snapshot;
  const nodesById = new Map(graph.nodes.map((n) => [n.nodeId, n] as const));

  const outgoingByNode = new Map<string, JourneyGraphEdge[]>();
  for (const edge of graph.edges) {
    if (!nodesById.has(edge.from) || !nodesById.has(edge.to)) continue;
    const list = outgoingByNode.get(edge.from);
    if (list === undefined) {
      outgoingByNode.set(edge.from, [edge]);
    } else {
      list.push(edge);
    }
  }
  for (const list of outgoingByNode.values()) {
    list.sort((a, b) => compareStrings(a.edgeId, b.edgeId));
  }

  const journeys: Journey[] = [];

  const stack: StackFrame[] = [];
  for (const entryId of [...graph.entryNodeIds].reverse()) {
    if (!nodesById.has(entryId)) continue;
    stack.push({ path: [entryId], visited: new Set([entryId]), edgesTraversed: [] });
  }

  while (stack.length > 0) {
    if (journeys.length >= maxJourneys) break;
    const frame = stack.pop();
    if (frame === undefined) break;

    const currentId = frame.path[frame.path.length - 1];
    if (currentId === undefined) continue;
    const node = nodesById.get(currentId);
    if (node === undefined) continue;

    if (isTransferNode(node.sourceType)) {
      journeys.push(buildJourney(frame, 'transfer', nodesById));
      continue;
    }
    if (isDisconnectNode(node.sourceType)) {
      journeys.push(buildJourney(frame, 'disconnect', nodesById));
      continue;
    }
    if (frame.path.length - 1 >= maxDepth) {
      journeys.push(buildJourney(frame, 'truncated', nodesById));
      continue;
    }

    const outgoing = outgoingByNode.get(currentId) ?? [];
    if (outgoing.length === 0) {
      journeys.push(buildJourney(frame, 'dead-end', nodesById));
      continue;
    }

    for (const edge of [...outgoing].reverse()) {
      if (journeys.length >= maxJourneys) break;
      if (frame.visited.has(edge.to)) {
        journeys.push(buildJourney(frame, 'loop', nodesById, edge.to));
        continue;
      }
      const visited = new Set(frame.visited);
      visited.add(edge.to);
      stack.push({
        path: [...frame.path, edge.to],
        visited,
        edgesTraversed: [...frame.edgesTraversed, edge],
      });
    }
  }

  return [...journeys].sort((a, b) => compareStrings(a.journeyId, b.journeyId));
}
