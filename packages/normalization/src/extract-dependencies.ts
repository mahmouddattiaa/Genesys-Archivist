// packages/normalization/src/extract-dependencies.ts
import type { DependencyResolutionStatus } from '@genesys-archivist/domain';
import type { RawFlowConfig } from './config-schema.js';
import type { ExtractedNode } from './extract-nodes.js';
import type { NormalizationWarning } from './warnings.js';

/**
 * A resource dependency measured directly from the flow configuration's
 * `manifest`. Per S3, the manifest supplies stable IDs and per-node
 * provenance (`context[]`) with no name-to-ID join required — see
 * docs/spikes/S3-references.md, Finding 1.
 */
export interface ExtractedDependency {
  readonly dependencyId: string;
  readonly type: string;
  readonly displayName: string | null;
  readonly resolutionStatus: DependencyResolutionStatus;
  /** Node identifiers, already resolved into the identity space extractNodes uses. */
  readonly referencedByNodeIds: readonly string[];
  /**
   * Context entries that are not nodes.
   *
   * Manifest contexts are heterogeneous: a queue's contexts are node GUIDs,
   * but a ttsVoice's context is a language setting such as `en-US-tts` and a
   * systemPrompt's is `defaultSettings`. Those are real provenance and are
   * kept rather than discarded, because AGENTS.md forbids silently dropping
   * source information — they simply are not node references.
   */
  readonly nonNodeContexts: readonly string[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export interface ExtractDependenciesResult {
  readonly dependencies: readonly ExtractedDependency[];
  readonly warnings: readonly NormalizationWarning[];
}

/**
 * Extracts one dependency per manifest entry. Each manifest key is a
 * resource type; each entry in that type's array yields one dependency.
 *
 * `context[].id` carries a node's **source GUID**, while `extractNodes`
 * prefers the numeric `trackingId` for node identity. Passing the extracted
 * nodes lets those two identity spaces be reconciled here, so
 * `referencedByNodeIds` really does contain node identifiers rather than raw
 * source GUIDs that resolve to nothing. Without this, every dependency edge
 * in the snapshot dangles — which per-task tests cannot detect, because each
 * extractor is individually correct.
 *
 * An empty category (e.g. `userPrompt: []`) yields no dependencies, and a
 * configuration with no `manifest` key at all yields an empty list rather
 * than throwing: not every flow type carries one.
 *
 * A manifest entry that is not an object, or one with no usable `id`, cannot
 * become a dependency. Both are skipped, but per AGENTS.md the skip is never
 * silent: each raises a `SCHEMA_DEVIATION` warning naming the manifest
 * position (`/manifest/<type>/<index>`) rather than only decrementing a
 * count nobody sees.
 */
export function extractDependencies(
  cfg: RawFlowConfig,
  nodes: readonly ExtractedNode[] = [],
): ExtractDependenciesResult {
  const manifest = (cfg as Record<string, unknown>)['manifest'];
  if (!isRecord(manifest)) return { dependencies: [], warnings: [] };

  const bySourceId = new Map<string, string>();
  for (const node of nodes) {
    if (node.sourceId !== null) bySourceId.set(node.sourceId, node.nodeId);
  }

  const dependencies: ExtractedDependency[] = [];
  const warnings: NormalizationWarning[] = [];

  for (const [type, entries] of Object.entries(manifest)) {
    if (!Array.isArray(entries)) continue;

    entries.forEach((entry: unknown, index) => {
      const pointer = `/manifest/${type}/${String(index)}`;

      if (!isRecord(entry)) {
        warnings.push({
          code: 'SCHEMA_DEVIATION',
          severity: 'warning',
          message: 'Expected an object at this manifest position but found something else.',
          path: pointer,
          nodeIds: [],
        });
        return;
      }

      const dependencyId = str(entry['id']);
      if (dependencyId.length === 0) {
        warnings.push({
          code: 'SCHEMA_DEVIATION',
          severity: 'warning',
          message: 'Manifest entry has no usable id and cannot become a dependency.',
          path: pointer,
          nodeIds: [],
        });
        return;
      }

      const rawName = entry['name'];
      const displayName = typeof rawName === 'string' && rawName.length > 0 ? rawName : null;

      const context = Array.isArray(entry['context']) ? entry['context'] : [];
      const contextIds = context
        .filter(isRecord)
        .map((c) => str(c['id']))
        .filter((id) => id.length > 0);

      const referencedByNodeIds: string[] = [];
      const nonNodeContexts: string[] = [];
      for (const id of contextIds) {
        const nodeId = bySourceId.get(id);
        if (nodeId === undefined) nonNodeContexts.push(id);
        else referencedByNodeIds.push(nodeId);
      }

      dependencies.push({
        dependencyId,
        type,
        displayName,
        resolutionStatus: 'resolved',
        referencedByNodeIds,
        nonNodeContexts,
      });
    });
  }

  return { dependencies, warnings };
}
