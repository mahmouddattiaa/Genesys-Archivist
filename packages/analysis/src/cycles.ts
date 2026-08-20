// @genesys-archivist/analysis
// Strongly connected component detection over the flow graph, using an
// iterative Tarjan's algorithm. IVRs legitimately contain retries and
// loops (docs/04), so this module reports cycles as a fact about the
// graph's shape — it never treats them as defects. A recursive Tarjan
// would blow the call stack on a sufficiently deep flow, so the walk here
// is iterative: an explicit work stack simulates the call frames instead
// of relying on the JS call stack.

import type { ReachabilityGraphEdge, ReachabilityGraphNode } from './reachability.js';

/** Structural minimum this module needs from a snapshot's graph. */
export interface CycleGraph {
  readonly entryNodeIds: readonly string[];
  readonly nodes: readonly ReachabilityGraphNode[];
  readonly edges: readonly ReachabilityGraphEdge[];
}

/** Structural minimum this module needs from a snapshot. */
export interface CycleSnapshot {
  readonly graph: CycleGraph;
}

export interface CycleReport {
  /** Non-trivial strongly connected components: size >= 2, or a single node with a self-loop. */
  readonly stronglyConnectedComponents: readonly (readonly string[])[];
  /** Every node id that participates in one of the components above, sorted and de-duplicated. */
  readonly nodeIdsInCycles: readonly string[];
}

interface DfsFrame {
  readonly node: string;
  neighborIndex: number;
}

/**
 * Finds strongly connected components in the flow graph via an iterative
 * Tarjan's algorithm. A component with fewer than two nodes is only
 * reported when it is a self-loop (the node has an edge back to itself) —
 * that is how a retry is expressed in an IVR. All output is sorted so the
 * result is deterministic regardless of traversal or Set/Map iteration
 * order.
 */
export function findCycles(snapshot: CycleSnapshot): CycleReport {
  const { graph } = snapshot;
  const nodeIds = new Set(graph.nodes.map((n) => n.nodeId));

  const adjacency = new Map<string, string[]>();
  const selfLoopNodes = new Set<string>();

  for (const edge of graph.edges) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) continue;
    if (edge.from === edge.to) selfLoopNodes.add(edge.from);
    const targets = adjacency.get(edge.from);
    if (targets === undefined) {
      adjacency.set(edge.from, [edge.to]);
    } else {
      targets.push(edge.to);
    }
  }

  const indices = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const tarjanStack: string[] = [];
  const components: string[][] = [];
  let nextIndex = 0;

  for (const startNode of graph.nodes) {
    if (indices.has(startNode.nodeId)) continue;

    const workStack: DfsFrame[] = [{ node: startNode.nodeId, neighborIndex: 0 }];
    indices.set(startNode.nodeId, nextIndex);
    lowlink.set(startNode.nodeId, nextIndex);
    nextIndex += 1;
    tarjanStack.push(startNode.nodeId);
    onStack.add(startNode.nodeId);

    while (workStack.length > 0) {
      const frame = workStack[workStack.length - 1];
      if (frame === undefined) break;
      const neighbors = adjacency.get(frame.node) ?? [];

      if (frame.neighborIndex < neighbors.length) {
        const neighbor = neighbors[frame.neighborIndex];
        frame.neighborIndex += 1;
        if (neighbor === undefined) continue;

        if (!indices.has(neighbor)) {
          indices.set(neighbor, nextIndex);
          lowlink.set(neighbor, nextIndex);
          nextIndex += 1;
          tarjanStack.push(neighbor);
          onStack.add(neighbor);
          workStack.push({ node: neighbor, neighborIndex: 0 });
        } else if (onStack.has(neighbor)) {
          const neighborIndex = indices.get(neighbor);
          const currentLow = lowlink.get(frame.node);
          if (
            neighborIndex !== undefined &&
            currentLow !== undefined &&
            neighborIndex < currentLow
          ) {
            lowlink.set(frame.node, neighborIndex);
          }
        }
        continue;
      }

      workStack.pop();
      const parentFrame = workStack[workStack.length - 1];
      if (parentFrame !== undefined) {
        const childLow = lowlink.get(frame.node);
        const parentLow = lowlink.get(parentFrame.node);
        if (childLow !== undefined && parentLow !== undefined && childLow < parentLow) {
          lowlink.set(parentFrame.node, childLow);
        }
      }

      if (lowlink.get(frame.node) === indices.get(frame.node)) {
        const component: string[] = [];
        for (;;) {
          const popped = tarjanStack.pop();
          if (popped === undefined) break;
          onStack.delete(popped);
          component.push(popped);
          if (popped === frame.node) break;
        }
        components.push(component);
      }
    }
  }

  const kept = components.filter(
    (c) => c.length >= 2 || (c[0] !== undefined && selfLoopNodes.has(c[0])),
  );
  const sortedComponents = kept
    .map((c) => [...c].sort())
    .sort((a, b) => a.join(',').localeCompare(b.join(',')));

  const nodeIdsInCycles = [...new Set(sortedComponents.flat())].sort();

  return {
    stronglyConnectedComponents: sortedComponents,
    nodeIdsInCycles,
  };
}
