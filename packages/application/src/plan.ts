// packages/application/src/plan.ts
//
// `createPlan` and `verifyPlan`: the immutable, expiring plan docs/03
// describes, plus the org-wide safety maximum with preview-and-confirm.
//
// Both functions are pure. Discovering which flows currently exist, and
// whether each one's selected version differs from what was last
// documented, requires talking to Genesys and to prior run manifests -- both
// genuinely I/O, and therefore not this module's job. `packages/composition/
// src/archivist-port.ts` does that work and hands the result in as
// `deps.candidates`; this module only decides selection, hashing, capping,
// and expiry over data it is given.
import { contentHash, type CanonicalOptions, type FlowId } from '@genesys-archivist/domain';
import type { Plan, PlanInput, PlanPreview, PlanResult } from './port.js';

/** `context` vs `migration`, per docs/adr/ADR-018-capture-modes.md. Declared
 * locally rather than imported from `@genesys-archivist/capture`'s identical
 * `CaptureMode` union: application may import `@genesys-archivist/domain`
 * only (ESLint enforces this), and capture is an adapter package several
 * layers above domain. The two string-literal unions are structurally
 * identical, so a caller in composition can pass a `capture`-flavoured
 * `CaptureMode` value here without a cast. */
export type CaptureMode = 'context' | 'migration';

/**
 * One flow this plan may select, already resolved against current discovery
 * data by the caller.
 */
export interface PlanCandidateFlow {
  readonly flowId: FlowId;
  readonly flowType: string;
  readonly targetVersion: string;
  /**
   * Whether this flow's selected version differs from what was last
   * documented. Supplied by the caller: change detection (docs/07) compares
   * against a prior run manifest, which is storage the caller has and this
   * module deliberately does not.
   */
  readonly changed: boolean;
}

export interface PolicyMaxByMode {
  readonly context: number;
  readonly migration: number;
}

/**
 * S6 (`docs/spikes/S6-scale-budgets.md`) measured the BFSI-MajorelX sandbox
 * at 511 flows total, 401 published, and a whole-organization **context**
 * capture at ~400 requests / ~95 seconds. Context mode reads only a flow's
 * own definition and the resource manifest that arrives with it (ADR-018) --
 * no resource bodies, no assets -- so its cost scales roughly 1:1 with flow
 * count, and that measurement is the basis for the default below: set high
 * enough that a routine whole-org context run (the case ADR-018 exists to
 * make "fast enough to run ... routinely") never trips the safety gate,
 * while an org an order of magnitude larger than this sandbox still does.
 *
 * Migration mode additionally walks the resource reference graph to closure
 * and downloads every referenced asset's bytes -- the "slower and much
 * larger" path ADR-018 describes -- and S6 measured context mode only, so
 * there is no equivalent whole-org migration measurement to calibrate a
 * larger number against. Guessing a large cap for the case with no
 * measurement is exactly the kind of "a cap that lets an unconfirmed 500-flow
 * migration run start is worse" mistake this task's brief warns against, so
 * the migration default stays conservative: comfortably past a single-flow
 * or small-batch migration (migration has no MCP-facing trigger yet -- see
 * archivist-port.ts) while still forcing an operator to explicitly confirm
 * anything larger.
 */
export const DEFAULT_POLICY_MAX: PolicyMaxByMode = {
  context: 750,
  migration: 50,
};

/** 15 minutes: long enough for a human to review a plan and confirm a run,
 * short enough that a stale plan cannot start against flows that have since
 * moved on (docs/07's "if the selected version changed mid-run, mark the
 * flow stale and replan" concern, applied before a run even starts). */
const DEFAULT_EXPIRY_MS = 15 * 60 * 1000;

/**
 * Canonicalization for the plan hash reuses
 * `packages/domain/src/canonical.ts`'s `contentHash` rather than hand-rolling
 * a second canonicalizer. CLAUDE.md is explicit that a second canonicalizer
 * is exactly the kind of drift this codebase forbids: the plan hash and the
 * capture bundle hash (`packages/capture/src/bundle-writer.ts`'s
 * `BUNDLE_CANONICAL`) need to behave identically -- deterministic key and
 * array ordering, NFC string normalization -- even though they hash
 * different content. Nothing hashed here is volatile or order-sensitive: a
 * plan's selection is a set, not a sequence, so the default (sort
 * everything) is exactly right.
 */
const PLAN_CANONICAL: CanonicalOptions = {
  canonicalizerVersion: '1',
  volatileKeys: new Set(),
  orderSensitivePaths: new Set(),
};

export interface CreatePlanDeps {
  readonly now: () => Date;
  readonly generateId: () => string;
  /** Policy-level, not a per-call client input: `PlanInput` (the MCP-facing
   * contract) has no `mode` field, because docs/03's tools describe a
   * documentation workflow, and migration mode has no MCP-facing trigger yet
   * per ADR-018 ("a separate migration server will consume it later"). This
   * is set by the composition layer that constructs `CreatePlanDeps`, not by
   * an MCP client. */
  readonly mode: CaptureMode;
  readonly candidates: readonly PlanCandidateFlow[];
  readonly versionSelection?: string;
  readonly policyMax?: PolicyMaxByMode;
  readonly expiresInMs?: number;
}

interface HashablePlanContent {
  readonly profileId: string;
  readonly policy: { readonly mode: CaptureMode; readonly versionSelection: string };
  readonly selectedFlowIds: readonly string[];
  readonly targetVersions: Readonly<Record<string, string>>;
}

interface MatchedCandidates {
  readonly matched: readonly PlanCandidateFlow[];
  readonly warnings: readonly string[];
}

function matchCandidates(input: PlanInput, deps: CreatePlanDeps): MatchedCandidates {
  const warnings: string[] = [];

  if (input.scope.kind === 'flows') {
    const byId = new Map(deps.candidates.map((c) => [c.flowId, c] as const));
    const found: PlanCandidateFlow[] = [];
    for (const selector of input.scope.flows) {
      const candidate = byId.get(selector.flowId);
      if (candidate === undefined) {
        // Never silently drop a flow the caller explicitly asked for: it is
        // reported as a warning on the resulting plan instead.
        warnings.push(
          `Flow "${selector.flowId}" was not found by discovery and could not be planned.`,
        );
        continue;
      }
      found.push(
        selector.version !== undefined
          ? { ...candidate, targetVersion: selector.version }
          : candidate,
      );
    }
    return { matched: found, warnings };
  }

  const flowTypes = input.scope.flowTypes;
  const matched =
    flowTypes === undefined
      ? deps.candidates
      : deps.candidates.filter((c) => flowTypes.includes(c.flowType));
  return { matched, warnings };
}

/**
 * Builds an immutable, expiring plan for a bounded set of flows, or a
 * `PlanPreview` when an organization-wide selection exceeds the policy
 * maximum and has not been explicitly confirmed.
 *
 * Pure: `deps.now` and `deps.generateId` are the only sources of
 * non-determinism, and both are injected. Nothing here touches
 * `Date.now()`, `Math.random()`, or a network -- see plan.test.ts's purity
 * test, which stubs all three as throwing and runs this function anyway.
 */
export function createPlan(input: PlanInput, deps: CreatePlanDeps): PlanResult {
  const versionSelection = deps.versionSelection ?? 'published';
  const policyMax = deps.policyMax ?? DEFAULT_POLICY_MAX;
  const cap = policyMax[deps.mode];

  const { matched, warnings } = matchCandidates(input, deps);
  const candidateCount = matched.length;

  // The safety maximum is deliberately scoped to organization-wide scope
  // only. An explicit flows-list selection already carries a hard bound at
  // the tool boundary (docs-plan.ts's zod schema caps it at 500) and is, by
  // construction, a caller's explicit named choice rather than a broad sweep
  // that grew without anyone noticing -- the risk this gate exists to catch.
  if (input.scope.kind === 'organization' && candidateCount > cap) {
    const confirmed = input.confirmedMax !== undefined && input.confirmedMax >= candidateCount;
    if (!confirmed) {
      const preview: PlanPreview = {
        kind: 'preview',
        reason:
          `${String(candidateCount)} candidate flow(s) in ${deps.mode} mode exceed the policy ` +
          `maximum of ${String(cap)}. Call again with confirmedMax >= ${String(candidateCount)} ` +
          'to proceed.',
        candidateCount,
        policyMax: cap,
      };
      return preview;
    }
  }

  const selectedFlowIds: readonly FlowId[] = matched.map((c) => c.flowId);
  const targetVersions: Record<string, string> = Object.fromEntries(
    matched.map((c) => [c.flowId, c.targetVersion]),
  );
  const changedCount = matched.filter((c) => c.changed).length;
  const unchangedCount = candidateCount - changedCount;
  const expectedOutputPaths = matched.map((c) => `flows/${c.flowId}/${c.targetVersion}`);
  // One work unit per flow mirrors S6's context-mode measurement (~1 request
  // per flow); this is stated as an estimate because, per the policyMax
  // comment above, there is no equivalent migration-mode measurement to
  // calibrate a different constant against.
  const estimatedWorkUnits = candidateCount;

  const now = deps.now();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + (deps.expiresInMs ?? DEFAULT_EXPIRY_MS)).toISOString();

  // The hash covers exactly "the plan's selection and target versions" (see
  // Plan.planHash's own doc comment) plus the policy that would change what
  // running this plan means -- never createdAt/expiresAt/planId, which are
  // bookkeeping about *this instance* of the plan, not part of what it would
  // do if run.
  const hashable: HashablePlanContent = {
    profileId: input.profileId,
    policy: { mode: deps.mode, versionSelection },
    selectedFlowIds,
    targetVersions,
  };
  const planHash = contentHash(hashable, PLAN_CANONICAL);

  const plan: Plan = {
    kind: 'plan',
    planId: deps.generateId(),
    planHash,
    profileId: input.profileId,
    selectedFlowIds,
    targetVersions,
    changedCount,
    unchangedCount,
    expectedOutputPaths,
    estimatedWorkUnits,
    warnings,
    createdAt,
    expiresAt,
  };
  return plan;
}

// ---------------------------------------------------------------------------
// Immutability and expiry
// ---------------------------------------------------------------------------

export type PlanVerificationFailureReason =
  'PLAN_NOT_FOUND' | 'PLAN_HASH_MISMATCH' | 'PLAN_EXPIRED';

export type PlanVerificationResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: PlanVerificationFailureReason;
      readonly message: string;
    };

/**
 * Verifies a plan is exactly the one it claims to be, and still current.
 *
 * The two failure reasons are deliberately distinct, per this task's brief:
 * a caller must be able to tell "someone changed this" (`PLAN_HASH_MISMATCH`)
 * from "you were too slow" (`PLAN_EXPIRED`) -- they call for different
 * operator actions (`tools/docs-run-start.ts` already branches on exactly
 * this distinction).
 */
export function verifyPlan(
  plan: Plan,
  planId: string,
  planHash: string,
  now: Date,
): PlanVerificationResult {
  if (plan.planId !== planId) {
    return {
      ok: false,
      reason: 'PLAN_NOT_FOUND',
      message: 'No stored plan matches the supplied planId.',
    };
  }
  if (plan.planHash !== planHash) {
    return {
      ok: false,
      reason: 'PLAN_HASH_MISMATCH',
      message:
        'The supplied plan hash does not match the stored plan. It may have been altered, or ' +
        'the wrong hash was supplied.',
    };
  }
  if (now.toISOString() > plan.expiresAt) {
    return {
      ok: false,
      reason: 'PLAN_EXPIRED',
      message: `The plan expired at ${plan.expiresAt} and must be recreated.`,
    };
  }
  return { ok: true };
}
