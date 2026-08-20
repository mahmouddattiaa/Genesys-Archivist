// packages/normalization/src/evidence.ts
import { createHash } from 'node:crypto';
import type { RawFlowConfig } from './config-schema.js';
import type { ExtractedNode } from './extract-nodes.js';
import type { ExtractedVariable } from './extract-variables.js';
import type { ExtractedDependency } from './extract-dependencies.js';

/**
 * The snapshot schema's classification enum (`schemas/flow-snapshot.schema.json`,
 * `$defs.evidence.properties.classification`). Chosen deliberately per record —
 * flow structure is `internal`, while a secure variable's value or a
 * data-action's endpoint reference is `confidential`.
 */
export type EvidenceClassification = 'public' | 'internal' | 'confidential' | 'restricted';

/**
 * One checkable fact: a field's value together with the exact place in the
 * configuration it came from. This is what lets a reviewer resolve a claim in
 * generated documentation back to its source, and what a later task uses to
 * reject any AI-written claim whose evidence id is unknown.
 */
export interface Evidence {
  readonly evidenceId: string;
  /** RFC 6901 JSON pointer into the flow configuration. Always resolvable. */
  readonly sourcePointer: string;
  readonly trackingId?: string;
  readonly field: string;
  readonly value?: unknown;
  readonly classification: EvidenceClassification;
  readonly redacted: boolean;
  readonly redactionCategory?: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Deterministic evidence identity, hashed from the two inputs that make a
 * record what it is: where it points and which field it cites. Never a
 * counter, a timestamp, or randomness — content hashes are computed over
 * whole snapshots, so an id that shifted between runs would make every
 * capture look like it changed even when nothing did.
 */
function evidenceId(sourcePointer: string, field: string): string {
  const digest = createHash('sha256')
    .update(`${sourcePointer}\u0000${field}`, 'utf8')
    .digest('hex');
  return `sha256:${digest}`;
}

interface EvidenceFields {
  readonly sourcePointer: string;
  readonly field: string;
  readonly classification: EvidenceClassification;
  readonly redacted: boolean;
  readonly trackingId?: string;
  readonly value?: unknown;
  readonly redactionCategory?: string;
}

function makeEvidence(fields: EvidenceFields): Evidence {
  return { evidenceId: evidenceId(fields.sourcePointer, fields.field), ...fields };
}

/** The flow's own top-level fields: not tied to any node, but still claims a
 * reviewer needs to be able to check. */
function flowLevelEvidence(cfg: RawFlowConfig): readonly Evidence[] {
  return [
    makeEvidence({
      sourcePointer: '/name',
      field: 'name',
      value: cfg.name,
      classification: 'internal',
      redacted: false,
    }),
    makeEvidence({
      sourcePointer: '/type',
      field: 'type',
      value: cfg.type,
      classification: 'internal',
      redacted: false,
    }),
  ];
}

/**
 * A `DataAction` node's whole reason for existing is calling out to an
 * external integration; that carries more sensitivity than plain flow
 * structure, so it is classified `confidential` rather than `internal`.
 */
function nodeClassification(node: ExtractedNode): EvidenceClassification {
  return node.sourceType === 'DataAction' ? 'confidential' : 'internal';
}

/** At least one evidence record per node — the plan's own invariant — citing
 * both its name and its `__type`, at the exact pointer `extractNodes` walked. */
function nodeEvidence(node: ExtractedNode): readonly Evidence[] {
  const classification = nodeClassification(node);
  const base = {
    sourcePointer: node.sourcePointer,
    classification,
    redacted: false,
    ...(node.trackingId !== null ? { trackingId: node.trackingId } : {}),
  };
  return [
    makeEvidence({ ...base, field: 'name', value: node.name }),
    makeEvidence({ ...base, field: 'sourceType', value: node.sourceType }),
  ];
}

/**
 * A variable's declaration is unremarkable metadata — name, scope, type — and
 * is `internal`. Its *value* is a different matter: when `secure` is set, a
 * second record notes that a value exists and was withheld, without ever
 * reading or carrying that value into evidence.
 */
function variableEvidence(variable: ExtractedVariable): readonly Evidence[] {
  const records: Evidence[] = [
    makeEvidence({
      sourcePointer: variable.sourcePointer,
      field: 'name',
      value: variable.name,
      classification: 'internal',
      redacted: false,
    }),
  ];

  if (variable.secure) {
    records.push(
      makeEvidence({
        sourcePointer: variable.sourcePointer,
        field: 'value',
        classification: 'confidential',
        redacted: true,
        redactionCategory: 'secure-variable',
      }),
    );
  }

  return records;
}

/**
 * Finds a dependency's true position in `cfg.manifest[type]` by matching its
 * id, rather than by counting positions in the already-filtered
 * `ExtractedDependency[]` array. `extractDependencies` skips manifest entries
 * that fail its own validity checks, so a plain running counter over the
 * filtered list would drift from the real array index and point evidence at
 * the wrong manifest entry (or one that does not exist).
 */
function findManifestIndex(cfg: RawFlowConfig, type: string, dependencyId: string): number | null {
  const manifest = (cfg as Record<string, unknown>)['manifest'];
  if (!isRecord(manifest)) return null;

  const entries = manifest[type];
  if (!Array.isArray(entries)) return null;

  for (let i = 0; i < entries.length; i += 1) {
    const entry: unknown = entries[i];
    if (isRecord(entry) && entry['id'] === dependencyId) return i;
  }
  return null;
}

/**
 * One record per dependency, pointing at `/manifest/<type>/<index>` in the
 * source configuration. A `dataAction` dependency is a live integration
 * endpoint reference and is classified `confidential`; everything else
 * (queues, prompts, and similar catalog resources) is `internal`.
 */
function dependencyEvidence(
  cfg: RawFlowConfig,
  dependencies: readonly ExtractedDependency[],
): readonly Evidence[] {
  return dependencies.map((dependency, position) => {
    const index = findManifestIndex(cfg, dependency.type, dependency.dependencyId) ?? position;
    const sourcePointer = `/manifest/${dependency.type}/${String(index)}`;
    const classification: EvidenceClassification =
      dependency.type === 'dataAction' ? 'confidential' : 'internal';

    return makeEvidence({
      sourcePointer,
      field: 'reference',
      classification,
      redacted: false,
      ...(dependency.displayName !== null ? { value: dependency.displayName } : {}),
    });
  });
}

/**
 * Builds the evidence pack a `FlowSnapshot` cites: every technical claim in
 * generated documentation must resolve to one of these records, per
 * docs/04 and docs/13. Deterministic across runs — evidence ids are hashed
 * from stable inputs, and every list here is built by mapping over an
 * already-deterministic input array, never by iterating a `Map` or `Set`.
 */
export function buildEvidence(
  cfg: RawFlowConfig,
  nodes: readonly ExtractedNode[],
  variables: readonly ExtractedVariable[],
  dependencies: readonly ExtractedDependency[],
): readonly Evidence[] {
  return [
    ...flowLevelEvidence(cfg),
    ...nodes.flatMap(nodeEvidence),
    ...variables.flatMap(variableEvidence),
    ...dependencyEvidence(cfg, dependencies),
  ];
}
