// packages/normalization/src/extract-prompts.ts
import { parseValueRef, type ValueRef } from '@genesys-archivist/domain';
import type { RawFlowConfig } from './config-schema.js';
import type { ExtractedNode } from './extract-nodes.js';
import type { ExtractedDependency } from './extract-dependencies.js';
import { indexRawNodes, findRawNode, walkValueRefs } from './extract-variables.js';
import type { NormalizationWarning } from './warnings.js';

/**
 * Manifest resource types that name a played prompt. Measured across every
 * fixture in fixtures/flow-config/ (ten flow types, docs/spikes/S3-references.md's
 * manifest resource catalogue): `userPrompt` and `systemPrompt` are the only
 * two manifest categories whose entries are prompt resources, as opposed to
 * queues, integrations, languages, or any of the other catalogued types. A
 * prompt reference is therefore identified by *dependency type*, never by a
 * node's own `__type` — a node that plays a prompt can be a PlayAudioAction,
 * a Menu, or a survey question, and all of them funnel through the same two
 * manifest categories.
 */
const PROMPT_DEPENDENCY_TYPES: ReadonlySet<string> = new Set(['userPrompt', 'systemPrompt']);

export interface ExtractPromptReferencesResult {
  /**
   * Node id -> the dependency ids (see the id-space note below) that node
   * references. Every entry here is guaranteed to correspond to an entry in
   * `dependencies` — an inline reference this snapshot cannot resolve to a
   * dependency never lands here; it produces a warning instead (see
   * `warnings`).
   */
  readonly promptRefsByNode: ReadonlyMap<string, readonly string[]>;
  readonly warnings: readonly NormalizationWarning[];
}

/** Mirrors `collectVariableReads` (`domain/value-ref.ts`) but selects the
 * opposite half of the same `ref` shape. Architect represents both a
 * variable reference and a prompt-library reference with the identical
 * `{ ref: { type, val } }` wrapper (see docs/spikes/S3-references.md and the
 * `ToAudio` shape measured on inqueuecall-37-nodes.json and
 * voicesurvey-16-nodes.json) — only `type` tells them apart (`pmt` for a
 * prompt, a variable's own data type otherwise). `parseValueRef` folds both
 * into the single `variableRef` kind because from the domain layer's
 * perspective they are the same wrapper shape; this function is what
 * recovers the distinction, purely by reading `dataType` off the already-
 * parsed value — it never re-parses or duplicates `parseValueRef`'s own
 * logic. */
function collectPromptRefs(value: ValueRef, into: Set<string>): void {
  if (value.kind === 'variableRef' && value.dataType === 'pmt') into.add(value.variableId);
  if (value.kind === 'expression') {
    for (const operand of value.operands) collectPromptRefs(operand, into);
  }
}

function danglingPromptWarning(nodeId: string, path: string): NormalizationWarning {
  return {
    code: 'DANGLING_REFERENCE',
    severity: 'warning',
    // The unresolved prompt id itself is never recorded, matching
    // extract-edges.ts's danglingWarning convention — only the structural
    // field description and the (already-resolved) referencing node id.
    message:
      "Inline prompt reference (a value-ref of type 'pmt') does not resolve to any userPrompt or systemPrompt dependency in this snapshot.",
    path,
    nodeIds: [nodeId],
  };
}

function addRef(byNode: Map<string, Set<string>>, nodeId: string, promptId: string): void {
  const existing = byNode.get(nodeId);
  if (existing === undefined) byNode.set(nodeId, new Set([promptId]));
  else existing.add(promptId);
}

/**
 * Builds each node's `promptRefs`: the prompt-library resources that node
 * actually references, in the same id space `dependencyRefs` already uses —
 * `ExtractedDependency.dependencyId`, the manifest entry's own `id` (S3,
 * Finding 1). That choice is deliberate, not incidental: it is exactly the
 * id `dependencies[].dependencyId` and `graph.nodes[].dependencyRefs`
 * already carry for the same resource, so a reader (or `packages/analysis`'s
 * diff) can join a `promptRefs` entry straight onto either without a second
 * lookup or a fresh identity space to reconcile.
 *
 * Two complementary sources feed this, mirroring how prompt references
 * actually appear in a real configuration:
 *
 *  1. The manifest. `extractDependencies` has already inverted every
 *     `userPrompt` / `systemPrompt` manifest entry's `context[]` into
 *     `referencedByNodeIds` — this is the authoritative, already-measured
 *     per-node association (S3, Finding 1), so it is reused directly rather
 *     than re-walking the manifest a second time here.
 *  2. Each node's own inline configuration. Architect represents a prompt
 *     choice inline as a value-ref of type `pmt` (see `collectPromptRefs`).
 *     This is scanned too, not because the manifest is expected to be wrong,
 *     but because per AGENTS.md a reference this snapshot cannot resolve
 *     must never be silently dropped: an inline reference the manifest omits
 *     from `context[]`, or one with no manifest entry at all, would
 *     otherwise vanish from `promptRefs` with nothing on record. Measured
 *     against every inline `pmt` reference in the full ten-flow corpus, all
 *     resolve to a manifest entry and agree with source 1 exactly — this
 *     path exists for correctness on configurations that have not been
 *     measured, not because the corpus currently exercises it.
 */
export function extractPromptReferences(
  cfg: RawFlowConfig,
  nodes: readonly ExtractedNode[],
  dependencies: readonly ExtractedDependency[],
): ExtractPromptReferencesResult {
  const promptDependencyIds = new Set(
    dependencies.filter((d) => PROMPT_DEPENDENCY_TYPES.has(d.type)).map((d) => d.dependencyId),
  );

  const byNode = new Map<string, Set<string>>();
  for (const dependency of dependencies) {
    if (!PROMPT_DEPENDENCY_TYPES.has(dependency.type)) continue;
    for (const nodeId of dependency.referencedByNodeIds)
      addRef(byNode, nodeId, dependency.dependencyId);
  }

  const rawIndex = indexRawNodes(cfg);
  const warnings: NormalizationWarning[] = [];

  for (const node of nodes) {
    const raw = findRawNode(rawIndex, node);
    if (raw === null) continue;

    const inline = new Set<string>();
    walkValueRefs(raw, (wrapper) => {
      collectPromptRefs(parseValueRef(wrapper), inline);
    });

    for (const promptId of inline) {
      if (promptDependencyIds.has(promptId)) addRef(byNode, node.nodeId, promptId);
      else warnings.push(danglingPromptWarning(node.nodeId, node.sourcePointer));
    }
  }

  const promptRefsByNode = new Map<string, readonly string[]>();
  for (const [nodeId, ids] of byNode) promptRefsByNode.set(nodeId, [...ids].sort());

  return { promptRefsByNode, warnings };
}
