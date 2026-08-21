// packages/composition/src/change-detection-io.ts
//
// The I/O `packages/analysis/src/change-detection.ts`'s `decideFlowAction`
// was deliberately left without: reading what a previous run recorded,
// discovering the current organization through a `GenesysSourceProvider`,
// calling the pure decision function per flow, and then actually running a
// capture over only the flows that need it -- while still producing a bundle
// that describes the *whole* organization. `packages/capture` cannot import
// `packages/analysis` (Stage 1 must stay analysis-free), so this lives here,
// in composition, which already imports both.
//
// -----------------------------------------------------------------------
// Which source of truth this module reads as "what the previous run knew"
// -----------------------------------------------------------------------
// docs/07 describes a per-flow manifest (organization/flow/version identity,
// source and graph hashes, generator versions...) that does not exist on
// disk yet -- nothing in this codebase writes it. What *does* exist after a
// promoted capture run are two things:
//
//   1. The previous bundle itself: `bundle-manifest.json` plus, per flow,
//      `flows/<flowId>/flow.json` (a `FlowMeta`: id, type, format) and
//      `flows/<flowId>/versions/<versionId>/definition.{yaml,json}`.
//   2. The Stage 1 run manifest under `.archivist/state/runs/<runId>.json`
//      (`packages/capture/src/capture-run.ts`'s own `toManifestJson`),
//      whose `selection` entries carry a `flowId` and `selectedVersion` --
//      but `flowType` is hardcoded `'unknown'` there (see that file's
//      `selection:` mapping) and there is no `divisionId` or `name` field
//      anywhere on it either.
//
// The bundle is the more honest source: it is the durable, *promoted*
// state (the run manifest can describe an in-progress or failed attempt),
// and its `flow.json` carries a real flow `type`, which the run manifest
// does not. So this module reads the previous bundle, via the same
// directory shape `capture-run.ts`'s own `readPromotedFlows` already reads
// for its own resume path (duplicated here rather than imported: that
// function is private to `capture-run.ts` and not exported through
// `@genesys-archivist/capture`'s public index).
//
// That source has a real gap this module cannot close without touching
// `packages/capture`: `FlowMeta` carries no `divisionId` and no display
// `name`. `PreviousFlowManifestEntry.name` is safe to leave undefined --
// its own doc comment guarantees "absence just means this function cannot
// compare... never a false positive". `divisionId` is NOT: `decideFlowAction`'s
// `metadataUnchanged` compares `(previous.divisionId ?? null) !== current.divisionId`,
// so leaving it undefined makes that comparison permanently disagree for any
// flow in a non-null division, forcing `regenerate` (a full re-fetch) for
// every such flow on every run, forever. This is the *safe* direction (a
// real change is never missed; only the incremental win is lost for
// division-scoped orgs), never a silent skip -- but it is a real,
// disclosed cost. See this task's final report for the recommended follow-up
// (adding `divisionId` to `BundleWriter`'s `FlowMeta`).

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  asFlowId,
  asResourceId,
  type DependencyRef,
  type DependencyResolution,
  type FlowDescriptor,
  type GenesysSourceProvider,
  type OrganizationId,
} from '@genesys-archivist/domain';
import {
  decideFlowAction,
  type CurrentFlowObservation,
  type FlowActionReason,
  type PreviousFlowManifestEntry,
} from '@genesys-archivist/analysis';
import {
  buildResourceGraph,
  definitionFileName,
  BundleWriter,
  type CaptureIssue,
  type CaptureRunVersions,
  type CaptureScope,
  type FlowMeta,
  type ResourceGraph,
  type ResourceGraphEdge,
  type ResourceGraphNode,
  type ResourceGraphResult,
  type ResourceResolver,
  type VersionSelection,
} from '@genesys-archivist/capture';
import { acquireLock, createStaging, type StagingArea, promote } from '@genesys-archivist/storage';
import {
  createRunStore,
  type RunManifestFlowResult,
  type RunManifestSelectionEntry,
  type RunStore,
} from './run-store.js';

// ---------------------------------------------------------------------------
// Reading the previous bundle
// ---------------------------------------------------------------------------

interface PreviousBundleFlow {
  readonly flowId: string;
  readonly flowType: string;
  readonly format: 'yaml' | 'json';
  readonly versionId: string;
  readonly definition: string;
  /**
   * Discovery metadata `FlowMeta` records so a later run can compare without
   * re-fetching.
   *
   * Optional, and the optionality is load-bearing: a bundle written before
   * these fields existed has none of them, and a missing value must read as
   * "nothing recorded, cannot compare" -- which `decideFlowAction` treats as
   * changed. Erring toward re-capture costs time; erring the other way
   * publishes stale documentation as current.
   */
  readonly name?: string;
  readonly divisionId?: string | null;
  readonly publishedVersion?: string | null;
}

/** Mirrors `capture-run.ts`'s private `readPromotedFlows`: same directory
 * shape, same "take the lexicographically last version directory" rule for
 * picking one version per flow -- duplicated because that function is not
 * part of `@genesys-archivist/capture`'s public surface. Unreadable entries
 * are excluded rather than failing the whole read: a torn or partially
 * written prior flow falls through to being treated as unseen, which -- per
 * `decideFlowAction` -- makes it `new-flow` and forces a fresh capture. That
 * is the conservative direction (never a silent skip of something that could
 * not actually be verified). */
async function readPreviousBundleFlows(
  bundleDir: string,
): Promise<Map<string, PreviousBundleFlow>> {
  const result = new Map<string, PreviousBundleFlow>();
  const flowsDir = join(bundleDir, 'flows');
  let flowIds: string[];
  try {
    flowIds = (await readdir(flowsDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return result;
  }
  for (const flowId of flowIds) {
    try {
      const meta = JSON.parse(
        await readFile(join(flowsDir, flowId, 'flow.json'), 'utf8'),
      ) as FlowMeta;
      const versionsDir = join(flowsDir, flowId, 'versions');
      const versionIds = (await readdir(versionsDir, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
      const versionId = versionIds[versionIds.length - 1];
      if (versionId === undefined) continue;
      const definition = await readFile(
        join(versionsDir, versionId, definitionFileName(meta.format)),
        'utf8',
      );
      result.set(flowId, {
        flowId,
        flowType: meta.type,
        format: meta.format,
        versionId,
        definition,
        ...(meta.name !== undefined ? { name: meta.name } : {}),
        ...(meta.divisionId !== undefined ? { divisionId: meta.divisionId } : {}),
        ...(meta.publishedVersion !== undefined ? { publishedVersion: meta.publishedVersion } : {}),
      });
    } catch {
      continue;
    }
  }
  return result;
}

async function readPreviousResourceGraph(bundleDir: string): Promise<ResourceGraph> {
  try {
    const raw = JSON.parse(await readFile(join(bundleDir, 'resource-graph.json'), 'utf8')) as {
      readonly nodes?: unknown;
      readonly edges?: unknown;
      readonly orphans?: unknown;
    };
    return {
      nodes: Array.isArray(raw.nodes) ? (raw.nodes as ResourceGraphNode[]) : [],
      edges: Array.isArray(raw.edges) ? (raw.edges as ResourceGraphEdge[]) : [],
      orphans: Array.isArray(raw.orphans) ? (raw.orphans as string[]) : [],
    };
  } catch {
    // Missing or unreadable: treated as empty. resource-graph.json is a
    // supplementary reference manifest (docs/adr/ADR-018), not a flow
    // definition -- losing it is recoverable by a later full recapture and
    // never causes a *flow* to be silently dropped from the bundle.
    return { nodes: [], edges: [], orphans: [] };
  }
}

async function readPreviousPolicyMode(bundleDir: string): Promise<'context' | 'migration' | null> {
  try {
    const raw = JSON.parse(await readFile(join(bundleDir, 'bundle-manifest.json'), 'utf8')) as {
      readonly policy?: { readonly mode?: unknown };
    };
    return raw.policy?.mode === 'migration' ? 'migration' : 'context';
  } catch {
    return null;
  }
}

async function bundleFlowsExist(bundleDir: string): Promise<boolean> {
  try {
    await readdir(join(bundleDir, 'flows'));
    return true;
  } catch {
    return false;
  }
}

function toPreviousFlowManifestEntry(flow: PreviousBundleFlow): PreviousFlowManifestEntry {
  return {
    flowId: flow.flowId,
    flowType: flow.flowType,
    selectedVersion: flow.publishedVersion ?? flow.versionId,
    // Spread only when present. Under exactOptionalPropertyTypes an explicit
    // `undefined` is not the same as an absent key, and `decideFlowAction`
    // distinguishes them: absent means "nothing recorded, cannot compare",
    // which it treats as changed rather than as a match against undefined.
    ...(flow.name !== undefined ? { name: flow.name } : {}),
    ...(flow.divisionId !== undefined ? { divisionId: flow.divisionId } : {}),
  };
}

// ---------------------------------------------------------------------------
// Planning: decideFlowAction, driven by discovery + the previous bundle
// ---------------------------------------------------------------------------

export interface PlannedCapture {
  readonly flowId: string;
  readonly flowType: string;
  readonly reason: FlowActionReason;
  readonly isNew: boolean;
}

export interface SkippedFlow {
  readonly flowId: string;
  readonly reason: FlowActionReason;
}

export interface RetireCandidateFlow {
  readonly flowId: string;
}

export interface InaccessibleFlow {
  readonly flowId: string;
}

/** A flow the previous bundle held that this run's `scope` never asked
 * discovery about at all -- a targeted `{kind:'flows', flowIds:[...]}` run
 * over a handful of ids says nothing about whether every other flow still
 * exists, so these are carried forward without being evaluated by
 * `decideFlowAction`, never treated as retired or skipped-as-unchanged. */
export interface OutOfScopeFlow {
  readonly flowId: string;
}

export interface IncrementalCapturePlan {
  readonly toCapture: readonly PlannedCapture[];
  readonly toSkip: readonly SkippedFlow[];
  readonly retireCandidates: readonly RetireCandidateFlow[];
  readonly inaccessible: readonly InaccessibleFlow[];
  readonly notInScope: readonly OutOfScopeFlow[];
}

export interface PlanIncrementalCaptureOptions {
  /** The previous bundle's root directory (the one containing
   * `bundle-manifest.json` and `flows/`), or `null` when there is no
   * previous bundle at all -- every current flow is then `new-flow`. */
  readonly previousBundleDir: string | null;
  readonly provider: GenesysSourceProvider;
  readonly scope?: CaptureScope;
}

interface PlanAndPrevious {
  readonly plan: IncrementalCapturePlan;
  readonly previous: Map<string, PreviousBundleFlow>;
}

/** Shared by `planIncrementalCapture` (the public, read-only entry point)
 * and `runIncrementalCapture` (which needs the same previous-flow bytes it
 * just planned against, and must not read them from disk twice). */
async function computePlanAndPrevious(
  previousBundleDir: string | null,
  provider: GenesysSourceProvider,
  scope: CaptureScope,
): Promise<PlanAndPrevious> {
  const previous =
    previousBundleDir === null
      ? new Map<string, PreviousBundleFlow>()
      : await readPreviousBundleFlows(previousBundleDir);

  const flowTypes = scope.kind === 'all' ? scope.flowTypes : undefined;
  const discoveryQuery = flowTypes === undefined ? {} : { flowTypes };
  const wantedIds = scope.kind === 'flows' ? new Set(scope.flowIds.map(String)) : null;

  const discovered = new Map<string, FlowDescriptor>();
  for await (const flow of provider.listFlows(discoveryQuery)) {
    if (wantedIds !== null && !wantedIds.has(flow.flowId)) continue;
    discovered.set(flow.flowId, flow);
  }

  const toCapture: PlannedCapture[] = [];
  const toSkip: SkippedFlow[] = [];

  for (const [flowId, descriptor] of discovered) {
    const prevFlow = previous.get(flowId);
    const previousEntry: PreviousFlowManifestEntry | null =
      prevFlow === undefined ? null : toPreviousFlowManifestEntry(prevFlow);
    const current: CurrentFlowObservation = {
      status: 'found',
      descriptor: {
        name: descriptor.name,
        type: descriptor.type,
        divisionId: descriptor.divisionId,
        publishedVersion: descriptor.publishedVersion,
      },
    };
    const action = decideFlowAction({ flowId, previous: previousEntry, current });

    switch (action.action) {
      case 'new-flow':
        toCapture.push({ flowId, flowType: descriptor.type, reason: action.reason, isNew: true });
        break;
      case 'regenerate':
      case 'rebuild-forced':
        toCapture.push({ flowId, flowType: descriptor.type, reason: action.reason, isNew: false });
        break;
      case 'skip-unchanged':
      case 'metadata-only':
        toSkip.push({ flowId, reason: action.reason });
        break;
      case 'retire-candidate':
      case 'inaccessible':
        // Unreachable for a 'found' observation -- decideFlowAction can only
        // return either of these when `current.status` is 'not-found' or
        // 'forbidden' (see its own switch), and this branch always passes
        // 'found'. Handled anyway so the switch stays exhaustive
        // (@typescript-eslint/switch-exhaustiveness-check) rather than
        // silently falling through if that assumption ever stops holding.
        toSkip.push({ flowId, reason: action.reason });
        break;
    }
  }

  const retireCandidates: RetireCandidateFlow[] = [];
  const inaccessible: InaccessibleFlow[] = [];
  const notInScope: OutOfScopeFlow[] = [];

  for (const [flowId, prevFlow] of previous) {
    if (discovered.has(flowId)) continue;

    if (wantedIds !== null && !wantedIds.has(flowId)) {
      notInScope.push({ flowId });
      continue;
    }

    // A flow known before but absent from this run's discovery is either
    // deleted or newly inaccessible; GenesysSourceProvider.listFlows cannot
    // say which on its own. Reusing the {type:'flow', id} resolution
    // convention capture-run.ts documents (its ADR-018 header comment) for
    // reading a flow's own inline reference manifest distinguishes them: a
    // 'forbidden' resolution is permission loss, anything else (including
    // 'not_found') means discovery genuinely no longer sees it.
    const [resolution] = await provider.resolveDependencies([
      { type: 'flow', id: asResourceId(flowId) },
    ]);
    const current: CurrentFlowObservation =
      resolution?.status === 'forbidden' ? { status: 'forbidden' } : { status: 'not-found' };

    const action = decideFlowAction({
      flowId,
      previous: toPreviousFlowManifestEntry(prevFlow),
      current,
    });
    if (action.action === 'inaccessible') {
      inaccessible.push({ flowId });
    } else if (action.action === 'retire-candidate') {
      retireCandidates.push({ flowId });
    }
    // No other FlowActionKind is reachable from a 'not-found'/'forbidden'
    // observation with a non-null `previous` -- nothing else to handle.
  }

  return { plan: { toCapture, toSkip, retireCandidates, inaccessible, notInScope }, previous };
}

/**
 * Runs docs/07's detection algorithm (steps 1-4) for a whole organization:
 * discovers current flows, matches them against the previous bundle, and
 * classifies every one -- capture, skip, retire-candidate, inaccessible, or
 * out of this run's scope. Performs no fetch and no write; see
 * `runIncrementalCapture` for the half that actually captures anything.
 */
export async function planIncrementalCapture(
  options: PlanIncrementalCaptureOptions,
): Promise<IncrementalCapturePlan> {
  const { plan } = await computePlanAndPrevious(
    options.previousBundleDir,
    options.provider,
    options.scope ?? { kind: 'all' },
  );
  return plan;
}

// ---------------------------------------------------------------------------
// The reference-manifest convention capture-run.ts documents (ADR-018),
// duplicated because it is private to that file and not part of
// @genesys-archivist/capture's public surface.
// ---------------------------------------------------------------------------

function isDependencyRefLike(value: unknown): value is DependencyRef {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate['type'] === 'string' && typeof candidate['id'] === 'string';
}

function extractReferences(resolution: DependencyResolution | undefined): DependencyRef[] {
  if (resolution === undefined || resolution.status !== 'resolved') return [];
  const raw = resolution.safeMetadata['references'];
  if (!Array.isArray(raw)) return [];
  return raw.filter(isDependencyRefLike);
}

function makeResolver(provider: GenesysSourceProvider): ResourceResolver {
  return {
    resolve: (refs) => provider.resolveDependencies(refs),
    outwardRefs: (resolution) => extractReferences(resolution),
  };
}

function compareResourceEdges(a: ResourceGraphEdge, b: ResourceGraphEdge): number {
  const fields: (keyof ResourceGraphEdge)[] = ['from', 'to', 'viaNodeId', 'viaField'];
  for (const field of fields) {
    if (a[field] < b[field]) return -1;
    if (a[field] > b[field]) return 1;
  }
  return 0;
}

/** Unions a carried-forward resource graph with a freshly (shallow-)walked
 * one. Nodes and edges are merged by key, fresh entries winning on conflict
 * since they reflect this run's own live read. Orphans are recomputed from
 * the merged edge set rather than unioning the two orphan lists independently
 * -- a node that was an orphan in the old graph alone may now be referenced
 * by a fresh edge, and the reverse. This never *removes* a stale reference a
 * changed flow no longer makes; that is a disclosed staleness cost, not a
 * loss (see this module's header comment). */
function mergeResourceGraphs(previous: ResourceGraph, fresh: ResourceGraph): ResourceGraph {
  const nodesByKey = new Map<string, ResourceGraphNode>();
  for (const node of previous.nodes) nodesByKey.set(node.key, node);
  for (const node of fresh.nodes) nodesByKey.set(node.key, node);

  const edgeKey = (e: ResourceGraphEdge): string =>
    `${e.from} ${e.to} ${e.viaNodeId} ${e.viaField}`;
  const edgesByKey = new Map<string, ResourceGraphEdge>();
  for (const edge of previous.edges) edgesByKey.set(edgeKey(edge), edge);
  for (const edge of fresh.edges) edgesByKey.set(edgeKey(edge), edge);

  const referenced = new Set([...edgesByKey.values()].map((e) => e.to));
  const orphans = [...nodesByKey.keys()].filter((key) => !referenced.has(key)).sort();

  return {
    nodes: [...nodesByKey.values()].sort((a, b) => (a.key < b.key ? -1 : 1)),
    edges: [...edgesByKey.values()].sort(compareResourceEdges),
    orphans,
  };
}

// ---------------------------------------------------------------------------
// Running an incremental capture
// ---------------------------------------------------------------------------

function bundleTargetDir(root: string): string {
  return join(root, 'bundle');
}

/** Deterministic captureId, matching capture-bundle.schema.json's
 * `YYYY-MM-DDTHH-mm-ssZ_xxxxxx` shape -- the same formula
 * capture-run.ts's own (private) `formatCaptureId` uses, duplicated for the
 * same reason as `readPreviousBundleFlows` above. */
function formatCaptureId(now: Date, runId: string): string {
  const stamp = now.toISOString().slice(0, 19).replace(/:/g, '-');
  const suffix = createHash('sha256').update(runId).digest('hex').slice(0, 6);
  return `${stamp}Z_${suffix}`;
}

const issue = (
  code: string,
  category: string,
  message: string,
  retryable: boolean,
  flowId?: string | null,
): CaptureIssue => ({
  code,
  category,
  message,
  retryable,
  ...(flowId !== undefined ? { flowId } : {}),
});

const TENANT_MISMATCH = (): CaptureIssue =>
  issue(
    'TENANT_MISMATCH',
    'security',
    'The connected organization does not match the organization this run was planned for.',
    false,
  );
const CONNECTION_FAILED = (): CaptureIssue =>
  issue('CONNECTION_FAILED', 'provider', 'Failed to validate the connection to the source.', true);
const OUTPUT_LOCKED = (): CaptureIssue =>
  issue('OUTPUT_LOCKED', 'concurrency', 'Another capture run already holds the output lock.', true);
const FLOW_LOAD_FAILED = (flowId: string): CaptureIssue =>
  issue('FLOW_LOAD_FAILED', 'provider', 'Failed to load one flow definition.', true, flowId);
const PREVIOUS_BUNDLE_IS_MIGRATION = (): CaptureIssue =>
  issue(
    'INCREMENTAL_PREVIOUS_BUNDLE_IS_MIGRATION',
    'capture-mode',
    'The previous bundle was captured in migration mode. An incremental, context-mode run ' +
      'would either silently drop its resources and assets or misreport itself as still ' +
      'migration-ready; refusing rather than doing either. Run a full migration-mode capture.',
    false,
  );
const CAPTURE_FAILED = (): CaptureIssue =>
  issue('CAPTURE_FAILED', 'capture', 'The incremental capture run did not complete.', true);

/** Fixed, structural strings only -- never the flow's own tenant-authored
 * name or description. Mirrors `FlowActionReason`'s own contract: the reason
 * *code* is safe to log/persist, the flow it names is identified only by id. */
function reasonMessage(reason: FlowActionReason): string {
  switch (reason) {
    case 'NEVER_SEEN_BEFORE':
      return 'New flow: not present in the previous capture.';
    case 'NOT_FOUND_IN_DISCOVERY':
      return (
        "Retire-candidate: absent from this run's discovery. Confirm on a later run " +
        'before treating as deleted.'
      );
    case 'ACCESS_FORBIDDEN':
      return 'Inaccessible: permission to read this flow was denied. Not treated as deleted.';
    case 'GENERATOR_OR_POLICY_REBUILD_FORCED':
      return 'Rebuild forced by a generator or policy change, independent of the source.';
    case 'METADATA_UNCHANGED':
      return 'Unchanged: carried forward from the previous capture without a fresh read.';
    case 'METADATA_CHANGED_HASH_PENDING':
      return 'Metadata changed since the previous capture; re-captured.';
    case 'GRAPH_HASH_UNCHANGED':
      return 'Republished with no content change; carried forward.';
    case 'GRAPH_HASH_CHANGED':
      return 'Content changed since the previous capture; re-captured.';
  }
}

function expectedActionFor(
  kind: 'capture-new' | 'capture-update' | 'retire' | 'skip',
): RunManifestSelectionEntry['expectedAction'] {
  switch (kind) {
    case 'capture-new':
      return 'create';
    case 'capture-update':
      return 'update';
    case 'retire':
      return 'archive';
    case 'skip':
      return 'skip';
  }
}

export interface IncrementalCaptureOptions {
  readonly root: string;
  readonly runId: string;
  readonly planHash: string;
  readonly organizationId: OrganizationId;
  readonly expectedOrganizationId: OrganizationId;
  readonly provider: GenesysSourceProvider;
  readonly scope?: CaptureScope;
  readonly versionSelection?: VersionSelection;
  readonly planId?: string;
  readonly profileId?: string;
  readonly versions?: CaptureRunVersions;
  /** Where to persist the run manifest reporting what happened (docs/07's
   * "captured 3, carried forward 499"). Defaults to a `RunStore` rooted at
   * `options.root`; injectable for tests, mirroring `archivist-port.ts`'s
   * own `runStore` injection point. */
  readonly runStore?: RunStore;
  readonly now?: () => Date;
}

export interface IncrementalCaptureCounts {
  readonly captured: number;
  readonly carriedForward: number;
  readonly retired: number;
  readonly inaccessible: number;
}

export interface IncrementalCaptureResult {
  readonly runId: string;
  readonly state: 'completed' | 'completed_with_warnings' | 'failed';
  readonly bundleDir?: string;
  readonly contentHash?: string;
  readonly plan: IncrementalCapturePlan;
  readonly counts: IncrementalCaptureCounts;
  readonly warnings: readonly CaptureIssue[];
  readonly errors: readonly CaptureIssue[];
}

const EMPTY_PLAN: IncrementalCapturePlan = {
  toCapture: [],
  toSkip: [],
  retireCandidates: [],
  inaccessible: [],
  notInScope: [],
};
const EMPTY_COUNTS: IncrementalCaptureCounts = {
  captured: 0,
  carriedForward: 0,
  retired: 0,
  inaccessible: 0,
};

function failedResult(runId: string, errors: readonly CaptureIssue[]): IncrementalCaptureResult {
  return { runId, state: 'failed', plan: EMPTY_PLAN, counts: EMPTY_COUNTS, warnings: [], errors };
}

/**
 * Runs a capture over only the flows `planIncrementalCapture` says need it,
 * while still sealing and promoting a bundle that describes the *whole*
 * organization: every previous flow this run did not freshly fetch --
 * unchanged, retired, inaccessible, or simply outside this run's scope -- is
 * carried forward from the previous bundle's own definition bytes into the
 * new one via the same `BundleWriter` instance, before `seal()` ever hashes
 * it. A bundle produced this way is indistinguishable, in shape, from one a
 * full `runCapture` would have produced over every flow; only the request
 * count differs.
 *
 * **Context mode only.** Migration mode's resource closure and asset store
 * would need the same carry-forward treatment to stay honest, and merging a
 * partial deep walk over a previously-closed one safely is materially more
 * work than the shallow, single-hop resource-graph merge this function does
 * for context mode. Rather than emit a migration bundle that silently
 * regressed on completeness, this function only ever writes `policy.mode:
 * 'context'`, and refuses outright (`INCREMENTAL_PREVIOUS_BUNDLE_IS_MIGRATION`)
 * if the previous bundle at `root` was captured in migration mode.
 */
export async function runIncrementalCapture(
  options: IncrementalCaptureOptions,
): Promise<IncrementalCaptureResult> {
  const now = options.now ?? (() => new Date());
  const scope = options.scope ?? { kind: 'all' };
  const versionSelection = options.versionSelection ?? 'published';
  const bundleDir = bundleTargetDir(options.root);
  const hasPrevious = await bundleFlowsExist(bundleDir);

  if (hasPrevious) {
    const previousMode = await readPreviousPolicyMode(bundleDir);
    if (previousMode === 'migration') {
      return failedResult(options.runId, [PREVIOUS_BUNDLE_IS_MIGRATION()]);
    }
  }

  const lock = await acquireLock(options.root, 'capture');
  if (lock === null) {
    return failedResult(options.runId, [OUTPUT_LOCKED()]);
  }

  let staging: StagingArea | undefined;
  try {
    let identity;
    try {
      identity = await options.provider.validateConnection();
    } catch {
      return failedResult(options.runId, [CONNECTION_FAILED()]);
    }
    if (identity.organizationId !== options.expectedOrganizationId) {
      return failedResult(options.runId, [TENANT_MISMATCH()]);
    }

    const { plan, previous } = await computePlanAndPrevious(
      hasPrevious ? bundleDir : null,
      options.provider,
      scope,
    );

    staging = await createStaging(options.root, options.runId);
    const captureId = formatCaptureId(now(), options.runId);
    const writer = new BundleWriter({
      root: staging.dir,
      captureId,
      organization: {
        id: options.organizationId,
        region: identity.region,
        ...(identity.organizationName !== null ? { name: identity.organizationName } : {}),
      },
      policy: {
        mode: 'context',
        versionSelection,
        captureAssets: false,
        captureDataTableRows: false,
      },
      versions: {
        application: options.versions?.application ?? 'genesys-archivist',
        adapter: options.versions?.adapter ?? 'change-detection-io',
        sourceProvider: options.versions?.sourceProvider ?? 'fixture',
        ...(options.versions?.genesysSdk !== undefined
          ? { genesysSdk: options.versions.genesysSdk }
          : {}),
        ...(options.versions?.archy !== undefined ? { archy: options.versions.archy } : {}),
      },
      now,
    });

    const warnings: CaptureIssue[] = [];
    const errors: CaptureIssue[] = [];
    const flowResults: RunManifestFlowResult[] = [];
    const selection: RunManifestSelectionEntry[] = [];

    // Every previous flow not selected for a fresh fetch is written first,
    // from bytes already on disk -- unchanged, retired, inaccessible, and
    // out-of-scope alike. This is what keeps the new bundle whole: only
    // `plan.toCapture` below ever touches the provider.
    const captureIds = new Set(plan.toCapture.map((f) => f.flowId));
    const skipReasonByFlow = new Map<
      string,
      { readonly kind: 'skip' | 'retire' | 'inaccessible'; readonly reason?: FlowActionReason }
    >();
    for (const f of plan.toSkip) skipReasonByFlow.set(f.flowId, { kind: 'skip', reason: f.reason });
    for (const f of plan.retireCandidates) skipReasonByFlow.set(f.flowId, { kind: 'retire' });
    for (const f of plan.inaccessible) skipReasonByFlow.set(f.flowId, { kind: 'inaccessible' });

    let carriedForwardCount = 0;
    for (const [flowId, prevFlow] of previous) {
      if (captureIds.has(flowId)) continue;
      carriedForwardCount += 1;
      await writer.writeFlow(flowId, prevFlow.versionId, prevFlow.definition, {
        id: flowId,
        type: prevFlow.flowType,
        format: prevFlow.format,
      });

      const classification = skipReasonByFlow.get(flowId);
      const message =
        classification?.kind === 'retire'
          ? reasonMessage('NOT_FOUND_IN_DISCOVERY')
          : classification?.kind === 'inaccessible'
            ? reasonMessage('ACCESS_FORBIDDEN')
            : classification?.reason !== undefined
              ? reasonMessage(classification.reason)
              : "Outside this run's requested scope; carried forward without being evaluated.";
      const code =
        classification?.kind === 'retire'
          ? 'NOT_FOUND_IN_DISCOVERY'
          : classification?.kind === 'inaccessible'
            ? 'ACCESS_FORBIDDEN'
            : (classification?.reason ?? 'NOT_IN_SCOPE');

      flowResults.push({
        flowId,
        selectedVersion: prevFlow.versionId,
        status: 'skipped',
        sourceChanged: false,
        generatorChanged: false,
        warnings: [{ code, category: 'change-detection', message, retryable: false }],
        errors: [],
        artifacts: [],
      });
      selection.push({
        flowId,
        flowType: prevFlow.flowType,
        selectedVersion: prevFlow.versionId,
        expectedAction: expectedActionFor(classification?.kind === 'retire' ? 'retire' : 'skip'),
      });
    }

    // Freshly fetch exactly the flows the plan says changed or are new.
    const seeds: DependencyRef[] = [];
    let capturedCount = 0;
    let failedCount = 0;
    for (const planned of plan.toCapture) {
      try {
        const source = await options.provider.loadFlowSource({
          flowId: asFlowId(planned.flowId),
          versionId: null,
        });
        await writer.writeFlow(source.flowId, source.versionId, source.body, {
          id: planned.flowId,
          type: planned.flowType,
          format: source.format,
        });
        const [selfResolution] = await options.provider.resolveDependencies([
          { type: 'flow', id: asResourceId(planned.flowId) },
        ]);
        seeds.push(...extractReferences(selfResolution));

        capturedCount += 1;
        flowResults.push({
          flowId: planned.flowId,
          selectedVersion: String(source.versionId),
          status: 'completed',
          sourceChanged: true,
          generatorChanged: false,
          warnings: [
            {
              code: planned.reason,
              category: 'change-detection',
              message: reasonMessage(planned.reason),
              retryable: false,
            },
          ],
          errors: [],
          artifacts: [],
        });
        selection.push({
          flowId: planned.flowId,
          flowType: planned.flowType,
          selectedVersion: String(source.versionId),
          expectedAction: expectedActionFor(planned.isNew ? 'capture-new' : 'capture-update'),
        });
      } catch {
        const flowIssue = FLOW_LOAD_FAILED(planned.flowId);
        warnings.push(flowIssue);
        failedCount += 1;
        flowResults.push({
          flowId: planned.flowId,
          selectedVersion: 'unknown',
          status: 'failed',
          sourceChanged: false,
          generatorChanged: false,
          warnings: [],
          errors: [flowIssue],
          artifacts: [],
        });
        selection.push({
          flowId: planned.flowId,
          flowType: planned.flowType,
          selectedVersion: 'unknown',
          expectedAction: expectedActionFor(planned.isNew ? 'capture-new' : 'capture-update'),
        });
      }
    }

    // Resource graph: carry the previous one forward wholesale, unioned with
    // a shallow (one-hop, budget-capped) walk seeded only from the flows
    // actually captured this run -- the same shape context mode's own walk
    // in capture-run.ts produces for a full run, just scoped smaller. See
    // `mergeResourceGraphs`'s own comment for what this does and does not
    // guarantee about freshness.
    const dedupedSeeds = [...new Map(seeds.map((r) => [`${r.type}:${r.id}`, r] as const)).values()];
    const resolver = makeResolver(options.provider);
    const freshWalk: ResourceGraphResult =
      dedupedSeeds.length === 0
        ? { graph: { nodes: [], edges: [], orphans: [] }, truncated: false, requests: 0 }
        : await buildResourceGraph(dedupedSeeds, resolver, { maxRequests: dedupedSeeds.length });
    const previousGraph = hasPrevious
      ? await readPreviousResourceGraph(bundleDir)
      : { nodes: [], edges: [], orphans: [] };
    const mergedGraph = mergeResourceGraphs(previousGraph, freshWalk.graph);
    await writer.writeResourceGraph({
      graph: mergedGraph,
      truncated: false,
      requests: freshWalk.requests,
    });

    const sealed = await writer.seal();
    await promote(staging, bundleDir);

    const counts: IncrementalCaptureCounts = {
      captured: capturedCount,
      carriedForward: carriedForwardCount,
      retired: plan.retireCandidates.length,
      inaccessible: plan.inaccessible.length,
    };

    const runStore = options.runStore ?? createRunStore({ root: options.root });
    const nowIso = now().toISOString();
    const planId = options.planId ?? options.runId;
    const profileId = options.profileId ?? 'local';
    const state: IncrementalCaptureResult['state'] =
      failedCount > 0 || warnings.length > 0 ? 'completed_with_warnings' : 'completed';
    await runStore.save({
      schemaVersion: '1.1',
      stage: 'capture',
      runId: options.runId,
      planId,
      planHash: options.planHash,
      idempotencyKey: `${options.runId}:${options.planHash}`,
      profileId,
      organization: { id: options.organizationId, region: identity.region },
      state,
      createdAt: nowIso,
      startedAt: nowIso,
      finishedAt: nowIso,
      policy: { versionSelection, allowPartialPromotion: false, mode: 'context' },
      versions: {
        application: options.versions?.application ?? 'genesys-archivist',
        adapter: options.versions?.adapter ?? 'change-detection-io',
      },
      selection,
      progress: {
        total: selection.length,
        queued: 0,
        running: 0,
        completed: capturedCount,
        skipped: selection.length - capturedCount - failedCount,
        failed: failedCount,
      },
      flowResults,
      warnings,
      errors,
      artifacts: [
        {
          kind: 'capture-bundle',
          uri: bundleDir,
          hash: sealed.contentHash,
          classification: 'restricted',
        },
      ],
    });

    return {
      runId: options.runId,
      state,
      bundleDir,
      contentHash: sealed.contentHash,
      plan,
      counts,
      warnings,
      errors,
    };
  } catch {
    if (staging !== undefined) await staging.discard();
    return failedResult(options.runId, [CAPTURE_FAILED()]);
  } finally {
    await lock.release();
  }
}
