// @genesys-archivist/analysis
// Maps a `SemanticDiff`'s classified `changes` (the eleven docs/07
// categories, from diff.ts) onto the review-classification table in
// docs/07-change-detection.md's "Review classification" section: cosmetic,
// documentation-only, behavioral, dependency, security-sensitive, and
// coverage-regression, each with its documented default review level.
//
// Pure, like the rest of this package: `classifyChanges` is a total function
// of its `SemanticDiff` argument.

import type { SemanticChange, SemanticDiff } from './diff.js';

export type ChangeReviewCategory =
  | 'cosmetic'
  | 'documentation-only'
  | 'behavioral'
  | 'dependency'
  | 'security-sensitive'
  | 'coverage-regression';

export type ReviewLevel =
  | 'light-review'
  | 'automated-plus-spot-check'
  | 'human-review-required'
  | 'engineer-review-required'
  | 'security-lead-review'
  | 'blocked';

/** The docs/07 table, verbatim. `coverage-regression` is the one row whose
 * review level is not merely "heavier" than the others -- it blocks
 * approval outright, which `ChangeClassification.blocksApproval` models as
 * a hard flag rather than something a caller could mistake for "just a
 * high severity number" and accidentally let through. */
const REVIEW_LEVEL_BY_CATEGORY: Readonly<Record<ChangeReviewCategory, ReviewLevel>> = {
  cosmetic: 'light-review',
  'documentation-only': 'automated-plus-spot-check',
  behavioral: 'human-review-required',
  dependency: 'engineer-review-required',
  'security-sensitive': 'security-lead-review',
  'coverage-regression': 'blocked',
};

/** Ordering from lightest to heaviest, used only to pick the single
 * strictest review level a whole diff requires. Not a numeric "severity
 * score" a caller could silently downgrade -- `blocksApproval` is the
 * authoritative gate for `coverage-regression`, independent of this order. */
const CATEGORY_WEIGHT: Readonly<Record<ChangeReviewCategory, number>> = {
  cosmetic: 0,
  'documentation-only': 1,
  behavioral: 2,
  dependency: 3,
  'security-sensitive': 4,
  'coverage-regression': 5,
};

export interface ClassifiedChange {
  readonly change: SemanticChange;
  readonly category: ChangeReviewCategory;
  readonly reviewLevel: ReviewLevel;
}

export interface ChangeClassification {
  readonly classified: readonly ClassifiedChange[];
  /** The strictest review level any single change in this diff requires.
   * When `classified` is empty this is `'automated-plus-spot-check'`: see
   * `classifyChanges`'s doc comment for why an empty diff still classifies
   * as `documentation-only` rather than as nothing at all. */
  readonly highestReviewLevel: ReviewLevel;
  /** `true` iff at least one change classified as `coverage-regression`.
   * Callers must treat this as a hard gate -- never derive "should this
   * block?" from `highestReviewLevel === 'blocked'` by string comparison
   * alone, since that invites exactly the "just a severity number a caller
   * might ignore" failure mode AGENTS.md warns about. */
  readonly blocksApproval: boolean;
  readonly counts: Readonly<Record<ChangeReviewCategory, number>>;
}

/** Dependency types whose name suggests an authentication or credential
 * boundary, as opposed to an ordinary queue/data-action/schedule reference.
 * A pattern match, not a fixed enum, because the manifest's `type` key
 * space (extract-dependencies.ts) is whatever category name the Platform
 * API manifest happens to use and is not itself a closed set this package
 * controls. */
const AUTH_RELATED_DEPENDENCY_TYPE = /auth|credential|oauth|secret|token/i;

function classifyFlowMetadataField(field: string): ChangeReviewCategory {
  // `secure` is the flow's own secure-flow marker (docs/07's example for
  // security-sensitive); every other flow-metadata field the diff reports
  // (name, description, type, divisionId, divisionName) is display/identity
  // text, matching the cosmetic row's "description or display label only".
  return field === 'secure' ? 'security-sensitive' : 'cosmetic';
}

function classifyOne(change: SemanticChange): ChangeReviewCategory {
  switch (change.category) {
    case 'flow-metadata-changed':
      return classifyFlowMetadataField(change.field);

    case 'entry-point-changed':
      // Where a caller's journey begins is never merely cosmetic.
      return 'behavioral';

    case 'menu-choice-changed':
      return change.aspect === 'label' ? 'cosmetic' : 'behavioral';

    case 'action-changed':
      return change.aspect === 'relabeled' ? 'cosmetic' : 'behavioral';

    case 'condition-expression-changed':
      // Docs/07's behavioral example row names "decision" explicitly.
      return 'behavioral';

    case 'variable-changed':
      return change.secure ? 'security-sensitive' : 'behavioral';

    case 'prompt-reference-changed':
      // Wording/localization content, not flow logic -- the review table's
      // "Template or wording update" example.
      return 'documentation-only';

    case 'dependency-changed':
      return change.dependencyType !== null &&
        AUTH_RELATED_DEPENDENCY_TYPE.test(change.dependencyType)
        ? 'security-sensitive'
        : 'dependency';

    case 'outcome-path-changed':
      // Docs/07's behavioral example row names "error path" explicitly.
      return 'behavioral';

    case 'published-version-only-changed':
      // The defining property of this category (diff.ts only ever emits it
      // when the canonical graph hash agrees) is that nothing behavioral
      // changed -- exactly the "no semantic graph change" case docs/07
      // calls out, which the review table treats the same as a wording
      // update: safe to auto-process with a spot check.
      return 'documentation-only';

    case 'coverage-changed':
      return change.direction === 'regressed' ? 'coverage-regression' : 'documentation-only';

    case 'unclassified-change':
      // AGENTS.md: never silently drop a change. A shape this package could
      // not place in one of the eleven documented categories is treated as
      // requiring a human's judgment, not waved through as cosmetic and not
      // escalated to a block it may not deserve.
      return 'behavioral';
  }
}

/**
 * Classifies every change in a `SemanticDiff` against the docs/07
 * review-classification table.
 *
 * An empty `diff.changes` classifies as `documentation-only` rather than as
 * an empty/absent result: `classifyChanges` is only meaningful to call once
 * a caller has already decided there is something to review (change-
 * detection.ts's `regenerate` or `rebuild-forced`), and a `rebuild-forced`
 * run can legitimately find zero source-level semantic changes -- the
 * snapshot did not change, only the generator, template, or policy version
 * did. That is precisely docs/07's "Template or wording update" row, not
 * "nothing happened".
 */
export function classifyChanges(diff: SemanticDiff): ChangeClassification {
  const counts: Record<ChangeReviewCategory, number> = {
    cosmetic: 0,
    'documentation-only': 0,
    behavioral: 0,
    dependency: 0,
    'security-sensitive': 0,
    'coverage-regression': 0,
  };

  const classified: ClassifiedChange[] = diff.changes.map((change) => {
    const category = classifyOne(change);
    counts[category] += 1;
    return { change, category, reviewLevel: REVIEW_LEVEL_BY_CATEGORY[category] };
  });

  if (classified.length === 0) {
    counts['documentation-only'] = 1;
    return {
      classified: [],
      highestReviewLevel: REVIEW_LEVEL_BY_CATEGORY['documentation-only'],
      blocksApproval: false,
      counts,
    };
  }

  let strictest: ChangeReviewCategory = 'cosmetic';
  for (const c of classified) {
    if (CATEGORY_WEIGHT[c.category] > CATEGORY_WEIGHT[strictest]) strictest = c.category;
  }

  return {
    classified,
    highestReviewLevel: REVIEW_LEVEL_BY_CATEGORY[strictest],
    blocksApproval: counts['coverage-regression'] > 0,
    counts,
  };
}
