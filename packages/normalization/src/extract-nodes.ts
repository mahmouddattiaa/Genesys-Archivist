// packages/normalization/src/extract-nodes.ts
import { asNodeId, deriveNodeId, type NodeId } from '@genesys-archivist/domain';
import type { RawFlowConfig } from './config-schema.js';

/** Structural role of a node within the flow: a container from
 * `flowSequenceItemList`, or a leaf action reached through `actionList`
 * or `menuChoiceList[].action`. */
export type NodeKind = 'container' | 'action';

/** How confidently this node's `__type` is understood. An unrecognised
 * `__type` is never dropped — it is preserved as `unsupported`. */
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

/**
 * `__type` values this normalizer understands, measured against the real
 * 47-node production flow (see docs/spikes/S1-source-path.md). Anything
 * outside this set is still extracted as a node — never dropped — but
 * marked `unsupported` so downstream documentation never presents an
 * inference as fact.
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

function buildNode(
  raw: Record<string, unknown>,
  containerPath: readonly string[],
  sourcePointer: string,
  index: number,
  kind: NodeKind,
): ExtractedNode {
  const sourceType = asString(raw['__type']);
  const name = asString(raw['name']);
  const identity = readIdentity(raw);
  const nodeId = deriveIdentity(identity, containerPath, sourceType, `${String(index)}:${name}`);
  const supportLevel: NodeSupportLevel = KNOWN_TYPES.has(sourceType) ? 'full' : 'partial';

  return {
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
 */
export function extractNodes(cfg: RawFlowConfig): readonly ExtractedNode[] {
  const nodes: ExtractedNode[] = [];

  cfg.flowSequenceItemList.forEach((rawItem, itemIndex) => {
    if (!isRecord(rawItem)) return;

    const itemPointer = `/flowSequenceItemList/${String(itemIndex)}`;
    const container = buildNode(rawItem, [], itemPointer, itemIndex, 'container');
    nodes.push(container);
    const containerPath = [container.name];

    const actionList = rawItem['actionList'];
    if (Array.isArray(actionList)) {
      actionList.forEach((rawAction: unknown, actionIndex) => {
        if (!isRecord(rawAction)) return;
        const pointer = `${itemPointer}/actionList/${String(actionIndex)}`;
        nodes.push(buildNode(rawAction, containerPath, pointer, actionIndex, 'action'));
      });
    }

    const menuChoiceList = rawItem['menuChoiceList'];
    if (Array.isArray(menuChoiceList)) {
      menuChoiceList.forEach((rawChoice: unknown, choiceIndex) => {
        if (!isRecord(rawChoice)) return;
        const action = rawChoice['action'];
        if (!isRecord(action)) return;
        const pointer = `${itemPointer}/menuChoiceList/${String(choiceIndex)}/action`;
        nodes.push(buildNode(action, containerPath, pointer, choiceIndex, 'action'));
      });
    }
  });

  return nodes;
}
