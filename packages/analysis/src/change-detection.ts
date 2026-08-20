// @genesys-archivist/analysis
// The nine-step detection algorithm from docs/07-change-detection.md,
// section "Detection algorithm", as one pure decision function.
//
// `decideFlowAction` performs no I/O: it never reads the previous manifest,
// never fetches or normalizes a flow, and never writes anything. Those steps
// (docs/07 steps 1, 2, and 5) belong to the composition layer, which
// discovers flows, matches them by organization+flow id, and -- only when
// this function says to -- loads and normalizes the source. That split is
// what makes every branch of the algorithm exhaustively unit-testable here
// without a fake filesystem or a fake Genesys client: every input is a
// plain value, and the same input always produces the same `FlowAction`.

/** Everything recorded about this flow the last time a run completed for it.
 * `null` means this flow id has never been seen before (docs/07: a
 * recreated flow with the same name but a new id is a new flow, never
 * merged with the old one -- so "never seen" is keyed on flow id, not name,
 * one level above this function in the composition layer that matches
 * discovery results to manifest entries). */
export interface PreviousFlowManifestEntry {
  readonly flowId: string;
  readonly flowType: string;
  readonly selectedVersion: string | number;
  readonly versionState?: string;
  readonly divisionId?: string | null;
  /** The display name last recorded for this flow id, if the manifest
   * carried one. Used only to detect a rename and record it as a note
   * (docs/07: "Rename: stable ID retains history"); absence just means this
   * function cannot compare and so reports no rename note, never a false
   * positive. */
  readonly name?: string;
  /** `hashes.normalizedGraph` from the last snapshot this flow was
   * successfully normalized against. Absent if the last run never reached
   * normalization for this flow (e.g. it was skipped every run so far). */
  readonly snapshotHash?: string;
  /** Generator-side versions recorded with the last successful run, compared
   * against `RebuildTrigger` to decide whether a rebuild is forced even with
   * no source change. */
  readonly generatorVersions?: GeneratorVersions;
}

export interface GeneratorVersions {
  readonly normalizer?: string;
  readonly analyzer?: string;
  readonly redactor?: string;
  readonly generator?: string;
  readonly template?: string;
}

/** What discovery observed for this flow id on the current run. `forbidden`
 * and `not-found` are kept distinct because docs/07 requires it: a 403 is
 * `inaccessible`, never `retired`; a flow id genuinely absent from discovery
 * is a `retire-candidate`, never deleted automatically. */
export type CurrentFlowObservation =
  | { readonly status: 'found'; readonly descriptor: CurrentFlowDescriptor }
  | { readonly status: 'not-found' }
  | { readonly status: 'forbidden' };

export interface CurrentFlowDescriptor {
  readonly name: string;
  readonly type: string;
  readonly divisionId: string | null;
  readonly publishedVersion: string | number | null;
  readonly checkedInVersion?: string | number | null;
  readonly workingCopyPresent?: boolean;
  readonly modifiedAt?: string | null;
}

/**
 * Whether this run must regenerate output for reasons unrelated to the
 * source at all: a normalization bug fix, a redaction policy change, a
 * template or analyzer version bump, or an AI prompt/model policy change
 * (docs/07, "Generator and policy changes"). Computed by the composition
 * layer by comparing its own current versions against
 * `PreviousFlowManifestEntry.generatorVersions` -- this module only acts on
 * the result, so it never has to know what a version string means.
 */
export interface RebuildTrigger {
  readonly forced: boolean;
  /** Structural reason codes, e.g. `'GENERATOR_VERSION_CHANGED'` -- never
   * free text, so a caller can match on them without parsing prose. */
  readonly reasons: readonly string[];
}

const NO_REBUILD: RebuildTrigger = { forced: false, reasons: [] };

export interface DecideFlowActionInput {
  readonly flowId: string;
  readonly previous: PreviousFlowManifestEntry | null;
  readonly current: CurrentFlowObservation;
  /**
   * The canonical graph hash for the *current* configuration, once it has
   * been normalized. `undefined` means normalization has not run yet this
   * pass (docs/07 step 5 has not happened) -- see this module's doc comment
   * for the two-call pattern this implies.
   */
  readonly currentGraphHash?: string;
  readonly rebuild?: RebuildTrigger;
}

export type FlowActionKind =
  | 'skip-unchanged'
  | 'metadata-only'
  | 'regenerate'
  | 'rebuild-forced'
  | 'retire-candidate'
  | 'inaccessible'
  | 'new-flow';

/** Structural reason codes for `FlowAction.reason`. Never tenant text. */
export type FlowActionReason =
  | 'NEVER_SEEN_BEFORE'
  | 'NOT_FOUND_IN_DISCOVERY'
  | 'ACCESS_FORBIDDEN'
  | 'GENERATOR_OR_POLICY_REBUILD_FORCED'
  | 'METADATA_UNCHANGED'
  | 'METADATA_CHANGED_HASH_PENDING'
  | 'GRAPH_HASH_UNCHANGED'
  | 'GRAPH_HASH_CHANGED';

/** Additional structural observations worth recording alongside the primary
 * `reason` -- e.g. that a matched flow's division changed (docs/07:
 * "Division move: preserve stable identity and record the move") -- without
 * promoting them to a separate action kind, since none of them change what
 * the caller should actually do. */
export type FlowActionNote = 'DIVISION_CHANGED' | 'DISPLAY_NAME_CHANGED' | 'TYPE_CHANGED';

export interface FlowAction {
  readonly action: FlowActionKind;
  readonly flowId: string;
  readonly reason: FlowActionReason;
  readonly notes: readonly FlowActionNote[];
}

function metadataNotes(
  previous: PreviousFlowManifestEntry,
  current: CurrentFlowDescriptor,
): readonly FlowActionNote[] {
  const notes: FlowActionNote[] = [];
  if ((previous.divisionId ?? null) !== current.divisionId) notes.push('DIVISION_CHANGED');
  if (previous.flowType !== current.type) notes.push('TYPE_CHANGED');
  if (previous.name !== undefined && previous.name !== current.name) {
    notes.push('DISPLAY_NAME_CHANGED');
  }
  return notes;
}

/**
 * Whether discovery's version/publication metadata for this flow agrees
 * with what the last manifest recorded (docs/07 step 3). Only the fields a
 * manifest entry and a live descriptor both carry participate; a flow's
 * display `name` is deliberately excluded; a rename must never look like a
 * metadata change that forces re-normalization on its own; renames are
 * still fully visible via `DISPLAY_NAME_CHANGED` in `notes`; and a rename
 * only additionally triggers `METADATA_CHANGED...` when a real version
 * field also moved.
 */
function metadataUnchanged(
  previous: PreviousFlowManifestEntry,
  current: CurrentFlowDescriptor,
): boolean {
  if (previous.selectedVersion !== current.publishedVersion) {
    // `selectedVersion` is compared against whichever version field the
    // policy actually selects; `publishedVersion` is the common case this
    // pure function can check without also being handed the policy. A
    // composition-layer caller using checked-in/working-copy selection is
    // expected to have already normalized `current.publishedVersion` to
    // whatever it actually selected before calling this function -- see the
    // module doc comment.
    return false;
  }
  if ((previous.divisionId ?? null) !== current.divisionId) return false;
  return true;
}

/**
 * Implements docs/07's nine-step detection algorithm as a pure function over
 * values. Steps 1 (discover), 2 (match by org+flow id), and 5 (load and
 * normalize) are I/O and belong to the composition layer, which is expected
 * to call this function up to twice per flow per run:
 *
 * 1. Once with `currentGraphHash` omitted, right after matching discovery
 *    against the previous manifest (steps 2-4). If the result is anything
 *    other than `'regenerate'`, the caller is done for this flow without
 *    ever normalizing it.
 * 2. Again with `currentGraphHash` populated, after normalizing (steps 5-8),
 *    if and only if the first call returned `'regenerate'`. This second call
 *    resolves to `'metadata-only'` or `'regenerate'` depending on whether the
 *    canonical graph hash actually changed.
 *
 * Both calls are pure and side-effect free; nothing here remembers state
 * between them. This is also why `'retire-candidate'` is never automatically
 * promoted to a permanent "retired" state inside this function (docs/07:
 * never delete automatically) -- tracking how many consecutive runs reported
 * `'retire-candidate'` before actually retiring a flow is the composition
 * layer's job, using its own persisted history, not this function's.
 */
export function decideFlowAction(input: DecideFlowActionInput): FlowAction {
  const { flowId, previous, current } = input;
  const rebuild = input.rebuild ?? NO_REBUILD;

  if (current.status === 'forbidden') {
    // Permission loss is `inaccessible`, never treated as deletion.
    return { action: 'inaccessible', flowId, reason: 'ACCESS_FORBIDDEN', notes: [] };
  }

  if (current.status === 'not-found') {
    // A flow id previously known but absent from this run's discovery is a
    // *candidate* for retirement, confirmed only by a later run (docs/07)
    // -- this function has no memory of prior runs to confirm anything with.
    // If `previous` is also null, there is nothing to retire: an id neither
    // previously known nor currently found is simply not this run's concern,
    // but the composition layer should not be calling this function for a
    // flow id it never discovered and never had a manifest entry for either;
    // treating it the same as a genuine retire-candidate is the safe default.
    return { action: 'retire-candidate', flowId, reason: 'NOT_FOUND_IN_DISCOVERY', notes: [] };
  }

  const descriptor = current.descriptor;

  if (previous === null) {
    // A flow id discovery has never matched to a manifest entry before.
    // Whether this is a genuinely brand-new flow, or the same display name
    // recreated under a new id (docs/07: never merged with the old one), is
    // indistinguishable from this function's point of view and does not
    // need to be distinguished here -- both are `new-flow`, and any linkage
    // to a prior flow of the same name is a human-review decision the
    // composition layer surfaces, never an automatic merge.
    return { action: 'new-flow', flowId, reason: 'NEVER_SEEN_BEFORE', notes: [] };
  }

  // Renames keep the stable id and history (docs/07): a name change is
  // recorded as a note (via `metadataNotes`), never treated as a reason this
  // is a different flow -- this function is keyed on `flowId` throughout.
  const notes = metadataNotes(previous, descriptor);

  if (rebuild.forced) {
    // A generator/policy/template rebuild is unconditional: docs/07 lists it
    // as happening "without a source change", so it must fire even when
    // metadata and the graph hash both agree with the last run.
    return {
      action: 'rebuild-forced',
      flowId,
      reason: 'GENERATOR_OR_POLICY_REBUILD_FORCED',
      notes,
    };
  }

  if (metadataUnchanged(previous, descriptor)) {
    return { action: 'skip-unchanged', flowId, reason: 'METADATA_UNCHANGED', notes };
  }

  if (input.currentGraphHash === undefined) {
    // Metadata changed or is ambiguous (step 4/5): normalization has not run
    // yet this pass, so the caller must load and normalize the source before
    // this function can say more. `'regenerate'` here means "proceed", not
    // "the graph is known to differ" -- see the module doc comment.
    return { action: 'regenerate', flowId, reason: 'METADATA_CHANGED_HASH_PENDING', notes };
  }

  if (previous.snapshotHash !== undefined && previous.snapshotHash === input.currentGraphHash) {
    // Step 7: the canonical graph hash agrees even though publication
    // metadata moved (e.g. a republish with no content change).
    return { action: 'metadata-only', flowId, reason: 'GRAPH_HASH_UNCHANGED', notes };
  }

  // Step 8: the graph hash changed (or there was no prior hash to compare
  // against). The composition layer runs the semantic diff and regenerates.
  return { action: 'regenerate', flowId, reason: 'GRAPH_HASH_CHANGED', notes };
}
