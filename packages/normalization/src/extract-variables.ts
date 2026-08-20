// packages/normalization/src/extract-variables.ts
import { collectVariableReads, parseValueRef, type NodeId } from '@genesys-archivist/domain';
import type { RawFlowConfig } from './config-schema.js';
import type { ExtractedNode } from './extract-nodes.js';
import type { NormalizationWarning } from './warnings.js';

/** Where a variable is declared: the flow's own `config.variables[]`, or a
 * single Task container's `variables[]`. */
export type VariableScope = 'flow' | 'task';

/** Derived from `isInput`/`isOutput`. Neither flag set is the common case:
 * most variables are plain flow-local state. */
export type VariableDirection = 'input' | 'output' | 'inputOutput' | 'none';

export interface ExtractedVariable {
  readonly variableId: string;
  readonly name: string;
  readonly scope: VariableScope;
  /** RFC 6901 JSON pointer to this variable's declaration in the configuration. */
  readonly sourcePointer: string;
  /** Derived from `__type` (e.g. `BoolVariable` -> `bool`), never invented. */
  readonly dataType: string;
  readonly direction: VariableDirection;
  readonly isCollection: boolean;
  /** Carried through from `isSecure`. The value itself is never materialised. */
  readonly secure: boolean;
}

/** A variable's usage across the flow, indexed by variable id. */
export interface VariableUsage {
  readonly readBy: readonly NodeId[];
  readonly writtenBy: readonly NodeId[];
}

export type VariableUsageIndex = ReadonlyMap<string, VariableUsage>;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const asString = (v: unknown): string => (typeof v === 'string' ? v : '');

const asBoolean = (v: unknown): boolean => v === true;

/** `BoolVariable` -> `bool`, `StringVariable` -> `string`. Unknown suffixes
 * are kept verbatim rather than dropped. */
function deriveDataType(sourceType: string): string {
  const withoutSuffix = sourceType.endsWith('Variable')
    ? sourceType.slice(0, -'Variable'.length)
    : sourceType;
  if (withoutSuffix.length === 0) return '';
  return withoutSuffix.charAt(0).toLowerCase() + withoutSuffix.slice(1);
}

function deriveDirection(isInput: boolean, isOutput: boolean): VariableDirection {
  if (isInput && isOutput) return 'inputOutput';
  if (isInput) return 'input';
  if (isOutput) return 'output';
  return 'none';
}

function buildVariable(
  raw: Record<string, unknown>,
  scope: VariableScope,
  sourcePointer: string,
): ExtractedVariable {
  const sourceType = asString(raw['__type']);
  return {
    variableId: asString(raw['id']),
    name: asString(raw['name']),
    scope,
    sourcePointer,
    dataType: deriveDataType(sourceType),
    direction: deriveDirection(asBoolean(raw['isInput']), asBoolean(raw['isOutput'])),
    isCollection: asBoolean(raw['isCollection']),
    secure: asBoolean(raw['isSecure']),
  };
}

export interface ExtractVariablesResult {
  readonly variables: readonly ExtractedVariable[];
  readonly warnings: readonly NormalizationWarning[];
}

function schemaDeviation(path: string): NormalizationWarning {
  return {
    code: 'SCHEMA_DEVIATION',
    severity: 'warning',
    message: 'Expected an object at this variable-declaration position but found something else.',
    path,
    nodeIds: [],
  };
}

/**
 * Declared variables from every scope: the flow's own `config.variables[]`,
 * plus each Task container's `variables[]`. Identity is the GUID `id`
 * Architect assigns — the same id `ref.val` carries at every use site, so no
 * name-to-id join is ever needed to resolve a reference.
 *
 * A malformed entry — anything that is not itself an object — cannot become
 * a variable: there is no `__type`, `id`, or `name` to read. It is skipped,
 * but per AGENTS.md the skip is never silent; a `SCHEMA_DEVIATION` warning
 * records exactly where it happened, at the same flow- or task-scoped
 * pointer a well-formed sibling entry would have used.
 */
export function extractVariables(cfg: RawFlowConfig): ExtractVariablesResult {
  const variables: ExtractedVariable[] = [];
  const warnings: NormalizationWarning[] = [];

  cfg.variables.forEach((rawVariable: unknown, index) => {
    const pointer = `/variables/${String(index)}`;
    if (!isRecord(rawVariable)) {
      warnings.push(schemaDeviation(pointer));
      return;
    }
    variables.push(buildVariable(rawVariable, 'flow', pointer));
  });

  cfg.flowSequenceItemList.forEach((rawItem: unknown, itemIndex) => {
    if (!isRecord(rawItem)) return;
    const taskVariables = rawItem['variables'];
    if (!Array.isArray(taskVariables)) return;
    taskVariables.forEach((rawVariable: unknown, varIndex) => {
      const pointer = `/flowSequenceItemList/${String(itemIndex)}/variables/${String(varIndex)}`;
      if (!isRecord(rawVariable)) {
        warnings.push(schemaDeviation(pointer));
        return;
      }
      variables.push(buildVariable(rawVariable, 'task', pointer));
    });
  });

  return { variables, warnings };
}

/**
 * Fields that belong to a *different* extracted node, or to a variable
 * declaration rather than a use site. Walking into these would either
 * double-attribute a read to the wrong node, or misread a variable's default
 * `initialValue` as a use of that variable.
 *
 * Exported because `extract-prompts.ts` needs the identical exclusion set for
 * its own walk over the same raw node objects — reusing it here keeps the
 * two walks from silently drifting apart on what counts as "owned
 * elsewhere".
 */
export const OWNED_ELSEWHERE: ReadonlySet<string> = new Set([
  'actionList',
  'menuChoiceList',
  'variables',
]);

/**
 * Walks `raw`'s own fields, invoking `onValueRef` once for every value-ref
 * wrapper boundary reached (`{ config: { ... } }` — see `domain/value-ref.ts`)
 * and recursing through arrays and plain records everywhere else.
 *
 * This is the traversal `collectReadsFromRaw` (below) has always used to
 * build `variableReads`, factored out so `extract-prompts.ts` can reuse it
 * unchanged rather than re-implementing the same "stop at a value-ref
 * wrapper, skip owned-elsewhere fields" walk a second time. Both callers
 * apply `parseValueRef` to the wrapper `onValueRef` receives; they differ
 * only in which part of the parsed `ValueRef` they keep (a variable id here,
 * a prompt id there).
 */
export function walkValueRefs(
  raw: unknown,
  onValueRef: (wrapper: Record<string, unknown>) => void,
): void {
  if (Array.isArray(raw)) {
    for (const item of raw) walkValueRefs(item, onValueRef);
    return;
  }
  if (!isRecord(raw)) return;

  if (isRecord(raw['config'])) {
    onValueRef(raw);
    return;
  }

  for (const [key, value] of Object.entries(raw)) {
    if (OWNED_ELSEWHERE.has(key)) continue;
    walkValueRefs(value, onValueRef);
  }
}

/**
 * Every variable id read anywhere inside `raw`'s own fields — recursing
 * through arrays and plain objects, but stopping the moment a value wrapper
 * (`{ config: { ... } }`) is found, because `parseValueRef` plus
 * `collectVariableReads` already resolves everything nested inside an
 * expression AST from that point on.
 */
function collectReadsFromRaw(raw: unknown, into: Set<string>): void {
  walkValueRefs(raw, (wrapper) => collectVariableReads(parseValueRef(wrapper), into));
}

/** Variable ids a `DataAction`'s `outputs[]` bind a result to. Only entries
 * whose value resolves to a variable reference are writes; the rest are
 * left unbound (`emp`) or bind to something else entirely. */
function collectWritesFromRaw(raw: Record<string, unknown>, into: Set<string>): void {
  const outputs = raw['outputs'];
  if (!Array.isArray(outputs)) return;
  for (const output of outputs) {
    if (!isRecord(output)) continue;
    const parsed = parseValueRef(output['value']);
    if (parsed.kind === 'variableRef') into.add(parsed.variableId);
  }
}

export interface RawNodeIndex {
  readonly byTrackingId: ReadonlyMap<string, Record<string, unknown>>;
  readonly bySourceId: ReadonlyMap<string, Record<string, unknown>>;
}

/**
 * Mirrors `extractNodes`'s structural walk to recover each node's raw
 * configuration object, keyed by the same identifiers `extractNodes` prefers.
 * `ExtractedNode` itself carries no raw fields — only identity and
 * classification — so usage indexing needs this second walk to reach the
 * `inputs`, `outputs`, `expression`, and prompt fields a node actually holds.
 *
 * Exported so `extract-prompts.ts` and `extract-settings.ts` can recover the
 * same raw node objects by the same identifiers, instead of each running a
 * third copy of this structural walk.
 */
export function indexRawNodes(cfg: RawFlowConfig): RawNodeIndex {
  const byTrackingId = new Map<string, Record<string, unknown>>();
  const bySourceId = new Map<string, Record<string, unknown>>();

  const remember = (raw: Record<string, unknown>): void => {
    const trackingIdRaw = raw['trackingId'];
    if (typeof trackingIdRaw === 'number') byTrackingId.set(String(trackingIdRaw), raw);

    const sourceIdRaw = raw['id'];
    if (typeof sourceIdRaw === 'string' && sourceIdRaw.length > 0) bySourceId.set(sourceIdRaw, raw);
  };

  for (const rawItem of cfg.flowSequenceItemList) {
    if (!isRecord(rawItem)) continue;
    remember(rawItem);

    const actionList = rawItem['actionList'];
    if (Array.isArray(actionList)) {
      for (const rawAction of actionList) {
        if (isRecord(rawAction)) remember(rawAction);
      }
    }

    const menuChoiceList = rawItem['menuChoiceList'];
    if (Array.isArray(menuChoiceList)) {
      for (const rawChoice of menuChoiceList) {
        if (!isRecord(rawChoice)) continue;
        const action = rawChoice['action'];
        if (isRecord(action)) remember(action);
      }
    }
  }

  return { byTrackingId, bySourceId };
}

export function findRawNode(
  index: RawNodeIndex,
  node: ExtractedNode,
): Record<string, unknown> | null {
  if (node.trackingId !== null) {
    const byTracking = index.byTrackingId.get(node.trackingId);
    if (byTracking !== undefined) return byTracking;
  }
  if (node.sourceId !== null) {
    const bySource = index.bySourceId.get(node.sourceId);
    if (bySource !== undefined) return bySource;
  }
  return null;
}

/**
 * Builds the read/write index that makes a dead-branch finding possible: a
 * variable can gate a `DecisionAction` while nothing in the flow ever writes
 * it, and that is invisible in the Architect UI. `ref.val` is the variable's
 * GUID at every use site, so this index is exact rather than a best-effort
 * text match.
 */
export function indexVariableUsage(
  cfg: RawFlowConfig,
  nodes: readonly ExtractedNode[],
): VariableUsageIndex {
  const rawNodes = indexRawNodes(cfg);
  const readBy = new Map<string, NodeId[]>();
  const writtenBy = new Map<string, NodeId[]>();

  const addTo = (map: Map<string, NodeId[]>, variableId: string, nodeId: NodeId): void => {
    const existing = map.get(variableId);
    if (existing === undefined) map.set(variableId, [nodeId]);
    else existing.push(nodeId);
  };

  for (const node of nodes) {
    const raw = findRawNode(rawNodes, node);
    if (raw === null) continue;

    const reads = new Set<string>();
    collectReadsFromRaw(raw, reads);
    for (const variableId of reads) addTo(readBy, variableId, node.nodeId);

    const writes = new Set<string>();
    collectWritesFromRaw(raw, writes);
    for (const variableId of writes) addTo(writtenBy, variableId, node.nodeId);
  }

  const variableIds = new Set([...readBy.keys(), ...writtenBy.keys()]);
  const index = new Map<string, VariableUsage>();
  for (const variableId of variableIds) {
    index.set(variableId, {
      readBy: readBy.get(variableId) ?? [],
      writtenBy: writtenBy.get(variableId) ?? [],
    });
  }
  return index;
}
