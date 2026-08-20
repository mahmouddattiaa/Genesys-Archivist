// @genesys-archivist/analysis
// Reachability analysis over the flow graph. The graph is genuinely cyclic —
// IVR menus loop back to themselves — so traversal uses an explicit visited
// set. A recursive walk without one would not merely be wrong here, it would
// not terminate.

/** Structural minimum this module needs from a node. Accepts a full FlowSnapshot node too. */
export interface ReachabilityGraphNode {
  readonly nodeId: string;
}

/** Structural minimum this module needs from an edge. */
export interface ReachabilityGraphEdge {
  readonly edgeId: string;
  readonly from: string;
  readonly to: string;
  readonly role: string;
}

/** Structural minimum this module needs from a snapshot's graph. */
export interface ReachabilityGraph {
  readonly entryNodeIds: readonly string[];
  readonly nodes: readonly ReachabilityGraphNode[];
  readonly edges: readonly ReachabilityGraphEdge[];
}

/** Structural minimum this module needs from a snapshot. */
export interface ReachabilitySnapshot {
  readonly graph: ReachabilityGraph;
}

export interface ReachabilityReport {
  readonly reachableNodeIds: readonly string[];
  readonly unreachableNodeIds: readonly string[];
  readonly danglingEdgeIds: readonly string[];
  readonly terminalNodeIds: readonly string[];
}

/**
 * Determines which nodes are reachable from the declared entry points,
 * which edges point at nodes that do not exist in the graph, and which
 * nodes have no outgoing edge at all.
 *
 * Traversal is an iterative breadth-first walk over an explicit visited
 * set, so cycles (which are normal in an IVR flow) terminate safely.
 */
export function analyzeReachability(snapshot: ReachabilitySnapshot): ReachabilityReport {
  const { graph } = snapshot;
  const nodeIds = new Set(graph.nodes.map((n) => n.nodeId));

  const outgoingByNode = new Map<string, string[]>();
  const danglingEdgeIds: string[] = [];

  for (const edge of graph.edges) {
    if (!nodeIds.has(edge.to)) {
      danglingEdgeIds.push(edge.edgeId);
      continue;
    }
    if (!nodeIds.has(edge.from)) {
      continue;
    }
    const targets = outgoingByNode.get(edge.from);
    if (targets === undefined) {
      outgoingByNode.set(edge.from, [edge.to]);
    } else {
      targets.push(edge.to);
    }
  }

  const visited = new Set<string>();
  const queue: string[] = [];
  for (const entryId of graph.entryNodeIds) {
    if (nodeIds.has(entryId) && !visited.has(entryId)) {
      visited.add(entryId);
      queue.push(entryId);
    }
  }

  let cursor = 0;
  while (cursor < queue.length) {
    const current = queue[cursor];
    cursor += 1;
    if (current === undefined) continue;
    const targets = outgoingByNode.get(current) ?? [];
    for (const target of targets) {
      if (!visited.has(target)) {
        visited.add(target);
        queue.push(target);
      }
    }
  }

  const reachableNodeIds: string[] = [];
  const unreachableNodeIds: string[] = [];
  const terminalNodeIds: string[] = [];

  for (const node of graph.nodes) {
    if (visited.has(node.nodeId)) {
      reachableNodeIds.push(node.nodeId);
    } else {
      unreachableNodeIds.push(node.nodeId);
    }
    if (!outgoingByNode.has(node.nodeId)) {
      terminalNodeIds.push(node.nodeId);
    }
  }

  reachableNodeIds.sort();
  unreachableNodeIds.sort();
  terminalNodeIds.sort();
  danglingEdgeIds.sort();

  return {
    reachableNodeIds,
    unreachableNodeIds,
    danglingEdgeIds,
    terminalNodeIds,
  };
}
