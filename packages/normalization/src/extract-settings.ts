// packages/normalization/src/extract-settings.ts
import { parseValueRef, type ValueRef } from '@genesys-archivist/domain';
import type { RawFlowConfig } from './config-schema.js';
import type { ExtractedNode } from './extract-nodes.js';
import { indexRawNodes, findRawNode } from './extract-variables.js';
import type { NormalizationWarning } from './warnings.js';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Standard 8-4-4-4-12 hex UUID shape. Mirrors `extract-edges.ts`'s
 * `GUID_PATTERN` exactly and for the same reason: every node, dependency, and
 * variable identifier Architect assigns in a flow configuration is one of
 * these, so a string field whose value matches it is a reference, not
 * settings content — it is either already an edge, already a
 * `dependencyRefs`/`promptRefs` entry, or already a `DANGLING_REFERENCE`
 * warning from `extract-edges.ts`'s generic walk. Re-including it here would
 * duplicate that representation rather than add anything a reader needs.
 */
const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Fields excluded from `settings` at every depth: self-identity (`id`,
 * `trackingId`, `referenceId` — extract-edges.ts measured `referenceId` as
 * self-identity 28/28 across the corpus and the same reasoning applies to a
 * nested object's own identity, not only a node's), pure UI/canvas
 * bookkeeping (`uiMetaData`, never semantic content), the five reference
 * fields `extract-edges.ts` already turns into edges (re-including them here
 * would re-encode an edge), and the three fields owned by `extractNodes` /
 * `extractVariables` (`actionList`, `menuChoiceList`, `variables` hold full
 * child node or variable objects, not node-local configuration).
 */
const ALWAYS_EXCLUDED: ReadonlySet<string> = new Set([
  'id',
  'trackingId',
  'referenceId',
  '__type',
  'uiMetaData',
  'startAction',
  'nextAction',
  'menuReference',
  'taskReference',
  'paths',
  'actionList',
  'menuChoiceList',
  'variables',
]);

/**
 * Bounds, each independently justified rather than picked to fit the
 * sanitized fixture corpus (whose NATO-codeword content is short by
 * construction and would not itself exercise these limits):
 *
 *  - `MAX_STRING_LENGTH` mirrors `packages/analysis/src/diff.ts`'s
 *    `UNTRUSTED_TEXT_MAX_LENGTH` (500) — chosen independently, not imported
 *    (normalization must not depend on analysis), but kept numerically
 *    consistent so a value that survives capture is not silently re-bounded
 *    to a different length downstream.
 *  - `MAX_ARRAY_ELEMENTS` bounds a "small-scalar-collection" field.
 *  - `MAX_EXPRESSION_OPERANDS` / `MAX_EXPRESSION_DEPTH` bound the recursive
 *    rendering of a value-ref expression tree — the deepest real expression
 *    measured in the corpus (a `DecisionAction.expression` with a nested
 *    `GetAt`) is two levels deep; eight is a generous ceiling against a
 *    pathological or adversarial tenant-authored expression, not a number
 *    the corpus itself approaches.
 *  - `MAX_NODE_SETTINGS_BYTES` bounds the total serialized size of one
 *    node's `settings`, per the task's "bound the total size per node"
 *    requirement — a defensive limit for real (non-sanitized) prompt text,
 *    which can run far longer than this fixture corpus's placeholder words.
 */
const MAX_STRING_LENGTH = 500;
const MAX_ARRAY_ELEMENTS = 20;
const MAX_EXPRESSION_OPERANDS = 20;
const MAX_EXPRESSION_DEPTH = 8;
const MAX_NODE_SETTINGS_BYTES = 4000;

interface Truncatable<T> {
  readonly value: T;
  readonly truncated: boolean;
}

function truncateString(s: string, max: number): Truncatable<string> {
  if (s.length <= max) return { value: s, truncated: false };
  return { value: s.slice(0, max), truncated: true };
}

/**
 * Renders a parsed value-ref as bounded, structural data — the "expressions
 * and conditions" case the task calls the highest-value content this field
 * carries. A `DecisionAction.expression`, a `CommunicateAction.communication`,
 * a `Menu.prompts.defaultAudio`: all three are this shape, and this is what
 * lets a reader (or a future diff) see the boolean test, the spoken text
 * literal, or the branch condition a node actually evaluates.
 *
 * A `variableRef` never carries its `variableId` into the description —
 * that id already lives in `variableReads` / `variableWrites` /
 * `promptRefs`, and duplicating it here would be exactly the redundant
 * dump the task warns against. Only the reference's *shape* (that a
 * variable is read at this position, and its declared data type) survives,
 * which is what a diff needs to notice "the operand changed from a literal
 * to a variable read" without re-encoding *which* variable. A prompt
 * reference (`dataType === 'pmt'`) is dropped entirely — `promptRefs`
 * already represents it completely, so there is nothing left to add.
 * `unset` (Architect's `emp` — explicitly cleared) carries no information
 * and is dropped the same way; `opaque` never carries its own inner value
 * forward, only the discriminator name, because an unrecognised construct's
 * content is not something this normalizer can represent as fact.
 */
function describeValueRef(value: ValueRef, depth: number): Truncatable<unknown> {
  switch (value.kind) {
    case 'literal': {
      const text = truncateString(value.text, MAX_STRING_LENGTH);
      return {
        value: { kind: 'literal', dataType: value.dataType, text: text.value },
        truncated: text.truncated,
      };
    }
    case 'unset':
      return { value: undefined, truncated: false };
    case 'null':
      return { value: { kind: 'null' }, truncated: false };
    case 'variableRef':
      if (value.dataType === 'pmt') return { value: undefined, truncated: false };
      return { value: { kind: 'variableRef', dataType: value.dataType }, truncated: false };
    case 'expression': {
      if (depth >= MAX_EXPRESSION_DEPTH) {
        return {
          value: { kind: 'expression', operator: value.operator, operands: [] },
          truncated: true,
        };
      }
      const overflow = value.operands.length > MAX_EXPRESSION_OPERANDS;
      const operands: unknown[] = [];
      let truncated = overflow;
      for (const operand of value.operands.slice(0, MAX_EXPRESSION_OPERANDS)) {
        const described = describeValueRef(operand, depth + 1);
        if (described.truncated) truncated = true;
        if (described.value !== undefined) operands.push(described.value);
      }
      return { value: { kind: 'expression', operator: value.operator, operands }, truncated };
    }
    case 'opaque':
      return { value: { kind: 'opaque', discriminator: value.discriminator }, truncated: false };
  }
}

const isScalar = (v: unknown): v is string | number | boolean =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

/**
 * Classifies and (when it qualifies) renders one field of a raw node or
 * container object. This is the structural rule the task asks for, applied
 * uniformly regardless of field name or node `__type`:
 *
 *  - A GUID-shaped string is a reference, never settings content (see
 *    `GUID_PATTERN`).
 *  - Any other scalar (string, number, boolean) is included, bounded.
 *  - An array is included only when every element is itself a scalar (a
 *    "small-scalar-collection" — measured across the corpus, every
 *    non-empty array field on a node is instead an array of *structured*
 *    reprompt/binding objects such as `noInputs` or `DataAction.outputs`;
 *    those are excluded here, both because that content is already
 *    represented via `variableReads` / `variableWrites` and because
 *    rendering every reprompt's full expression tree would be exactly the
 *    unbounded dump the task warns against). An all-GUID array is a
 *    reference collection and is excluded the same way a single GUID
 *    string is.
 *  - A value-ref wrapper (`{ config: { ... } }` — domain/value-ref.ts's own
 *    boundary, the same one `extract-variables.ts` and `extract-edges.ts`
 *    already use) is rendered via `describeValueRef`.
 *  - Anything else (a plain nested object without a `config` key) is not
 *    itself settings content, but per `extractContainer` below it may still
 *    be worth one bounded level of recursion.
 */
function extractScalarOrValueRef(raw: unknown): Truncatable<unknown> | null {
  if (raw === null || raw === undefined) return null;

  if (typeof raw === 'string') {
    if (GUID_PATTERN.test(raw)) return null;
    const t = truncateString(raw, MAX_STRING_LENGTH);
    return { value: t.value, truncated: t.truncated };
  }
  if (typeof raw === 'number' || typeof raw === 'boolean') {
    return { value: raw, truncated: false };
  }

  if (Array.isArray(raw)) {
    if (raw.length === 0) return null;
    const allScalar = raw.every((v) => isScalar(v));
    if (!allScalar) return null;
    const allGuidStrings = raw.every((v) => typeof v === 'string' && GUID_PATTERN.test(v));
    if (allGuidStrings) return null;

    const overflow = raw.length > MAX_ARRAY_ELEMENTS;
    let truncated = overflow;
    const values: unknown[] = [];
    for (const v of raw.slice(0, MAX_ARRAY_ELEMENTS)) {
      if (typeof v === 'string') {
        if (GUID_PATTERN.test(v)) continue;
        const t = truncateString(v, MAX_STRING_LENGTH);
        if (t.truncated) truncated = true;
        values.push(t.value);
      } else {
        values.push(v);
      }
    }
    if (values.length === 0) return null;
    return { value: values, truncated };
  }

  if (isRecord(raw)) {
    if (!isRecord(raw['config'])) return null;
    const described = describeValueRef(parseValueRef(raw), 0);
    if (described.value === undefined) return null;
    return described;
  }

  return null;
}

/**
 * One bounded level of recursion into a plain nested container (a field that
 * is a record but not itself a value-ref wrapper) — needed because
 * Architect nests a node's playable content one level down more often than
 * not: `PlayAudioAction.prompts.defaultAudio`, `Menu.prompts.defaultAudio`,
 * and `DataAction.category.name` are all one level below the node's own top-
 * level fields, never sitting directly on the node itself. Without this,
 * the single highest-value field this task exists to capture — "which
 * prompt does this node play" — would be excluded by the very rule meant to
 * capture it.
 *
 * Recursion stops at this one level: a further-nested plain object (depth 2
 * from the node) is excluded rather than descended into, keeping this
 * bounded and matching what the corpus actually needs (every container
 * measured — `prompts`, `category` — resolves to scalars or value-ref
 * wrappers at exactly one level down). `name` is excluded from a node's own
 * top-level fields (it duplicates `FlowSnapshotNode.name`) but *not* at this
 * nested level, where a field literally named `name` (`category.name`) is
 * unrelated content, not a duplicate.
 */
function extractContainer(
  raw: Record<string, unknown>,
): Truncatable<Record<string, unknown>> | null {
  const keys = Object.keys(raw)
    .filter((k) => k === 'name' || !ALWAYS_EXCLUDED.has(k))
    .sort();
  const settings: Record<string, unknown> = {};
  let truncated = false;

  for (const key of keys) {
    const result = extractScalarOrValueRef(raw[key]);
    if (result === null) continue;
    settings[key] = result.value;
    if (result.truncated) truncated = true;
  }

  if (Object.keys(settings).length === 0) return null;
  return { value: settings, truncated };
}

export interface ExtractSettingsResult {
  readonly settingsByNode: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
  readonly warnings: readonly NormalizationWarning[];
}

/**
 * Builds every field a top-level node field can resolve to: a scalar/value-
 * ref via `extractScalarOrValueRef`, or one bounded level of container
 * recursion via `extractContainer` when the field is a plain nested object.
 */
function extractTopLevelField(raw: unknown): Truncatable<unknown> | null {
  if (isRecord(raw) && !isRecord(raw['config'])) return extractContainer(raw);
  return extractScalarOrValueRef(raw);
}

function buildTruncationMessage(fields: readonly string[], dropped: readonly string[]): string {
  const parts: string[] = [];
  if (fields.length > 0) parts.push(`truncated fields: ${fields.join(', ')}`);
  if (dropped.length > 0) {
    parts.push(
      `fields dropped to stay within the per-node settings size bound: ${dropped.join(', ')}`,
    );
  }
  return parts.join('; ');
}

/**
 * Extracts one node's `settings` from its raw configuration object, and
 * bounds the whole thing to `MAX_NODE_SETTINGS_BYTES` — dropping fields,
 * lexicographically last first, until the serialized size is within budget.
 * "Last" is an arbitrary but fully deterministic tie-break (documented here,
 * not claimed as a priority ordering): the goal is that identical
 * configuration always drops the identical fields, never that the most or
 * least "important" field survives.
 */
function extractNodeSettings(
  raw: Record<string, unknown>,
  node: ExtractedNode,
  warnings: NormalizationWarning[],
): Readonly<Record<string, unknown>> {
  const keys = Object.keys(raw)
    .filter((k) => !ALWAYS_EXCLUDED.has(k) && k !== 'name')
    .sort();

  // A `Map` rather than a plain object while fields may still need to be
  // dropped below: removing an entry by a dynamically-computed key is a
  // lint error on a plain object (`no-dynamic-delete`, for good reason —
  // it is easy to mis-key), but is exactly what `Map.delete` is for.
  const settings = new Map<string, unknown>();
  const truncatedFields: string[] = [];

  for (const key of keys) {
    const result = extractTopLevelField(raw[key]);
    if (result === null) continue;
    settings.set(key, result.value);
    if (result.truncated) truncatedFields.push(key);
  }

  const dropped: string[] = [];
  const includedKeysDescending = [...settings.keys()].sort().reverse();
  let i = 0;
  while (
    JSON.stringify(Object.fromEntries(settings)).length > MAX_NODE_SETTINGS_BYTES &&
    i < includedKeysDescending.length
  ) {
    const key = includedKeysDescending[i];
    i += 1;
    if (key === undefined) break;
    settings.delete(key);
    dropped.push(key);
  }

  if (truncatedFields.length > 0 || dropped.length > 0) {
    warnings.push({
      code: 'TRUNCATED',
      severity: 'info',
      message: buildTruncationMessage([...truncatedFields].sort(), dropped),
      path: node.sourcePointer,
      nodeIds: [node.nodeId],
    });
  }

  return Object.fromEntries(settings);
}

/**
 * Populates `settings` for every node: node-specific configuration a reader
 * or a diff needs, deliberately excluding a raw passthrough of the node
 * object (unbounded tenant content, duplicated variable/dependency/prompt
 * references, noisy diffs — see this module's own comments for the
 * structural rule applied field by field).
 */
export function extractSettings(
  cfg: RawFlowConfig,
  nodes: readonly ExtractedNode[],
): ExtractSettingsResult {
  const rawIndex = indexRawNodes(cfg);
  const warnings: NormalizationWarning[] = [];
  const settingsByNode = new Map<string, Readonly<Record<string, unknown>>>();

  for (const node of nodes) {
    const raw = findRawNode(rawIndex, node);
    if (raw === null) continue;
    const settings = extractNodeSettings(raw, node, warnings);
    if (Object.keys(settings).length > 0) settingsByNode.set(node.nodeId, settings);
  }

  return { settingsByNode, warnings };
}
