// packages/capture/src/capture-run.ts
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  asResourceId,
  type DependencyRef,
  type DependencyResolution,
  type FlowId,
  type GenesysSourceProvider,
  type OrganizationId,
} from '@genesys-archivist/domain';
import { resolveWithinRootReal, safeSegment } from '@genesys-archivist/security';
import { acquireLock, createStaging, promote, type StagingArea } from '@genesys-archivist/storage';
import {
  buildResourceGraph,
  type ResourceGraphResult,
  type ResourceResolver,
} from './resource-graph.js';
import {
  BundleWriter,
  type CaptureMode,
  type FlowMeta,
  type SourceProviderName,
  type VersionSelection,
} from './bundle-writer.js';

// Re-exported so callers of this module never need to reach into
// bundle-writer.ts directly just to name the mode.
export type { CaptureMode } from './bundle-writer.js';

/**
 * ADR-018 modeling note -- read this before changing anything that calls
 * `provider.resolveDependencies`.
 *
 * `docs/adr/ADR-018-capture-modes.md` describes a real Genesys response
 * (`getFlowVersionConfiguration`) that carries a `manifest` of every
 * referenced resource's name, id, and context *inline with the flow
 * definition, at no additional request*. `GenesysSourceProvider`
 * (packages/domain/src/source-provider.ts) has no field for that inline
 * manifest today -- `RawFlowSource` is just `{flowId, versionId, format,
 * body}`, and this task does not own packages/domain.
 *
 * Until the domain interface grows a dedicated field, this module models the
 * manifest with the one mechanism the interface does offer:
 * `resolveDependencies`. Two conventions, both scoped to this file:
 *
 *   1. A flow's own direct references are obtained by resolving a
 *      `{type: 'flow', id: flowId}` ref against the provider. A resolved
 *      flow-self resolution's `safeMetadata.references` (an array of
 *      `DependencyRef`) is read as "what this flow directly points to".
 *   2. Any resolved resource's own outward references, asset payload, and
 *      data-table rows are read the same way: `safeMetadata.references`,
 *      `safeMetadata.asset` (`{bytes, originalName, mimeType}`), and
 *      `safeMetadata.dataTableRows` (an array). `DependencyResolution`
 *      already declares `safeMetadata` as an open `Record<string,
 *      unknown>`, so nothing here requires a domain change to compile --
 *      but a production adapter needs one of these fields formalized on
 *      `DependencyResolution` (or `RawFlowSource`) rather than left as a
 *      private convention of one caller.
 *
 * This is also what makes the two modes' call-count difference real rather
 * than cosmetic: context mode resolves a flow's direct references only
 * (one shallow batch, capped so the walk cannot recurse); migration mode
 * walks the same references to full closure via `buildResourceGraph`, then
 * fetches every resolved node's full body from the very same resolutions
 * (cached during the walk -- see `#walk` below) rather than re-querying.
 */

export type CaptureScope =
  | { readonly kind: 'all'; readonly flowTypes?: readonly string[] }
  | { readonly kind: 'flows'; readonly flowIds: readonly FlowId[] };

export type CaptureRunTerminalState =
  'completed' | 'completed_with_warnings' | 'failed' | 'cancelled';

export interface CaptureIssue {
  readonly code: string;
  readonly category: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly flowId?: string | null;
}

export interface CaptureRunProgress {
  readonly total: number;
  readonly queued: number;
  readonly running: number;
  readonly completed: number;
  readonly skipped: number;
  readonly failed: number;
}

export interface CaptureRunVersions {
  readonly application?: string;
  readonly adapter?: string;
  readonly sourceProvider?: SourceProviderName;
  readonly genesysSdk?: string;
  readonly archy?: string;
}

export interface CaptureRunOptions {
  readonly root: string;
  readonly runId: string;
  readonly planHash: string;
  readonly organizationId: OrganizationId;
  readonly expectedOrganizationId: OrganizationId;
  readonly provider: GenesysSourceProvider;
  readonly mode: CaptureMode;
  readonly scope?: CaptureScope;
  readonly versionSelection?: VersionSelection;
  readonly maxRequests?: number;
  readonly planId?: string;
  readonly profileId?: string;
  readonly versions?: CaptureRunVersions;
  readonly now?: () => Date;
}

export interface CaptureRunResult {
  readonly runId: string;
  readonly state: CaptureRunTerminalState;
  readonly mode: CaptureMode;
  readonly contentHash?: string;
  readonly bundleDir?: string;
  readonly progress: CaptureRunProgress;
  readonly warnings: readonly CaptureIssue[];
  readonly errors: readonly CaptureIssue[];
}

// ---------------------------------------------------------------------------
// Path and id helpers
// ---------------------------------------------------------------------------

function bundleTargetDir(root: string): string {
  return join(root, 'bundle');
}

function runManifestPath(root: string, runId: string): string {
  return join(root, '.archivist', 'state', 'runs', `${safeSegment(runId)}.json`);
}

/** Produces a `capture-bundle.schema.json`-conformant captureId
 * (`YYYY-MM-DDTHH-mm-ssZ_xxxxxx`) deterministically from the clock and
 * runId, so tests never need real randomness. */
function formatCaptureId(now: Date, runId: string): string {
  const stamp = now.toISOString().slice(0, 19).replace(/:/g, '-');
  const suffix = createHash('sha256').update(runId).digest('hex').slice(0, 6);
  return `${stamp}Z_${suffix}`;
}

// ---------------------------------------------------------------------------
// The `references` / `asset` / `dataTableRows` safeMetadata convention
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

interface AssetPayload {
  readonly bytes: Uint8Array;
  readonly originalName: string;
  readonly mimeType: string;
}

function extractAsset(resolution: DependencyResolution): AssetPayload | undefined {
  const raw = resolution.safeMetadata['asset'];
  if (typeof raw !== 'object' || raw === null) return undefined;
  const candidate = raw as Record<string, unknown>;
  if (
    candidate['bytes'] instanceof Uint8Array &&
    typeof candidate['originalName'] === 'string' &&
    typeof candidate['mimeType'] === 'string'
  ) {
    return {
      bytes: candidate['bytes'],
      originalName: candidate['originalName'],
      mimeType: candidate['mimeType'],
    };
  }
  return undefined;
}

function extractDataTableRows(resolution: DependencyResolution): readonly unknown[] | undefined {
  const raw = resolution.safeMetadata['dataTableRows'];
  return Array.isArray(raw) && raw.length > 0 ? raw : undefined;
}

/** Wraps a provider as a `ResourceResolver` for `buildResourceGraph`, and
 * remembers every resolution it hands back (keyed the same way
 * `buildResourceGraph` keys its nodes) so migration mode can read resolved
 * bodies, assets, and data-table rows back out without a second round of
 * `resolveDependencies` calls for the same refs. */
function makeResolver(
  provider: GenesysSourceProvider,
  cache: Map<string, DependencyResolution>,
): ResourceResolver {
  return {
    resolve: async (refs) => {
      const resolutions = await provider.resolveDependencies(refs);
      for (const resolution of resolutions) {
        cache.set(`${resolution.ref.type}:${resolution.ref.id}`, resolution);
      }
      return resolutions;
    },
    outwardRefs: (resolution) => extractReferences(resolution),
  };
}

// ---------------------------------------------------------------------------
// Issue codes
// ---------------------------------------------------------------------------

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

// Fixed, content-free messages only. An upstream error's own .message is
// never included: it can carry endpoint URLs, header values, or captured
// content, and none of that may reach a log, error, or run-manifest field.
const TENANT_MISMATCH = (): CaptureIssue =>
  issue(
    'TENANT_MISMATCH',
    'security',
    'The connected organization does not match the organization this run was planned for.',
    false,
  );
const OUTPUT_LOCKED = (): CaptureIssue =>
  issue('OUTPUT_LOCKED', 'concurrency', 'Another capture run already holds the output lock.', true);
const PLAN_HASH_MISMATCH = (): CaptureIssue =>
  issue(
    'PLAN_HASH_MISMATCH',
    'resume',
    'The persisted run was planned under a different plan hash; refusing to resume it.',
    false,
  );
const RUN_NOT_FOUND = (): CaptureIssue =>
  issue('RUN_NOT_FOUND', 'resume', 'No persisted run manifest exists for this runId.', false);
const CONNECTION_FAILED = (): CaptureIssue =>
  issue('CONNECTION_FAILED', 'provider', 'Failed to validate the connection to the source.', true);
const DISCOVERY_FAILED = (): CaptureIssue =>
  issue('DISCOVERY_FAILED', 'provider', 'Flow discovery did not complete.', true);
const FLOW_LOAD_FAILED = (flowId: string): CaptureIssue =>
  issue('FLOW_LOAD_FAILED', 'provider', 'Failed to load one flow definition.', true, flowId);
const RESOURCE_WALK_SKIPPED = (): CaptureIssue =>
  issue(
    'RESOURCE_WALK_SKIPPED',
    'capture-mode',
    'walking_resources and downloading_assets were skipped by policy: this is a context-mode ' +
      'capture. See bundle-manifest.json policy.mode and migrationReadiness.caveats.',
    false,
  );
const RESOURCE_WALK_TRUNCATED = (): CaptureIssue =>
  issue(
    'RESOURCE_WALK_TRUNCATED',
    'capture',
    'The resource reference walk stopped at the request budget before reaching closure. ' +
      'See bundle-manifest.json migrationReadiness.caveats.',
    true,
  );

// ---------------------------------------------------------------------------
// Run-manifest persistence
//
// run-manifest.schema.json 1.1 carries a `stage` discriminator and the
// capture phases themselves, so this file no longer has to fold its real
// phase onto whichever Stage 2 phase looked closest. A run that died while
// walking resources now says so, which is the difference between a manifest
// an operator can act on and one they have to guess at.

type CapturePhase =
  | 'planned'
  | 'queued'
  | 'discovering'
  | 'fetching_definitions'
  | 'walking_resources'
  | 'downloading_assets'
  | 'sealing'
  | CaptureRunTerminalState;

interface FlowResultEntry {
  readonly flowId: string;
  readonly selectedVersion: string;
  readonly status: 'completed' | 'failed' | 'skipped';
  readonly sourceChanged: boolean;
  readonly generatorChanged: boolean;
  readonly warnings: readonly CaptureIssue[];
  readonly errors: readonly CaptureIssue[];
  readonly artifacts: readonly [];
}

interface RunManifestState {
  readonly runId: string;
  readonly planId: string;
  readonly planHash: string;
  readonly idempotencyKey: string;
  readonly profileId: string;
  readonly organizationId: string;
  // Learned from the provider's identity call, after this state exists.
  organizationName: string | null;
  region: string;
  readonly mode: CaptureMode;
  readonly versionSelection: VersionSelection;
  readonly versions: CaptureRunVersions;
  readonly createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  phase: CapturePhase;
  progress: CaptureRunProgress;
  flowResults: FlowResultEntry[];
  warnings: CaptureIssue[];
  errors: CaptureIssue[];
  bundleArtifact: { readonly uri: string; readonly hash: string } | null;
  /** True once something actually went wrong (a flow failed to load, the
   * resource walk hit its budget). RESOURCE_WALK_SKIPPED, by contrast, is an
   * honest disclosure of expected context-mode behavior, not a degradation
   * -- it must not, on its own, turn a clean context run into
   * "completed_with_warnings". */
  degraded: boolean;
}

function toManifestJson(state: RunManifestState): Record<string, unknown> {
  return {
    schemaVersion: '1.1',
    stage: 'capture',
    runId: state.runId,
    planId: state.planId,
    planHash: state.planHash,
    idempotencyKey: state.idempotencyKey,
    profileId: state.profileId,
    organization: {
      id: state.organizationId,
      region: state.region,
      ...(state.organizationName !== null ? { name: state.organizationName } : {}),
    },
    state: state.phase,
    createdAt: state.createdAt,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    policy: {
      mode: state.mode,
      versionSelection: state.versionSelection,
      // Capture promotes the whole staged bundle as one unit (see
      // capture-run.ts's staging/promote sequence) -- there is no notion of
      // promoting some flows and not others within a single run.
      allowPartialPromotion: false,
    },
    versions: {
      application: state.versions.application ?? 'genesys-archivist',
      adapter: state.versions.adapter ?? 'capture-run',
      // normalizer/analyzer/redactor/generator/template are deliberately
      // absent, not filled with a placeholder: a capture run does not run
      // those components, and a version string for one that never ran is a
      // fabricated fact. Schema 1.1 requires only application and adapter.
      ...(state.versions.genesysSdk !== undefined ? { genesysSdk: state.versions.genesysSdk } : {}),
    },
    selection: state.flowResults.map((r) => ({
      flowId: r.flowId,
      flowType: 'unknown',
      selectedVersion: r.selectedVersion,
      expectedAction: 'inspect',
    })),
    progress: state.progress,
    flowResults: state.flowResults,
    warnings: state.warnings,
    errors: state.errors,
    artifacts:
      state.bundleArtifact === null
        ? []
        : [
            {
              kind: 'capture-bundle',
              uri: state.bundleArtifact.uri,
              hash: state.bundleArtifact.hash,
              classification: 'restricted',
            },
          ],
  };
}

async function persistManifest(root: string, state: RunManifestState): Promise<void> {
  const path = await resolveWithinRootReal(root, [
    '.archivist',
    'state',
    'runs',
    `${safeSegment(state.runId)}.json`,
  ]);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(toManifestJson(state), null, 2) + '\n', 'utf8');
}

async function readManifest(root: string, runId: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(runManifestPath(root, runId), 'utf8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

function emptyProgress(): CaptureRunProgress {
  return { total: 0, queued: 0, running: 0, completed: 0, skipped: 0, failed: 0 };
}

function terminalResult(
  runId: string,
  mode: CaptureMode,
  state: CaptureRunTerminalState,
  errors: readonly CaptureIssue[],
  warnings: readonly CaptureIssue[] = [],
  progress: CaptureRunProgress = emptyProgress(),
): CaptureRunResult {
  return { runId, state, mode, progress, warnings, errors };
}

/** flowIds already durably present in the last promoted bundle at `root`,
 * available to skip re-fetching on a resume of a run that never got to
 * promote its own attempt. Returns an empty map if there is no prior bundle. */
async function readPromotedFlows(
  root: string,
): Promise<
  Map<string, { readonly versionId: string; readonly meta: FlowMeta; readonly yaml: string }>
> {
  const result = new Map<
    string,
    { readonly versionId: string; readonly meta: FlowMeta; readonly yaml: string }
  >();
  const flowsDir = join(bundleTargetDir(root), 'flows');
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
      const yaml = await readFile(join(versionsDir, versionId, 'definition.yaml'), 'utf8');
      result.set(flowId, { versionId, meta, yaml });
    } catch {
      // Unreadable prior flow: fall through to refetching it fresh below.
      continue;
    }
  }
  return result;
}

interface ExecuteParams {
  readonly options: CaptureRunOptions;
  readonly alreadyPromoted: Map<
    string,
    { readonly versionId: string; readonly meta: FlowMeta; readonly yaml: string }
  >;
}

async function execute({ options, alreadyPromoted }: ExecuteParams): Promise<CaptureRunResult> {
  const now = options.now ?? (() => new Date());
  const scope = options.scope ?? { kind: 'all' };
  const versionSelection = options.versionSelection ?? 'published';
  const createdAt = now().toISOString();

  const manifestState: RunManifestState = {
    runId: options.runId,
    planId: options.planId ?? options.runId,
    planHash: options.planHash,
    idempotencyKey: `${options.runId}:${options.planHash}`,
    profileId: options.profileId ?? 'local',
    mode: options.mode,
    organizationId: options.organizationId,
    organizationName: null,
    region: 'unknown',
    versionSelection,
    versions: options.versions ?? {},
    createdAt,
    startedAt: null,
    finishedAt: null,
    phase: 'planned',
    progress: emptyProgress(),
    flowResults: [],
    warnings: [],
    errors: [],
    bundleArtifact: null,
    degraded: false,
  };

  const lock = await acquireLock(options.root, 'capture');
  if (lock === null) {
    manifestState.phase = 'failed';
    manifestState.errors.push(OUTPUT_LOCKED());
    manifestState.finishedAt = now().toISOString();
    await persistManifest(options.root, manifestState);
    return terminalResult(options.runId, options.mode, 'failed', manifestState.errors);
  }

  let staging: StagingArea | undefined;
  try {
    manifestState.phase = 'queued';
    manifestState.startedAt = now().toISOString();
    await persistManifest(options.root, manifestState);

    // Tenant guard: this must be the first read of any kind against the
    // provider. No flow may be discovered or loaded before this check
    // passes.
    let identity;
    try {
      identity = await options.provider.validateConnection();
    } catch {
      manifestState.phase = 'failed';
      manifestState.errors.push(CONNECTION_FAILED());
      manifestState.finishedAt = now().toISOString();
      await persistManifest(options.root, manifestState);
      return terminalResult(options.runId, options.mode, 'failed', manifestState.errors);
    }
    if (identity.organizationId !== options.expectedOrganizationId) {
      manifestState.phase = 'failed';
      manifestState.errors.push(TENANT_MISMATCH());
      manifestState.finishedAt = now().toISOString();
      await persistManifest(options.root, manifestState);
      return terminalResult(options.runId, options.mode, 'failed', manifestState.errors);
    }
    manifestState.organizationName = identity.organizationName;
    manifestState.region = identity.region;

    // --- discovering -----------------------------------------------------
    manifestState.phase = 'discovering';
    await persistManifest(options.root, manifestState);

    const flowTypes = scope.kind === 'all' ? scope.flowTypes : undefined;
    // exactOptionalPropertyTypes: "no filter" is an omitted key, not a key
    // explicitly set to undefined.
    const discoveryQuery = flowTypes === undefined ? {} : { flowTypes };
    const wantedIds = scope.kind === 'flows' ? new Set(scope.flowIds.map(String)) : null;
    const selected: { readonly flowId: string; readonly type: string }[] = [];
    try {
      for await (const flow of options.provider.listFlows(discoveryQuery)) {
        if (wantedIds !== null && !wantedIds.has(flow.flowId)) continue;
        selected.push({ flowId: flow.flowId, type: flow.type });
      }
    } catch {
      manifestState.phase = 'failed';
      manifestState.errors.push(DISCOVERY_FAILED());
      manifestState.finishedAt = now().toISOString();
      await persistManifest(options.root, manifestState);
      return terminalResult(options.runId, options.mode, 'failed', manifestState.errors, [], {
        ...emptyProgress(),
      });
    }

    manifestState.progress = {
      ...emptyProgress(),
      total: selected.length,
      queued: selected.length,
    };
    await persistManifest(options.root, manifestState);

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
        mode: options.mode,
        versionSelection,
        captureAssets: options.mode === 'migration',
        captureDataTableRows: options.mode === 'migration',
        ...(flowTypes !== undefined ? { flowTypes } : {}),
      },
      versions: {
        application: options.versions?.application ?? 'genesys-archivist',
        adapter: options.versions?.adapter ?? 'capture-run',
        sourceProvider: options.versions?.sourceProvider ?? 'fixture',
        ...(options.versions?.genesysSdk !== undefined
          ? { genesysSdk: options.versions.genesysSdk }
          : {}),
        ...(options.versions?.archy !== undefined ? { archy: options.versions.archy } : {}),
      },
      now,
    });

    // --- fetching_definitions ---------------------------------------------
    manifestState.phase = 'fetching_definitions';
    await persistManifest(options.root, manifestState);

    const selfManifestByFlow = new Map<string, DependencyRef[]>();

    for (const flow of selected) {
      const promotedEntry = alreadyPromoted.get(flow.flowId);
      if (promotedEntry !== undefined) {
        await writer.writeFlow(
          flow.flowId,
          promotedEntry.versionId,
          promotedEntry.yaml,
          promotedEntry.meta,
        );
        manifestState.progress = {
          ...manifestState.progress,
          queued: manifestState.progress.queued - 1,
          skipped: manifestState.progress.skipped + 1,
        };
        manifestState.flowResults.push({
          flowId: flow.flowId,
          selectedVersion: promotedEntry.versionId,
          status: 'skipped',
          sourceChanged: false,
          generatorChanged: false,
          warnings: [],
          errors: [],
          artifacts: [],
        });
        await persistManifest(options.root, manifestState);
        continue;
      }

      try {
        const source = await options.provider.loadFlowSource({
          flowId: flow.flowId as never,
          versionId: null,
        });
        await writer.writeFlow(source.flowId, source.versionId, source.body, {
          id: flow.flowId,
          type: flow.type,
        });
        manifestState.progress = {
          ...manifestState.progress,
          queued: manifestState.progress.queued - 1,
          completed: manifestState.progress.completed + 1,
        };
        manifestState.flowResults.push({
          flowId: flow.flowId,
          selectedVersion: String(source.versionId),
          status: 'completed',
          sourceChanged: true,
          generatorChanged: false,
          warnings: [],
          errors: [],
          artifacts: [],
        });

        // The "manifest that arrives with the definition" -- see the
        // modeling-convention comment at the top of this file.
        const [selfResolution] = await options.provider.resolveDependencies([
          { type: 'flow', id: asResourceId(flow.flowId) },
        ]);
        selfManifestByFlow.set(flow.flowId, extractReferences(selfResolution));
      } catch {
        const flowIssue = FLOW_LOAD_FAILED(flow.flowId);
        manifestState.progress = {
          ...manifestState.progress,
          queued: manifestState.progress.queued - 1,
          failed: manifestState.progress.failed + 1,
        };
        manifestState.flowResults.push({
          flowId: flow.flowId,
          selectedVersion: 'unknown',
          status: 'failed',
          sourceChanged: false,
          generatorChanged: false,
          warnings: [],
          errors: [flowIssue],
          artifacts: [],
        });
        manifestState.warnings.push(flowIssue);
        manifestState.degraded = true;
      }
      await persistManifest(options.root, manifestState);
    }

    // --- walking_resources / downloading_assets ---------------------------
    const seeds = [
      ...new Set([...selfManifestByFlow.values()].flat().map((r) => `${r.type}:${r.id}`)),
    ].map((key): DependencyRef => {
      const [type = '', id = ''] = key.split(':');
      return { type, id: asResourceId(id) };
    });

    if (options.mode === 'context') {
      manifestState.phase = 'walking_resources';
      manifestState.warnings.push(RESOURCE_WALK_SKIPPED());
      await persistManifest(options.root, manifestState);

      // A shallow, single-level snapshot of what each flow directly
      // references -- resolved (so status/displayName are honest), never
      // expanded further. maxRequests caps the walk to exactly one batch;
      // buildResourceGraph would otherwise report `truncated: true` once it
      // saw further hops it could not afford, which is correct for a
      // genuine budget cutoff but wrong here -- this stop is a deliberate
      // policy choice, not an exhausted budget, so the flag is overridden
      // below before it reaches the bundle.
      const cache = new Map<string, DependencyResolution>();
      const resolver = makeResolver(options.provider, cache);
      const shallow: ResourceGraphResult =
        seeds.length === 0
          ? { graph: { nodes: [], edges: [], orphans: [] }, truncated: false, requests: 0 }
          : await buildResourceGraph(seeds, resolver, { maxRequests: seeds.length });
      await writer.writeResourceGraph({ ...shallow, truncated: false });
    } else {
      manifestState.phase = 'walking_resources';
      await persistManifest(options.root, manifestState);

      const cache = new Map<string, DependencyResolution>();
      const resolver = makeResolver(options.provider, cache);
      const walkOptions =
        options.maxRequests !== undefined ? { maxRequests: options.maxRequests } : {};
      const result = await buildResourceGraph(seeds, resolver, walkOptions);
      await writer.writeResourceGraph(result);
      if (result.truncated) {
        manifestState.warnings.push(RESOURCE_WALK_TRUNCATED());
        manifestState.degraded = true;
      }

      manifestState.phase = 'downloading_assets';
      await persistManifest(options.root, manifestState);

      for (const node of result.graph.nodes) {
        if (node.resolutionStatus !== 'resolved') continue;
        const resolution = cache.get(node.key);
        if (resolution === undefined) continue;

        await writer.writeResource(node.type, node.id, sanitizeBody(resolution.safeMetadata));

        const asset = extractAsset(resolution);
        if (asset !== undefined) {
          await writer.putAsset(asset.bytes, {
            originalName: asset.originalName,
            mimeType: asset.mimeType,
            usedBy: { type: node.type, id: node.id },
          });
        }

        const rows = extractDataTableRows(resolution);
        if (rows !== undefined) {
          await writer.writeResource('datatable-rows', node.id, { rows });
        }
      }
    }

    // --- sealing / promoting ----------------------------------------------
    manifestState.phase = 'sealing';
    await persistManifest(options.root, manifestState);

    const sealed = await writer.seal();
    const target = bundleTargetDir(options.root);
    await promote(staging, target);

    manifestState.bundleArtifact = { uri: target, hash: sealed.contentHash };

    const finalState: CaptureRunTerminalState = manifestState.degraded
      ? 'completed_with_warnings'
      : 'completed';
    manifestState.phase = finalState;
    manifestState.finishedAt = now().toISOString();
    await persistManifest(options.root, manifestState);

    return {
      runId: options.runId,
      state: finalState,
      mode: options.mode,
      contentHash: sealed.contentHash,
      bundleDir: target,
      progress: manifestState.progress,
      warnings: manifestState.warnings,
      errors: manifestState.errors,
    };
  } catch {
    // Any unexpected failure past this point must never promote and must
    // never leave the previous bundle disturbed: discard staging (if any
    // was created) and report failure. `promote` itself already restores the
    // prior target on a mid-rename failure.
    if (staging !== undefined) await staging.discard();
    manifestState.phase = 'failed';
    manifestState.errors.push(
      issue('CAPTURE_FAILED', 'capture', 'The capture run did not complete.', true),
    );
    manifestState.finishedAt = now().toISOString();
    await persistManifest(options.root, manifestState);
    return terminalResult(
      options.runId,
      options.mode,
      'failed',
      manifestState.errors,
      manifestState.warnings,
      manifestState.progress,
    );
  } finally {
    await lock.release();
  }
}

/** Strips the free-form `references` / `asset` / `dataTableRows` modeling
 * keys back out of a resolution's safeMetadata before it is written as a
 * resource body -- those are this file's own bookkeeping, not part of the
 * resource. Everything else in safeMetadata is, by the domain interface's
 * own contract, already safe to persist. */
const MODELING_ONLY_KEYS = new Set(['references', 'asset', 'dataTableRows']);

function sanitizeBody(safeMetadata: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(safeMetadata).filter(([key]) => !MODELING_ONLY_KEYS.has(key)),
  );
}

export async function runCapture(options: CaptureRunOptions): Promise<CaptureRunResult> {
  return execute({ options, alreadyPromoted: new Map() });
}

export async function resumeCapture(
  runId: string,
  options: CaptureRunOptions,
): Promise<CaptureRunResult> {
  const persisted = await readManifest(options.root, runId);
  if (persisted === null) {
    return terminalResult(runId, options.mode, 'failed', [RUN_NOT_FOUND()]);
  }
  const persistedPlanHash = isRecord(persisted) ? persisted['planHash'] : undefined;
  if (typeof persistedPlanHash !== 'string' || persistedPlanHash !== options.planHash) {
    return terminalResult(runId, options.mode, 'failed', [PLAN_HASH_MISMATCH()]);
  }

  const persistedState = persisted['state'];
  if (persistedState === 'completed' || persistedState === 'completed_with_warnings') {
    // Nothing left to do: every flow this run captured is already durably
    // sealed and promoted. Report it as fully skipped rather than touching
    // the provider or the bundle again.
    const progressRaw = persisted['progress'];
    const priorCompleted =
      isRecord(progressRaw) && typeof progressRaw['completed'] === 'number'
        ? progressRaw['completed']
        : 0;
    const priorSkipped =
      isRecord(progressRaw) && typeof progressRaw['skipped'] === 'number'
        ? progressRaw['skipped']
        : 0;
    const total =
      isRecord(progressRaw) && typeof progressRaw['total'] === 'number' ? progressRaw['total'] : 0;
    const artifacts: unknown = persisted['artifacts'];
    const firstArtifact: unknown = Array.isArray(artifacts)
      ? (artifacts as readonly unknown[])[0]
      : undefined;
    const bundleArtifact =
      isRecord(firstArtifact) && typeof firstArtifact['hash'] === 'string'
        ? firstArtifact['hash']
        : undefined;

    return {
      runId,
      state: persistedState,
      mode: options.mode,
      ...(bundleArtifact !== undefined ? { contentHash: bundleArtifact } : {}),
      bundleDir: bundleTargetDir(options.root),
      progress: {
        total,
        queued: 0,
        running: 0,
        completed: priorCompleted,
        skipped: priorSkipped + priorCompleted,
        failed: 0,
      },
      warnings: [],
      errors: [],
    };
  }

  // The persisted run never reached a terminal success. Retry it, but skip
  // re-fetching any flow that is already durably present in the last
  // promoted bundle (if there is one) rather than hitting the provider for
  // content this machine already has on disk.
  const alreadyPromoted = await readPromotedFlows(options.root);
  return execute({ options, alreadyPromoted });
}
