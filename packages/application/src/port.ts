// packages/application/src/port.ts
//
// `ArchivistPort` is the one seam between the MCP server (and any other
// front end) and everything that actually knows how to talk to Genesys, a
// profile store, or the capture/document pipelines. It lives here rather
// than in `apps/mcp-server` because `packages/composition` -- the only place
// a real implementation can be assembled from concrete adapters -- may not
// import from `apps/*` (ESLint enforces the dependency direction the other
// way around), so the interface has to live somewhere both a front end and
// the composition root can see. `application` imports domain only, which
// this file already satisfies. `apps/mcp-server/src/port.ts` is now a pure
// re-export of everything below, so none of its tool files change.
//
// Every operation here corresponds to exactly one thing a tool in
// docs/03-mcp-contract.md needs. Nothing is added "for completeness" --- an
// operation that no tool calls is a seam nobody asked for and a promise this
// wave cannot keep.
import type { FlowId, FlowVersionId, OrganizationId, ProfileId } from '@genesys-archivist/domain';

// ---------------------------------------------------------------------------
// genesys_profiles_list
// ---------------------------------------------------------------------------

/** Safe profile metadata only. Never a client ID, secret, or token -- see
 * AGENTS.md: `profile add` is CLI-only, forever, and this type must never
 * grow a field that would make that boundary leak through a read path. */
export interface ProfileSummary {
  readonly profileId: ProfileId;
  readonly displayName: string;
  readonly expectedOrganizationId: OrganizationId;
  readonly region: string;
  readonly outputRoot: string;
  readonly secretStoreStatus: 'available' | 'missing' | 'unknown';
  /** ISO 8601, or null if this profile has never been validated. */
  readonly lastValidatedAt: string | null;
}

// ---------------------------------------------------------------------------
// genesys_connection_check
// ---------------------------------------------------------------------------

export interface ConnectionCheckResult {
  readonly reachable: boolean;
  readonly organizationId: OrganizationId | null;
  readonly organizationName: string | null;
  readonly region: string | null;
  readonly sourceAdapterAvailable: boolean;
  /** Named capability categories the profile's role cannot see, e.g.
   * "architect-flows-division-4". Never a raw authorization response. */
  readonly missingPermissionCategories: readonly string[];
  readonly checkedAt: string;
}

// ---------------------------------------------------------------------------
// genesys_flows_list
// ---------------------------------------------------------------------------

export type FlowPublicationState = 'published' | 'draft' | 'unpublished' | 'unknown';

export interface FlowListQuery {
  readonly flowType?: string;
  readonly divisionId?: string;
  readonly nameQuery?: string;
  readonly publicationState?: FlowPublicationState;
  /** ISO 8601. Only flows modified at or after this instant. */
  readonly changedSince?: string;
  /** The port's own page size, independent of this server's output cap
   * (`bounds.ts` enforces the latter regardless of what a caller requests). */
  readonly pageSize?: number;
  /** Opaque; whatever this port previously handed back as `nextPageToken`. */
  readonly pageToken?: string;
}

export interface FlowDescriptor {
  readonly flowId: FlowId;
  readonly name: string;
  readonly type: string;
  readonly divisionId: string | null;
  readonly publicationState: FlowPublicationState;
  readonly lastModifiedAt: string | null;
  readonly latestVersion: string | null;
  readonly publishedVersion: string | null;
}

export interface FlowListPage {
  readonly items: readonly FlowDescriptor[];
  readonly nextPageToken: string | null;
  /** null when the total is not known without a further, possibly expensive,
   * count -- honest absence, not a fabricated number. */
  readonly totalKnown: number | null;
}

// ---------------------------------------------------------------------------
// genesys_flow_inspect
// ---------------------------------------------------------------------------

export interface FlowInspection {
  readonly flowId: FlowId;
  readonly versionId: FlowVersionId;
  readonly name: string;
  readonly type: string;
  readonly graphCounts: { readonly nodes: number; readonly edges: number };
  /** Short, human-readable descriptions of the main caller paths -- never raw
   * flow source. */
  readonly mainPaths: readonly string[];
  readonly dependencyCounts: Readonly<Record<string, number>>;
  readonly warnings: readonly string[];
  /** Opaque `genesys-docs://` URIs (see resources.ts) a client can read for
   * the full snapshot, evidence, or rendered documents. */
  readonly resourceUris: readonly string[];
}

// ---------------------------------------------------------------------------
// genesys_docs_plan / genesys_docs_run_start
// ---------------------------------------------------------------------------

export interface PlanFlowSelector {
  readonly flowId: FlowId;
  /** Omitted means "whatever versionSelection policy resolves to". */
  readonly version?: string;
}

export type PlanScope =
  | { readonly kind: 'flows'; readonly flows: readonly PlanFlowSelector[] }
  | { readonly kind: 'organization'; readonly flowTypes?: readonly string[] };

export interface PlanInput {
  readonly profileId: ProfileId;
  readonly scope: PlanScope;
  /**
   * Explicit confirmation that the caller has seen a preview and still wants
   * an organization-wide plan above the policy maximum. Must be at least the
   * candidate count `docs_plan` previously reported in a `PlanPreview`, or
   * the plan is refused again.
   */
  readonly confirmedMax?: number;
}

/** Returned instead of a `Plan` when an organization-wide scope exceeds the
 * policy maximum and the caller has not (yet) confirmed a larger limit. */
export interface PlanPreview {
  readonly kind: 'preview';
  readonly reason: string;
  readonly candidateCount: number;
  readonly policyMax: number;
}

export interface Plan {
  readonly kind: 'plan';
  readonly planId: string;
  /** Content-addressed over the plan's selection and target versions. See
   * `docs_run_start`: a plan started with any other hash is refused. */
  readonly planHash: string;
  readonly profileId: ProfileId;
  readonly selectedFlowIds: readonly FlowId[];
  readonly targetVersions: Readonly<Record<string, string>>;
  readonly changedCount: number;
  readonly unchangedCount: number;
  readonly expectedOutputPaths: readonly string[];
  readonly estimatedWorkUnits: number;
  readonly warnings: readonly string[];
  readonly createdAt: string;
  readonly expiresAt: string;
}

export type PlanResult = Plan | PlanPreview;

/** Thrown by `startRun` when a plan cannot be started as given. The tool
 * layer (`tools/docs-run-start.ts`) maps each code to the matching entry in
 * docs/03's error taxonomy -- never a generic failure. */
export class PlanRejectedError extends Error {
  readonly code: 'PLAN_NOT_FOUND' | 'PLAN_EXPIRED' | 'PLAN_HASH_MISMATCH';
  constructor(code: 'PLAN_NOT_FOUND' | 'PLAN_EXPIRED' | 'PLAN_HASH_MISMATCH', message: string) {
    super(message);
    this.name = 'PlanRejectedError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// genesys_docs_run_get / genesys_docs_run_cancel
// ---------------------------------------------------------------------------

export type RunState =
  | 'planned'
  | 'queued'
  | 'extracting'
  | 'normalizing'
  | 'analyzing'
  | 'rendering'
  | 'validating'
  | 'promoting'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'completed_with_warnings';

export interface RunError {
  readonly code: string;
  readonly message: string;
  readonly flowId?: string;
}

export interface RunStatus {
  readonly runId: string;
  readonly planId: string;
  readonly state: RunState;
  readonly perFlowCounts: Readonly<Record<string, number>>;
  /** Bounded and aggregated by code before this leaves the port -- see
   * docs/03 output-size policy. */
  readonly errors: readonly RunError[];
  readonly warnings: readonly string[];
  readonly startedAt: string | null;
  readonly updatedAt: string;
  readonly finishedAt: string | null;
  readonly resourceUris: readonly string[];
}

// ---------------------------------------------------------------------------
// genesys_flow_diff
// ---------------------------------------------------------------------------

export interface FlowDiff {
  readonly flowId: FlowId;
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly addedNodes: readonly string[];
  readonly removedNodes: readonly string[];
  readonly changedNodes: readonly string[];
  readonly addedVariables: readonly string[];
  readonly removedVariables: readonly string[];
  readonly dependencyChanges: readonly string[];
  readonly promptChanges: readonly string[];
  readonly materialJourneyChanges: readonly string[];
  /** Set when the full detail is too large to inline; null when the summary
   * above is already the whole diff. */
  readonly detailResourceUri: string | null;
}

// ---------------------------------------------------------------------------
// MCP resources (genesys-docs://...) -- see resources.ts for URI parsing.
// ---------------------------------------------------------------------------

export type ResourceLocator =
  | {
      readonly kind: 'flow-snapshot' | 'flow-evidence' | 'flow-business' | 'flow-technical';
      readonly organizationId: string;
      readonly flowId: string;
      readonly version: string;
    }
  | { readonly kind: 'run-report' | 'run-errors'; readonly runId: string };

export interface ResourceDocument {
  readonly mimeType: string;
  readonly text: string;
}

// ---------------------------------------------------------------------------
// The port
// ---------------------------------------------------------------------------

export interface ArchivistPort {
  listProfiles(): Promise<readonly ProfileSummary[]>;
  checkConnection(profileId: ProfileId): Promise<ConnectionCheckResult>;
  listFlows(profileId: ProfileId, query: FlowListQuery): Promise<FlowListPage>;
  inspectFlow(profileId: ProfileId, flowId: FlowId, version?: string): Promise<FlowInspection>;
  createPlan(input: PlanInput): Promise<PlanResult>;
  /** Throws `PlanRejectedError` for a missing, expired, or hash-mismatched
   * plan. Starting the same valid plan twice must return the same
   * `RunStatus` rather than creating a second run -- the port, not the tool
   * layer, owns that dedup because it is the only thing with a durable view
   * of runs across calls. */
  startRun(planId: string, planHash: string): Promise<RunStatus>;
  getRun(runId: string): Promise<RunStatus>;
  /** Cooperative and idempotent: cancelling twice must succeed twice and
   * never delete previous good output. */
  cancelRun(runId: string): Promise<RunStatus>;
  diffFlow(
    profileId: ProfileId,
    flowId: FlowId,
    fromVersion: string,
    toVersion: string,
  ): Promise<FlowDiff>;
  /** Returns null for a well-formed locator that names nothing this port
   * knows about, rather than throwing -- a missing resource is an ordinary
   * outcome, not a fault. */
  readResource(locator: ResourceLocator): Promise<ResourceDocument | null>;
}
