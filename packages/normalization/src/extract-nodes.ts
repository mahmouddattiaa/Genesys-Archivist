// packages/normalization/src/extract-nodes.ts
import { asNodeId, deriveNodeId, type NodeId } from '@genesys-archivist/domain';
import type { RawFlowConfig } from './config-schema.js';
import type { NormalizationWarning } from './warnings.js';

/** Structural role of a node within the flow: a container from
 * `flowSequenceItemList`, or a leaf action reached through `actionList`
 * or `menuChoiceList[].action`. */
export type NodeKind = 'container' | 'action';

/**
 * How confidently this node's `__type` is understood.
 *
 * `full` — `__type` is in `KNOWN_TYPES`; every field this normalizer knows
 * how to read for that type was read.
 * `partial` — `__type` is not in `KNOWN_TYPES`, but the node's identity,
 * name, container, and outgoing references were still fully captured (this
 * is what buildNode always produces for an unrecognised type; see
 * `KNOWN_TYPES`'s own comment for why that is the common case, not the
 * exceptional one). A `UNSUPPORTED_NODE_TYPE` warning is raised alongside
 * it, so the fact is on the record rather than resting on this comment
 * alone.
 * `opaque` and `unsupported` are reserved for a stricter failure this
 * extractor does not currently produce: a construct whose structural
 * position itself cannot be represented at all (as opposed to one whose
 * `__type` is merely uncatalogued). No code path here emits either today;
 * a future extractor that reads node-specific settings may need `opaque`
 * for a setting it cannot parse.
 */
export type NodeSupportLevel = 'full' | 'partial' | 'opaque' | 'unsupported';

export interface ExtractedNode {
  readonly nodeId: NodeId;
  /** String form of Architect's `trackingId`, or `null` when absent. */
  readonly trackingId: string | null;
  /** The raw GUID `id` Architect assigned, or `null` when absent. */
  readonly sourceId: string | null;
  readonly kind: NodeKind;
  readonly sourceType: string;
  readonly name: string;
  readonly containerPath: readonly string[];
  /**
   * RFC 6901 JSON pointer to this node inside the flow configuration.
   *
   * Evidence records must cite a location a reviewer can resolve back to the
   * source. Recording it during the walk is exact; re-deriving it afterwards
   * would mean duplicating this traversal and risking drift between the two.
   */
  readonly sourcePointer: string;
  readonly supportLevel: NodeSupportLevel;
}

export interface ExtractNodesResult {
  readonly nodes: readonly ExtractedNode[];
  readonly warnings: readonly NormalizationWarning[];
}

/**
 * `__type` values this normalizer understands, measured against the real
 * 47-node production flow (see docs/spikes/S1-source-path.md). Anything
 * outside this set is still extracted as a node — never dropped — but
 * marked `partial` and reported via a `UNSUPPORTED_NODE_TYPE` warning, so
 * downstream documentation never presents an interpretation of an
 * uncatalogued construct as fact while the loss itself stays visible rather
 * than resting on a comment. 41 other construct types are known to exist
 * across the wider corpus (see the "preserves an unrecognised type" test);
 * this set grows from measurement, not guesswork.
 */
const KNOWN_TYPES: ReadonlySet<string> = new Set([
  'Task',
  'Menu',
  'MenuAction',
  'PlayAudioAction',
  'TransferMenuAction',
  'TransferTaskAction',
  'TransferPureMatchAction',
  'DecisionAction',
  'DisconnectAction',
  'DataAction',
]);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const asString = (v: unknown): string => (typeof v === 'string' ? v : '');

interface Identity {
  readonly trackingId: string | null;
  readonly sourceId: string | null;
}

function readIdentity(raw: Record<string, unknown>): Identity {
  const trackingIdRaw = raw['trackingId'];
  const trackingId = typeof trackingIdRaw === 'number' ? String(trackingIdRaw) : null;

  const sourceIdRaw = raw['id'];
  const sourceId = typeof sourceIdRaw === 'string' && sourceIdRaw.length > 0 ? sourceIdRaw : null;

  return { trackingId, sourceId };
}

/**
 * Identity precedence, from S1: prefer the flow-unique `trackingId`, fall
 * back to the GUID `id`, and only then fall back to a derived id. Every
 * node in the production fixture carries the first two; the third path is
 * a fallback that must still hold for a well-formed configuration that
 * omits both.
 *
 * Per ADR-016, `deriveNodeId` firing at all is itself a fact worth
 * surfacing — the earlier assumption that this fallback was the common case
 * came from a YAML export taken without tracking IDs enabled, an artefact of
 * that export rather than of Architect. `buildNode` raises
 * `DERIVED_NODE_IDENTITY` whenever this path is taken, so a reviewer can see
 * it happened rather than needing to notice a coincidentally-shaped id.
 */
function deriveIdentity(
  identity: Identity,
  containerPath: readonly string[],
  sourceType: string,
  discriminator: string,
): NodeId {
  if (identity.trackingId !== null) return asNodeId(`trk_${identity.trackingId}`);
  if (identity.sourceId !== null) return asNodeId(identity.sourceId);
  return deriveNodeId({ containerPath, sourceType, discriminator });
}

interface BuiltNode {
  readonly node: ExtractedNode;
  readonly warnings: readonly NormalizationWarning[];
}

function buildNode(
  raw: Record<string, unknown>,
  containerPath: readonly string[],
  sourcePointer: string,
  index: number,
  kind: NodeKind,
): BuiltNode {
  const sourceType = asString(raw['__type']);
  const name = asString(raw['name']);
  const identity = readIdentity(raw);
  const nodeId = deriveIdentity(identity, containerPath, sourceType, `${String(index)}:${name}`);
  const supportLevel: NodeSupportLevel = KNOWN_TYPES.has(sourceType) ? 'full' : 'partial';

  const node: ExtractedNode = {
    nodeId,
    trackingId: identity.trackingId,
    sourceId: identity.sourceId,
    kind,
    sourceType,
    name,
    containerPath,
    sourcePointer,
    supportLevel,
  };

  const warnings: NormalizationWarning[] = [];
  if (supportLevel === 'partial') {
    warnings.push({
      code: 'UNSUPPORTED_NODE_TYPE',
      severity: 'warning',
      message: `sourceType '${sourceType}' is not in the known-types catalogue; the node is preserved with its identity, name, container, and references, but not interpreted.`,
      path: sourcePointer,
      nodeIds: [nodeId],
    });
  }
  if (identity.trackingId === null && identity.sourceId === null) {
    warnings.push({
      code: 'DERIVED_NODE_IDENTITY',
      severity: 'info',
      message:
        'Neither trackingId nor a source GUID was present; identity was derived from container path, sourceType, and position (ADR-016: a fallback, not the primary path).',
      path: sourcePointer,
      nodeIds: [nodeId],
    });
  }

  return { node, warnings };
}

/**
 * Walks the configuration by structural position only: each entry of
 * `flowSequenceItemList` is a container node; each container's
 * `actionList[]` and `menuChoiceList[].action` are leaf action nodes.
 *
 * This never recurses the whole object looking for `__type` — Architect
 * reuses action names as settings keys (`settingsActionDefaults.callData`
 * is a defaults block, not a `DataAction`), and a key-name walk invents
 * nodes that were never on the canvas.
 *
 * A structural position that is not itself a record (not an object at all —
 * a string, a number, `null`) cannot become a node: there is no `__type`,
 * `id`, or `name` to build one from. That entry is skipped, but the skip is
 * never silent: a `SCHEMA_DEVIATION` warning records exactly where it
 * happened, per AGENTS.md's rule against silently dropping a node.
 */
export function extractNodes(cfg: RawFlowConfig): ExtractNodesResult {
  const nodes: ExtractedNode[] = [];
  const warnings: NormalizationWarning[] = [];

  const deviate = (path: string): void => {
    warnings.push({
      code: 'SCHEMA_DEVIATION',
      severity: 'warning',
      message: 'Expected an object at this structural position but found something else.',
      path,
      nodeIds: [],
    });
  };

  cfg.flowSequenceItemList.forEach((rawItem, itemIndex) => {
    const itemPointer = `/flowSequenceItemList/${String(itemIndex)}`;
    if (!isRecord(rawItem)) {
      deviate(itemPointer);
      return;
    }

    const built = buildNode(rawItem, [], itemPointer, itemIndex, 'container');
    nodes.push(built.node);
    warnings.push(...built.warnings);
    const containerPath = [built.node.name];

    const actionList = rawItem['actionList'];
    if (Array.isArray(actionList)) {
      actionList.forEach((rawAction: unknown, actionIndex) => {
        const pointer = `${itemPointer}/actionList/${String(actionIndex)}`;
        if (!isRecord(rawAction)) {
          deviate(pointer);
          return;
        }
        const builtAction = buildNode(rawAction, containerPath, pointer, actionIndex, 'action');
        nodes.push(builtAction.node);
        warnings.push(...builtAction.warnings);
      });
    }

    const menuChoiceList = rawItem['menuChoiceList'];
    if (Array.isArray(menuChoiceList)) {
      menuChoiceList.forEach((rawChoice: unknown, choiceIndex) => {
        const choicePointer = `${itemPointer}/menuChoiceList/${String(choiceIndex)}`;
        if (!isRecord(rawChoice)) {
          deviate(choicePointer);
          return;
        }
        const action = rawChoice['action'];
        const pointer = `${choicePointer}/action`;
        if (!isRecord(action)) {
          deviate(pointer);
          return;
        }
        const builtChoice = buildNode(action, containerPath, pointer, choiceIndex, 'action');
        nodes.push(builtChoice.node);
        warnings.push(...builtChoice.warnings);
      });
    }
  });

  return { nodes, warnings };
}
