// packages/capture/src/resource-graph.ts
import type {
  DependencyRef,
  DependencyResolution,
  DependencyResolutionStatus,
} from '@genesys-archivist/domain';

export interface ResourceResolver {
  resolve(refs: readonly DependencyRef[]): Promise<readonly DependencyResolution[]>;
  outwardRefs(resolution: DependencyResolution): readonly DependencyRef[];
}

export interface ResourceGraphNode {
  readonly key: string;
  readonly type: string;
  readonly id: string;
  readonly displayName: string | null;
  readonly resolutionStatus: DependencyResolutionStatus;
}

export interface ResourceGraphEdge {
  readonly from: string;
  readonly to: string;
  readonly viaNodeId: string;
  readonly viaField: string;
}

/**
 * Matches `schemas/resource-graph.schema.json` exactly (`nodes`, `edges`,
 * `orphans`) so a caller can attach `schemaVersion` and `captureId` and
 * validate without stripping anything first. That schema is a published
 * contract a separate migration server will read, so this type must never
 * grow a field the schema does not declare. Anything the caller needs that
 * the schema does not carry belongs on `ResourceGraphResult` instead.
 */
export interface ResourceGraph {
  readonly nodes: readonly ResourceGraphNode[];
  readonly edges: readonly ResourceGraphEdge[];
  readonly orphans: readonly string[];
}

/**
 * What the walk produced, plus what the caller needs to know about how it
 * ended.
 *
 * `graph` alone is the artifact: it matches `resource-graph.schema.json`
 * field-for-field and serializes into the bundle unchanged. The other fields
 * are deliberately NOT part of it — the schema constrains the published
 * document, not this function's return value, and those are different things.
 *
 * `truncated` exists because a walk stopped by the request budget produces a
 * graph that is structurally indistinguishable from a complete one. Every node
 * it did visit is present and honestly statused, so nothing is dropped per
 * node — but the *closure* is incomplete, and closure is the entire promise of
 * this walker. A caller sealing a migration bundle from a truncated graph
 * would ship something incomplete believing it complete, which is the exact
 * failure the "never silently drop" rule exists to prevent. Task 9 is expected
 * to surface this in the run manifest's warnings.
 */
export interface ResourceGraphResult {
  readonly graph: ResourceGraph;
  readonly truncated: boolean;
  readonly requests: number;
}

const keyOf = (ref: DependencyRef): string => `${ref.type}:${ref.id}`;

const DEFAULT_MAX_REQUESTS = 10_000;

const compareEdges = (a: ResourceGraphEdge, b: ResourceGraphEdge): number => {
  const fields: (keyof ResourceGraphEdge)[] = ['from', 'to', 'viaNodeId', 'viaField'];
  for (const field of fields) {
    if (a[field] < b[field]) return -1;
    if (a[field] > b[field]) return 1;
  }
  return 0;
};

/**
 * Worklist walk to closure over the reference graph.
 *
 * A visited set makes cyclic references terminate; IVRs legitimately contain
 * flow-to-flow cycles. A request budget (`options.maxRequests`) bounds a
 * pathological tenant so a single capture cannot run unbounded -- when the
 * budget is hit, the walk simply stops expanding further and returns what it
 * has, reporting it through `ResourceGraphResult.truncated` so the stop is
 * never invisible to the caller.
 *
 * Nothing resolvable-but-unreachable is ever dropped either: an unresolvable
 * reference (`not_found`, `forbidden`, ...) becomes a node carrying that
 * status explicitly, because a missing node and an unreachable node must be
 * distinguishable downstream.
 */
export async function buildResourceGraph(
  seeds: readonly DependencyRef[],
  resolver: ResourceResolver,
  options: { maxRequests?: number } = {},
): Promise<ResourceGraphResult> {
  const maxRequests = options.maxRequests ?? DEFAULT_MAX_REQUESTS;
  const nodes = new Map<string, ResourceGraphNode>();
  const edges: ResourceGraphEdge[] = [];
  const referenced = new Set<string>();

  let worklist: DependencyRef[] = [...seeds];
  let requests = 0;
  let truncated = false;

  while (worklist.length > 0) {
    const batch = worklist.filter((ref) => !nodes.has(keyOf(ref)));
    worklist = [];
    if (batch.length === 0) break;

    let budgetExhausted = false;
    if (requests + batch.length > maxRequests) {
      budgetExhausted = true;
      truncated = true;
      batch.length = Math.max(0, maxRequests - requests);
      if (batch.length === 0) break;
    }

    const resolutions = await resolver.resolve(batch);
    requests += batch.length;

    for (const resolution of resolutions) {
      const key = keyOf(resolution.ref);
      nodes.set(key, {
        key,
        type: resolution.ref.type,
        id: resolution.ref.id,
        displayName: resolution.displayName,
        resolutionStatus: resolution.status,
      });

      // A node that could not be read cannot be asked for its own references.
      if (resolution.status !== 'resolved') continue;

      for (const outward of resolver.outwardRefs(resolution)) {
        const to = keyOf(outward);
        edges.push({ from: key, to, viaNodeId: key, viaField: outward.type });
        referenced.add(to);
        if (!nodes.has(to)) worklist.push(outward);
      }
    }

    if (budgetExhausted) break;
  }

  const orphans = [...nodes.keys()].filter((key) => !referenced.has(key)).sort();

  return {
    graph: {
      nodes: [...nodes.values()].sort((a, b) => (a.key < b.key ? -1 : 1)),
      edges: [...edges].sort(compareEdges),
      orphans,
    },
    truncated,
    requests,
  };
}
