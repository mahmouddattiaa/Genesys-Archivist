// @genesys-archivist/analysis
// docs/07-change-detection.md, section "Draft drift".
//
// When policy permits visibility of checked-in/working versions, a newer
// non-published version can exist alongside what documentation currently
// describes. This module reports that fact as its own, separately-typed
// result -- never mixed into `SemanticDiff`, and never presented as current
// caller-visible behavior. The one thing this module must never do is let a
// draft's content flow into a "this is what the flow does today" claim: the
// published snapshot is the only one a generated document may describe as
// current, and this module enforces that by construction -- it returns facts
// about drift, not a snapshot a caller could mistake for the published one.

/** Structural minimum this module needs from a version descriptor. Mirrors
 * `FlowVersionInfo` in normalize.ts closely enough that a real snapshot's
 * `flow.version` satisfies it directly. */
export interface DraftDriftVersion {
  readonly selected: string | number;
  readonly state: string;
  readonly published?: string | number | null;
  readonly latestCheckedIn?: string | number | null;
  readonly workingCopyPresent?: boolean;
  readonly modifiedAt?: string | null;
}

export interface DraftDriftInput {
  /** The version documentation is currently built from and may describe as
   * current caller-visible behavior. */
  readonly published: DraftDriftVersion;
  /** The most recent checked-in or working-copy version discovery observed,
   * if policy permits seeing it at all. `null` when policy forbids visibility
   * of non-published versions -- drift can never be assessed and this module
   * reports that explicitly rather than silently assuming "no drift". */
  readonly latestObserved: DraftDriftVersion | null;
  /** Whether the graph hash of `latestObserved` (when known) differs from
   * the graph hash documentation was built from. `undefined` when that
   * comparison has not been made (e.g. the draft was never normalized,
   * because policy permits *noticing* it exists without capturing its
   * content) -- distinct from `false`, which is an affirmative "we checked,
   * and there is no semantic difference". */
  readonly graphChanged?: boolean;
}

export type DraftDriftStatus =
  /** Policy forbids seeing anything beyond the published version. There is
   * nothing to compare, and this is reported as its own status rather than
   * folded into `no-drift` -- "we did not look" is not the same claim as
   * "we looked and found nothing". */
  | 'not-observable'
  /** The latest observed version *is* the published version: nothing newer
   * exists to drift from it. */
  | 'no-drift'
  /** A newer non-published version exists, but a graph-hash comparison found
   * no semantic difference from what is published -- docs/07's "a published
   * version bump with no semantic graph change is its own category" applies
   * equally to a *draft* that has not changed the graph either. */
  | 'draft-present-no-semantic-change'
  /** A newer non-published version exists and differs from the published
   * graph. This is the state a caller-visible document must never describe
   * as current behavior -- it may only say a newer version exists. */
  | 'draft-present-semantic-change'
  /** A newer non-published version exists but this module was not told
   * whether its graph differs (`graphChanged` was omitted). Distinct from
   * the two statuses above so a caller cannot mistake "unknown" for either
   * "no change" or "changed". */
  | 'draft-present-unknown-change';

export interface DraftDriftResult {
  readonly status: DraftDriftStatus;
  /** The version the caller-visible document remains tied to. Always the
   * `published` input, verbatim -- restated here so a caller reading only
   * this result (not the original input) cannot lose track of which version
   * is the one safe to present as current. */
  readonly publishedVersion: DraftDriftVersion;
  /** Present on every `draft-present-*` status: the version a prominent
   * "newer version exists" section should name. Absent for `not-observable`
   * and `no-drift`, where there is nothing to name. */
  readonly draftVersion?: DraftDriftVersion;
}

function sameVersion(a: DraftDriftVersion, b: DraftDriftVersion): boolean {
  return (
    a.selected === b.selected &&
    a.state === b.state &&
    (a.published ?? null) === (b.published ?? null) &&
    (a.latestCheckedIn ?? null) === (b.latestCheckedIn ?? null) &&
    (a.workingCopyPresent ?? false) === (b.workingCopyPresent ?? false) &&
    (a.modifiedAt ?? null) === (b.modifiedAt ?? null)
  );
}

/**
 * Assesses draft drift per docs/07: whether a newer checked-in or
 * working-copy version exists beyond what is published, and -- only when
 * policy permits seeing it and a graph comparison has actually been made --
 * whether that draft differs semantically. Pure: takes only the values a
 * caller already has, decides nothing about what to fetch or normalize.
 *
 * A later publication closing the drift (docs/07) is not a state this
 * function needs to detect specially: once the published version is
 * discovery's `latestObserved` again, `no-drift` falls out of the ordinary
 * comparison below, and the composition layer treats that as an ordinary
 * `decideFlowAction` regenerate/skip decision -- drift and semantic change
 * are already the same machinery at that point.
 */
export function assessDraftDrift(input: DraftDriftInput): DraftDriftResult {
  const { published, latestObserved, graphChanged } = input;

  if (latestObserved === null) {
    return { status: 'not-observable', publishedVersion: published };
  }

  if (sameVersion(published, latestObserved)) {
    return { status: 'no-drift', publishedVersion: published };
  }

  if (graphChanged === undefined) {
    return {
      status: 'draft-present-unknown-change',
      publishedVersion: published,
      draftVersion: latestObserved,
    };
  }

  return {
    status: graphChanged ? 'draft-present-semantic-change' : 'draft-present-no-semantic-change',
    publishedVersion: published,
    draftVersion: latestObserved,
  };
}
