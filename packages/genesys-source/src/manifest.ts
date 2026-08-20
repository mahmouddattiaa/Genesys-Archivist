// packages/genesys-source/src/manifest.ts
//
// Turns a flow configuration's `manifest` (S3: "every referenced resource's
// name, id, and node-level provenance, inline with the flow definition, at
// no additional request") into the `DependencyRef[]` convention
// `capture-run.ts` reads out of a flow-self resolution's
// `safeMetadata.references` (see that file's ADR-018 modeling-note comment).
//
// Iterated generically, by key, rather than against a fixed list of known
// type names. S3's corpus of one flow showed seven manifest keys
// (`dataAction`, `queue`, `ttsEngine`, `ttsVoice`, `language`, `userPrompt`,
// `systemPrompt`); S3 also warns "whether the manifest is complete for flows
// far richer than this one... is not settled." A manifest key this file has
// never seen must still become references -- never be silently dropped --
// which is only true if nothing here enumerates the keys it expects.
import { asResourceId, type DependencyRef } from '@genesys-archivist/domain';
import type { FlowConfiguration } from '@genesys-archivist/genesys-platform';

export interface ManifestWarning {
  readonly code: 'MANIFEST_ENTRY_MISSING_ID';
  readonly manifestType: string;
}

export interface ExtractedManifest {
  readonly references: readonly DependencyRef[];
  /** Entries this file could not turn into a reference, because Genesys
   * reported no stable id for them -- reported, never silently omitted. */
  readonly warnings: readonly ManifestWarning[];
}

/**
 * Flattens `configuration.manifest` into a deduplicated list of references.
 *
 * An entry with no `id` cannot become a `DependencyRef` (the domain type
 * requires one), so it is recorded as a warning instead of being dropped
 * without a trace. This has been observed for `ttsEngine`/`ttsVoice`
 * entries in real captures, where the "id" Genesys reports is closer to a
 * label than a resolvable resource id -- see `resource-readers.ts` for how
 * those two types are handled once they do carry one.
 */
export function extractManifestReferences(configuration: FlowConfiguration): ExtractedManifest {
  const manifest = configuration.manifest ?? {};
  const seen = new Set<string>();
  const references: DependencyRef[] = [];
  const warnings: ManifestWarning[] = [];

  for (const [manifestType, entries] of Object.entries(manifest)) {
    for (const entry of entries) {
      // `asResourceId` (packages/domain/src/identity.ts) rejects a blank or
      // whitespace-only string; treating that the same as a genuinely
      // absent id here (rather than letting the branded constructor throw)
      // keeps this a reported warning instead of an uncaught exception that
      // would abort resolving every other reference in the same manifest.
      if (entry.id === null || entry.id === undefined || entry.id.trim().length === 0) {
        warnings.push({ code: 'MANIFEST_ENTRY_MISSING_ID', manifestType });
        continue;
      }
      const key = `${manifestType}:${entry.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      references.push({ type: manifestType, id: asResourceId(entry.id) });
    }
  }

  return { references, warnings };
}
