// packages/normalization/src/extract-edges.ts
import { asEdgeId, type EdgeId, type NodeId } from '@genesys-archivist/domain';
import type { RawFlowConfig } from './config-schema.js';
import type { ExtractedNode } from './extract-nodes.js';
import type { ExtractedDependency } from './extract-dependencies.js';
import type { NormalizationWarning } from './warnings.js';

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

export interface ExtractEdgesResult {
  readonly edges: readonly ExtractedEdge[];
  readonly warnings: readonly NormalizationWarning[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const asStringOrNull = (v: unknown): string | null =>
  typeof v === 'string' && v.length > 0 ? v : null;

/** Standard 8-4-4-4-12 hex UUID shape. Every node and dependency identifier
 * Architect assigns in this configuration is one of these; nothing else in
 * the source is, so this is the generic walk's sole test for "this string
 * might be a reference." */
const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolves a raw reference field into the identity space `extractNodes`
 * actually uses.
 *
 * `extractNodes` keys node identity on `trackingId` when it is present, so
 * `node.nodeId` is shaped `trk_<n>` and is never itself a GUID. Every
 * reference field (`startAction`, `nextAction`, `menuReference`,
 * `taskReference`, `paths[].nextActionId`) holds the raw GUID `id` instead.
 * Resolving through a `sourceId -> nodeId` lookup, built once from the
 * extracted nodes, is what keeps these two identity spaces in sync — the
 * same reconciliation `extractDependencies` needs for `context[].id`.
 *
 * A GUID that does not resolve to a known node is not automatically
 * dangling: measured on the real corpus, fields like `outcomeId`,
 * `milestoneId`, `datatableId`, and `flowId` are real, resolvable
 * references that simply point at a manifest *dependency* rather than a
 * node — `extractEdges` only ever produces node-to-node edges, so these
 * correctly yield no edge, but reporting them as broken would be a false
 * claim, not a missing one. `resolveGuid` therefore also checks the
 * dependency id space before concluding a value is genuinely dangling.
 */
interface GuidResolution {
  readonly nodeId: NodeId | null;
  /** True only when a real, GUID-shaped value was present, failed to
   * resolve against a node, and failed to resolve against a known
   * dependency id either. An absent field is not dangling — it is simply
   * not a reference at that site, and warning about it would be
   * false-positive noise (see the fourteen path entries with no
   * `nextActionId` at all). */
  readonly dangling: boolean;
}

function resolveGuid(
  raw: unknown,
  bySourceId: ReadonlyMap<string, NodeId>,
  dependencyIds: ReadonlySet<string>,
): GuidResolution {
  const guid = asStringOrNull(raw);
  if (guid === null) return { nodeId: null, dangling: false };
  const nodeId = bySourceId.get(guid) ?? null;
  if (nodeId !== null) return { nodeId, dangling: false };
  return { nodeId: null, dangling: !dependencyIds.has(guid) };
}

/**
 * Maps a branch path's `outputId` to a stable role. `__YES__` / `__NO__` /
 * `__DEFAULT__` are the literals measured on an inboundcall flow; Architect
 * also emits reserved `__`-wrapped literals specific to other action types
 * (`__NO_INTENT__`, `__KNOWLEDGE__`, `__MAX_NO_INPUTS__` on
 * `AskForNLUIntentAction`, measured on `bot-187-nodes.json`) and those are
 * preserved the same way — stripping the wrapper rather than guessing or
 * dropping, since a future Architect release may add more.
 *
 * Measured on the real corpus (bot, digitalbot, and inboundemail flows):
 * `outputId` is not always a `__`-wrapped literal at all. A dynamically
 * generated branch (`isDynamicBranch: true`, seen on `AskForNLUIntentAction`)
 * and a `SwitchAction` case both carry a GUID as the branch's own opaque,
 * self-contained identity instead — exhaustively checked against every
 * id-bearing object in all three configurations, none of these 24 sampled
 * GUIDs resolves to anything else in the source. It is not a reference, so
 * there is nothing to resolve and nothing to report as dangling; it is
 * simply not a `__`-wrapped literal. The one invariant that must hold
 * unconditionally is that this raw, meaningless-to-a-reader identifier must
 * never become `role` — the fact itself is not lost, because `condition`
 * (see `edgesFromFields`) still carries the raw `outputId` verbatim.
 */
function branchRole(rawPath: Record<string, unknown>): string {
  const outputId = rawPath['outputId'];
  if (outputId === '__YES__') return 'yes';
  if (outputId === '__NO__') return 'no';
  if (outputId === '__DEFAULT__') return 'default';
  if (typeof outputId === 'string' && outputId.length > 0 && !GUID_PATTERN.test(outputId)) {
    const stripped = outputId.replace(/^__+|__+$/g, '').toLowerCase();
    if (stripped.length > 0) return stripped;
  }
  return rawPath['isDynamicBranch'] === true ? 'dynamic-branch' : 'branch';
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

function danglingWarning(
  fromId: NodeId,
  path: string,
  fieldDescription: string,
): NormalizationWarning {
  return {
    code: 'DANGLING_REFERENCE',
    severity: 'warning',
    // The unresolved GUID value itself is never recorded — only the
    // structural field path and the (already-resolved) referencing node id.
    message: `${fieldDescription} does not resolve to any known node or dependency.`,
    path,
    nodeIds: [fromId],
  };
}

/**
 * Emits every edge whose source is `raw` itself: `startAction` on a
 * container, `nextAction` on a sequential action, `menuReference` /
 * `taskReference` on a transfer action, and each resolvable entry of
 * `paths[]`. Applied uniformly to containers, `actionList[]` entries, and
 * `menuChoiceList[].action` entries, because all three shapes reuse the same
 * reference fields.
 *
 * These five fields are Architect's best-attested reference shapes — the
 * only ones spike S1 measured against a real flow — so they keep their
 * specific, semantically-named roles (`entry`, `next`, `transfer-menu`,
 * `transfer-task`, and the branch roles from `branchRole`) rather than the
 * generic field-path-derived role `genericEdgesFromFields` (below) gives an
 * uncatalogued field. A GUID present here that fails to resolve raises
 * `DANGLING_REFERENCE`; a field simply absent raises nothing.
 */
function edgesFromFields(
  raw: Record<string, unknown>,
  fromId: NodeId | null,
  ownerPointer: string,
  bySourceId: ReadonlyMap<string, NodeId>,
  dependencyIds: ReadonlySet<string>,
  edges: ExtractedEdge[],
  warnings: NormalizationWarning[],
): void {
  if (fromId === null) return;

  const startAction = resolveGuid(raw['startAction'], bySourceId, dependencyIds);
  if (startAction.nodeId !== null) {
    edges.push(makeEdge(fromId, startAction.nodeId, 'entry', null, null, 'startAction'));
  } else if (startAction.dangling) {
    warnings.push(danglingWarning(fromId, `${ownerPointer}/startAction`, "Field 'startAction'"));
  }

  const nextAction = resolveGuid(raw['nextAction'], bySourceId, dependencyIds);
  if (nextAction.nodeId !== null) {
    edges.push(makeEdge(fromId, nextAction.nodeId, 'next', null, null, 'nextAction'));
  } else if (nextAction.dangling) {
    warnings.push(danglingWarning(fromId, `${ownerPointer}/nextAction`, "Field 'nextAction'"));
  }

  const menuReference = resolveGuid(raw['menuReference'], bySourceId, dependencyIds);
  if (menuReference.nodeId !== null) {
    edges.push(
      makeEdge(
        fromId,
        menuReference.nodeId,
        'transfer-menu',
        asStringOrNull(raw['menuName']),
        null,
        'menuReference',
      ),
    );
  } else if (menuReference.dangling) {
    warnings.push(
      danglingWarning(fromId, `${ownerPointer}/menuReference`, "Field 'menuReference'"),
    );
  }

  const taskReference = resolveGuid(raw['taskReference'], bySourceId, dependencyIds);
  if (taskReference.nodeId !== null) {
    edges.push(
      makeEdge(
        fromId,
        taskReference.nodeId,
        'transfer-task',
        asStringOrNull(raw['taskName']),
        null,
        'taskReference',
      ),
    );
  } else if (taskReference.dangling) {
    warnings.push(
      danglingWarning(fromId, `${ownerPointer}/taskReference`, "Field 'taskReference'"),
    );
  }

  const paths = raw['paths'];
  if (Array.isArray(paths)) {
    paths.forEach((rawPath: unknown, pathIndex) => {
      if (!isRecord(rawPath)) return;
      // Fourteen of the twenty branch entries in the reference fixture carry
      // no `nextActionId` at all: a labelled outcome that leads nowhere.
      // Those are terminal, not edges, and must not throw or warn.
      const target = resolveGuid(rawPath['nextActionId'], bySourceId, dependencyIds);
      const outputId = asStringOrNull(rawPath['outputId']);

      if (target.nodeId !== null) {
        const role = branchRole(rawPath);
        const label = asStringOrNull(rawPath['label']);
        edges.push(
          makeEdge(fromId, target.nodeId, role, label, outputId, `path:${outputId ?? 'unlabeled'}`),
        );
      } else if (target.dangling) {
        warnings.push(
          danglingWarning(
            fromId,
            `${ownerPointer}/paths/${String(pathIndex)}/nextActionId`,
            `Field 'paths[${String(pathIndex)}].nextActionId'`,
          ),
        );
      }
    });
  }
}

/** Fields the generic walk never treats as a candidate reference, at any
 * depth of a node's own configuration subtree:
 *
 *  - `id` is the object's own identity, never a forward reference. Measured
 *    directly against the reference fixture: every `id`-keyed GUID that
 *    equals a known node id is that node's *own* id (a self-loop risk, not
 *    a real edge); every `id`-keyed GUID that does not match anything is
 *    unrelated metadata (a manifest context id, a UI-builder id, a
 *    variable's own id) rather than a broken link. Treating `id` as a
 *    candidate would self-loop in the first case and manufacture
 *    false-positive `DANGLING_REFERENCE` noise in the second, with zero
 *    real references gained in exchange.
 *  - `referenceId` is the same kind of self-identity, one level down: a
 *    `ScreenPopAction`'s `inputs[]` and a `SwitchAction`'s `cases[]` each
 *    give their own entry a stable `referenceId`, not a pointer to
 *    anything. Measured across `bot-187-nodes.json`,
 *    `digitalbot-69-nodes.json`, `inboundemail-15-nodes.json`, and
 *    `inboundshortmessage-5-nodes.json`: 28 of 28 `referenceId` values
 *    resolve to nothing, ever — the same signature `id` has, under a
 *    different name.
 *  - `actionList`, `menuChoiceList`, `variables` are owned by
 *    `extractNodes` / `extractVariables` — each holds full node or variable
 *    objects, not references to them, so walking into them here would
 *    either double-count a structural child as a "reference field" or
 *    misread a variable's own `id` as a node reference (the same class of
 *    mistake `extract-variables.ts`'s `OWNED_ELSEWHERE` set exists to
 *    avoid, and this reuses that reasoning rather than inventing a second
 *    one).
 *  - The five names already handled by `edgesFromFields`, so the generic
 *    walk never double-emits an edge that already has a specific,
 *    semantically-named role.
 */
const ALWAYS_EXCLUDED_KEYS: ReadonlySet<string> = new Set([
  'id',
  'referenceId',
  'actionList',
  'menuChoiceList',
  'variables',
  'startAction',
  'nextAction',
  'menuReference',
  'taskReference',
  'paths',
]);

interface GuidCandidate {
  /** Path relative to the owning node's own raw object, e.g.
   * `"someNested[2]/targetId"`. Never includes a value — only structural
   * field names and array indices, which are safe to record verbatim. */
  readonly path: string;
  readonly value: string;
}

/**
 * Recursively collects every GUID-shaped string value reachable from `raw`
 * without crossing one of `ALWAYS_EXCLUDED_KEYS` or a value-ref wrapper
 * boundary.
 *
 * A value-ref wrapper — any object carrying a `config` key, per
 * `domain/value-ref.ts`'s `parseValueRef` — holds a *variable* reference
 * (`ref.val`), a literal, or an expression tree, never a node reference.
 * `extract-variables.ts`'s own walk stops at exactly this same boundary for
 * exactly this reason; reusing it here is what keeps a `DecisionAction`'s
 * `expression` or a `DataAction`'s `outputs[].value` from flooding the
 * output with one `DANGLING_REFERENCE` per variable read (variable ids and
 * node ids are both GUIDs, but distinct identity spaces — a variable ref
 * will never resolve against `bySourceId`, and should not be expected to).
 */
function collectGuidCandidates(raw: unknown, path: string, into: GuidCandidate[]): void {
  if (Array.isArray(raw)) {
    raw.forEach((item, index) => {
      collectGuidCandidates(item, `${path}[${String(index)}]`, into);
    });
    return;
  }
  if (!isRecord(raw)) return;
  if (isRecord(raw['config'])) return;

  for (const [key, value] of Object.entries(raw)) {
    if (ALWAYS_EXCLUDED_KEYS.has(key)) continue;
    const childPath = path.length > 0 ? `${path}/${key}` : key;
    if (typeof value === 'string') {
      if (GUID_PATTERN.test(value)) into.push({ path: childPath, value });
      continue;
    }
    collectGuidCandidates(value, childPath, into);
  }
}

/** `camelCase` / `PascalCase` -> `kebab-case`, matching the style of the
 * existing named roles (`transfer-menu`, `menu-choice`). */
function toKebabCase(segment: string): string {
  return segment
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[_\s]+/g, '-')
    .toLowerCase();
}

/** Derives a role from the last field name in a candidate's path, stripping
 * a trailing array index. Used only for fields the known-field catalogue
 * has never seen — see `edgesFromFields` for the named, catalogued roles. */
function roleFromPath(path: string): string {
  const segments = path.split('/');
  const last = segments[segments.length - 1] ?? path;
  const withoutIndex = last.replace(/\[\d+\]$/, '');
  return toKebabCase(withoutIndex.length > 0 ? withoutIndex : last);
}

/**
 * The generic, correct-by-construction fallback: any GUID-shaped value found
 * anywhere in `raw` outside the fields `edgesFromFields` already claims
 * becomes an edge when it resolves to a known node, and a warning either
 * way. This is what makes extraction correct on a flow type this normalizer
 * has never measured — a bot or workflow flow's own reference field names —
 * rather than silently producing an incomplete graph the way a five-name
 * allowlist does on anything but the one flow type it was measured against.
 *
 * Candidates are sorted by path before processing, not left in
 * `Object.entries` iteration order: two logically-identical configurations
 * that differ only in source key insertion order must still produce the
 * same edges in the same order (see the shuffled-key-order property test).
 */
function genericEdgesFromFields(
  raw: Record<string, unknown>,
  fromId: NodeId | null,
  ownerPointer: string,
  bySourceId: ReadonlyMap<string, NodeId>,
  dependencyIds: ReadonlySet<string>,
  edges: ExtractedEdge[],
  warnings: NormalizationWarning[],
): void {
  if (fromId === null) return;

  const candidates: GuidCandidate[] = [];
  collectGuidCandidates(raw, '', candidates);
  candidates.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  for (const candidate of candidates) {
    const resolution = resolveGuid(candidate.value, bySourceId, dependencyIds);
    const fieldPointer = `${ownerPointer}/${candidate.path}`;

    if (resolution.nodeId !== null) {
      edges.push(
        makeEdge(
          fromId,
          resolution.nodeId,
          roleFromPath(candidate.path),
          null,
          null,
          `field:${candidate.path}`,
        ),
      );
      warnings.push({
        code: 'UNRECOGNISED_REFERENCE_FIELD',
        severity: 'info',
        message: `Reference field '${candidate.path}' is outside the known field catalogue but resolved to a node.`,
        path: fieldPointer,
        nodeIds: [fromId, resolution.nodeId],
      });
    } else if (resolution.dangling) {
      warnings.push(danglingWarning(fromId, fieldPointer, `Field '${candidate.path}'`));
    }
    // The remaining case — `resolution.nodeId === null` and
    // `resolution.dangling === false` — is a GUID that resolved to a known
    // *dependency* rather than a node (see `resolveGuid`). That is neither
    // a graph edge nor a broken reference, so it is silently and correctly
    // skipped: the dependency itself is already represented in
    // `extractDependencies`'s output.
  }
}

/**
 * Walks the configuration by the same structural positions `extractNodes`
 * uses — `flowSequenceItemList`, each container's `actionList[]`, and each
 * container's `menuChoiceList[].action` — and turns every resolvable
 * reference field into an edge: the five catalogued fields via
 * `edgesFromFields`, and everything else via the generic walk in
 * `genericEdgesFromFields`.
 *
 * `menuChoiceList[].action` is structurally different from the others: the
 * choice's action is itself a node, so the edge runs from the *containing*
 * Menu node to that action's node, labelled with the choice's `digit` and
 * `name`. The action can then carry its own outgoing reference fields (a
 * `MenuAction` inside a choice still has a `menuReference`), so it is also
 * walked in its own right.
 */
export function extractEdges(
  cfg: RawFlowConfig,
  nodes: readonly ExtractedNode[],
  /** Threaded in so a GUID that resolves to a manifest dependency (measured:
   * `outcomeId`, `milestoneId`, `datatableId`, `flowId`, `screenPopId` on
   * the real corpus) can be told apart from one that resolves to nothing at
   * all. Defaults to `[]` for callers that only care about the node graph —
   * with no dependency list to check against, a dependency reference is
   * reported exactly as it would be if it were genuinely dangling, which is
   * the pre-existing, still-correct behaviour when dependency information
   * simply is not available. */
  dependencies: readonly ExtractedDependency[] = [],
): ExtractEdgesResult {
  const bySourceId = new Map<string, NodeId>();
  const pointerByNodeId = new Map<NodeId, string>();
  for (const node of nodes) {
    if (node.sourceId !== null) bySourceId.set(node.sourceId, node.nodeId);
    pointerByNodeId.set(node.nodeId, node.sourcePointer);
  }
  const dependencyIds = new Set(dependencies.map((dependency) => dependency.dependencyId));

  const edges: ExtractedEdge[] = [];
  const warnings: NormalizationWarning[] = [];

  const visit = (raw: Record<string, unknown>, fromId: NodeId | null): void => {
    if (fromId === null) return;
    const ownerPointer = pointerByNodeId.get(fromId) ?? '';
    edgesFromFields(raw, fromId, ownerPointer, bySourceId, dependencyIds, edges, warnings);
    genericEdgesFromFields(raw, fromId, ownerPointer, bySourceId, dependencyIds, edges, warnings);
  };

  cfg.flowSequenceItemList.forEach((rawItem) => {
    if (!isRecord(rawItem)) return;

    const containerId = resolveGuid(rawItem['id'], bySourceId, dependencyIds).nodeId;
    visit(rawItem, containerId);

    const actionList = rawItem['actionList'];
    if (Array.isArray(actionList)) {
      for (const rawAction of actionList) {
        if (!isRecord(rawAction)) continue;
        const actionId = resolveGuid(rawAction['id'], bySourceId, dependencyIds).nodeId;
        visit(rawAction, actionId);
      }
    }

    const menuChoiceList = rawItem['menuChoiceList'];
    if (Array.isArray(menuChoiceList)) {
      for (const rawChoice of menuChoiceList) {
        if (!isRecord(rawChoice)) continue;
        const action = rawChoice['action'];
        if (!isRecord(action)) continue;

        const actionId = resolveGuid(action['id'], bySourceId, dependencyIds).nodeId;
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

        visit(action, actionId);
      }
    }
  });

  return { edges, warnings };
}
