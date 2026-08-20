// packages/normalization/src/extract-edges.ts
import { asEdgeId, type EdgeId, type NodeId } from '@genesys-archivist/domain';
import type { RawFlowConfig } from './config-schema.js';
import type { ExtractedNode } from './extract-nodes.js';

/**
 * A structural edge between two nodes, measured directly from a reference
 * field on the source node's raw configuration object.
 */
export interface ExtractedEdge {
  readonly edgeId: EdgeId;
  readonly from: NodeId;
  readonly to: NodeId;
  readonly role: string;
  readonly label: string | null;
  /** The raw discriminator behind a branch edge (e.g. `__YES__`), or null. */
  readonly condition: string | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const asStringOrNull = (v: unknown): string | null =>
  typeof v === 'string' && v.length > 0 ? v : null;

/**
 * Resolves a raw reference field — always a node GUID in this configuration
 * shape — into the identity space `extractNodes` actually uses.
 *
 * `extractNodes` keys node identity on `trackingId` when it is present, so
 * `node.nodeId` is shaped `trk_<n>` and is never itself a GUID. Every
 * reference field (`startAction`, `nextAction`, `menuReference`,
 * `taskReference`, `paths[].nextActionId`) holds the raw GUID `id` instead.
 * Resolving through a `sourceId -> nodeId` lookup, built once from the
 * extracted nodes, is what keeps these two identity spaces in sync — the
 * same reconciliation `extractDependencies` needs for `context[].id`.
 *
 * A GUID that does not resolve to a known node returns null so the caller
 * can skip the edge outright: prefer a missing edge to a dangling one.
 */
function resolveGuid(raw: unknown, bySourceId: ReadonlyMap<string, NodeId>): NodeId | null {
  const guid = asStringOrNull(raw);
  if (guid === null) return null;
  return bySourceId.get(guid) ?? null;
}

/**
 * Maps a branch path's `outputId` to a stable role. Architect emits
 * `__YES__` / `__NO__` / `__DEFAULT__` in this flow; anything else is
 * preserved by stripping the `__` wrapper rather than guessed at or dropped,
 * since a future Architect release may add branch kinds this normalizer has
 * never seen.
 */
function branchRole(outputId: unknown): string {
  if (outputId === '__YES__') return 'yes';
  if (outputId === '__NO__') return 'no';
  if (outputId === '__DEFAULT__') return 'default';
  if (typeof outputId === 'string' && outputId.length > 0) {
    const stripped = outputId.replace(/^__+|__+$/g, '').toLowerCase();
    return stripped.length > 0 ? stripped : 'branch';
  }
  return 'branch';
}

function makeEdge(
  from: NodeId,
  to: NodeId,
  role: string,
  label: string | null,
  condition: string | null,
  /** A deterministic, structurally-derived disambiguator — never random,
   * never time-based — so `edgeId` stays stable across runs. */
  site: string,
): ExtractedEdge {
  return {
    edgeId: asEdgeId(`${from}->${to}#${role}@${site}`),
    from,
    to,
    role,
    label,
    condition,
  };
}

/**
 * Emits every edge whose source is `raw` itself: `startAction` on a
 * container, `nextAction` on a sequential action, `menuReference` /
 * `taskReference` on a transfer action, and each resolvable entry of
 * `paths[]`. Applied uniformly to containers, `actionList[]` entries, and
 * `menuChoiceList[].action` entries, because all three shapes reuse the same
 * reference fields.
 */
function edgesFromFields(
  raw: Record<string, unknown>,
  fromId: NodeId | null,
  bySourceId: ReadonlyMap<string, NodeId>,
): readonly ExtractedEdge[] {
  if (fromId === null) return [];
  const edges: ExtractedEdge[] = [];

  const startAction = resolveGuid(raw['startAction'], bySourceId);
  if (startAction !== null) {
    edges.push(makeEdge(fromId, startAction, 'entry', null, null, 'startAction'));
  }

  const nextAction = resolveGuid(raw['nextAction'], bySourceId);
  if (nextAction !== null) {
    edges.push(makeEdge(fromId, nextAction, 'next', null, null, 'nextAction'));
  }

  const menuReference = resolveGuid(raw['menuReference'], bySourceId);
  if (menuReference !== null) {
    edges.push(
      makeEdge(
        fromId,
        menuReference,
        'transfer-menu',
        asStringOrNull(raw['menuName']),
        null,
        'menuReference',
      ),
    );
  }

  const taskReference = resolveGuid(raw['taskReference'], bySourceId);
  if (taskReference !== null) {
    edges.push(
      makeEdge(
        fromId,
        taskReference,
        'transfer-task',
        asStringOrNull(raw['taskName']),
        null,
        'taskReference',
      ),
    );
  }

  const paths = raw['paths'];
  if (Array.isArray(paths)) {
    for (const rawPath of paths) {
      if (!isRecord(rawPath)) continue;
      // Fourteen of the twenty branch entries in the reference fixture carry
      // no `nextActionId` at all: a labelled outcome that leads nowhere.
      // Those are terminal, not edges, and must not throw.
      const target = resolveGuid(rawPath['nextActionId'], bySourceId);
      if (target === null) continue;

      const outputId = asStringOrNull(rawPath['outputId']);
      const role = branchRole(rawPath['outputId']);
      const label = asStringOrNull(rawPath['label']);
      edges.push(
        makeEdge(fromId, target, role, label, outputId, `path:${outputId ?? 'unlabeled'}`),
      );
    }
  }

  return edges;
}

/**
 * Walks the configuration by the same structural positions `extractNodes`
 * uses — `flowSequenceItemList`, each container's `actionList[]`, and each
 * container's `menuChoiceList[].action` — and turns every resolvable
 * reference field into an edge.
 *
 * `menuChoiceList[].action` is structurally different from the others: the
 * choice's action is itself a node, so the edge runs from the *containing*
 * Menu node to that action's node, labelled with the choice's `digit` and
 * `name`. The action can then carry its own outgoing reference fields (a
 * `MenuAction` inside a choice still has a `menuReference`), so it is also
 * passed through `edgesFromFields` in its own right.
 */
export function extractEdges(
  cfg: RawFlowConfig,
  nodes: readonly ExtractedNode[],
): readonly ExtractedEdge[] {
  const bySourceId = new Map<string, NodeId>();
  for (const node of nodes) {
    if (node.sourceId !== null) bySourceId.set(node.sourceId, node.nodeId);
  }

  const edges: ExtractedEdge[] = [];

  for (const rawItem of cfg.flowSequenceItemList) {
    if (!isRecord(rawItem)) continue;

    const containerId = resolveGuid(rawItem['id'], bySourceId);
    edges.push(...edgesFromFields(rawItem, containerId, bySourceId));

    const actionList = rawItem['actionList'];
    if (Array.isArray(actionList)) {
      for (const rawAction of actionList) {
        if (!isRecord(rawAction)) continue;
        const actionId = resolveGuid(rawAction['id'], bySourceId);
        edges.push(...edgesFromFields(rawAction, actionId, bySourceId));
      }
    }

    const menuChoiceList = rawItem['menuChoiceList'];
    if (Array.isArray(menuChoiceList)) {
      for (const rawChoice of menuChoiceList) {
        if (!isRecord(rawChoice)) continue;
        const action = rawChoice['action'];
        if (!isRecord(action)) continue;

        const actionId = resolveGuid(action['id'], bySourceId);
        if (containerId !== null && actionId !== null) {
          const digit = rawChoice['digit'];
          const digitLabel = typeof digit === 'number' ? String(digit) : null;
          const name = asStringOrNull(rawChoice['name']);
          const label =
            digitLabel !== null && name !== null ? `${digitLabel}: ${name}` : (name ?? digitLabel);
          const choiceId = asStringOrNull(rawChoice['id']) ?? 'unindexed';
          edges.push(
            makeEdge(containerId, actionId, 'menu-choice', label, null, `choice:${choiceId}`),
          );
        }

        edges.push(...edgesFromFields(action, actionId, bySourceId));
      }
    }
  }

  return edges;
}
