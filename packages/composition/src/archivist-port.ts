// packages/composition/src/archivist-port.ts
//
// `createArchivistPort` builds the real `ArchivistPort` implementation from
// concrete adapters: a profile store, a secret store, an injected
// `GenesysSourceProvider` factory, a run store, and the Stage 1 / Stage 2
// pipelines already wired elsewhere in this package.
//
// `GenesysSourceProvider` is still injected (`deps.providerFor`), even
// though `@genesys-archivist/genesys-source` now exports a real production
// adapter (`createPlatformSourceProvider`, wired by `genesys-provider.ts`'s
// `createGenesysProvider` in this same package): keeping the port itself
// taking a provider by injection, rather than constructing one internally,
// is what keeps this whole file provable against `FakeSourceProvider`
// (`@genesys-archivist/testing`) with no network and no real credential --
// `createGenesysProvider` is one *implementation* of `deps.providerFor`, not
// a replacement for the seam.
//
// `diffFlow` is injected too (`deps.diffFlow`): `packages/analysis/src/
// diff.ts`'s `diffSnapshots` is being built in parallel by another agent
// this same wave, and this file must compile and be testable today
// regardless of that function's shape when it lands. Wire the real function
// in at the call site that constructs `ArchivistPortDeps` once it exists.
import { readdir, readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import {
  asFlowVersionId,
  asOrganizationId,
  asProfileId,
  type FlowId,
  type GenesysSourceProvider,
  type ProfileId,
} from '@genesys-archivist/domain';
import {
  createPlan as createPlanUseCase,
  initialRunMachineState,
  isTerminalRunState,
  transition,
  verifyPlan,
  PlanRejectedError,
  type ArchivistPort,
  type ConnectionCheckResult,
  type FlowDescriptor as PortFlowDescriptor,
  type FlowInspection,
  type FlowListPage,
  type FlowListQuery,
  type FlowPublicationState,
  type Plan,
  type PlanCandidateFlow,
  type PlanInput,
  type PlanResult,
  type PlanScope,
  type ProfileSummary,
  type ResourceDocument,
  type ResourceLocator,
  type RunError,
  type RunMachineState,
  type RunState,
  type RunStatus,
} from '@genesys-archivist/application';
import { analyzeFlow } from '@genesys-archivist/analysis';
import { normalizeFlow } from '@genesys-archivist/normalization';
import { runCapture, type CaptureScope } from '@genesys-archivist/capture';
import {
  resolveWithinRoot,
  safeSegment,
  toSafeProfileSummary,
  type SecretStore,
} from '@genesys-archivist/security';
import type { ProfileStore } from '@genesys-archivist/storage';
import { documentBundleToDisk } from './document-bundle-to-disk.js';
import {
  createRunStore,
  type LoadRunResult,
  type RunManifest,
  type RunManifestArtifact,
  type RunManifestIssue,
  type RunManifestProgress,
  type RunStore,
} from './run-store.js';

// ---------------------------------------------------------------------------
// Injection points
// ---------------------------------------------------------------------------

export interface ArchivistPortDeps {
  readonly profileStore: ProfileStore;
  readonly secretStore: SecretStore;
  /** Resolves a real `GenesysSourceProvider` for one profile. A real caller
   * wires `genesys-provider.ts`'s `createGenesysProvider`; tests supply one
   * backed by `FakeSourceProvider`. Kept as an injection point rather than
   * called directly so this whole file stays provable with no network and
   * no real credential -- see this file's header comment. */
  readonly providerFor: (profileId: ProfileId) => Promise<GenesysSourceProvider>;
  /** `packages/analysis/src/diff.ts`'s `diffSnapshots`, once it exists. See
   * this file's header comment. */
  readonly diffFlow: ArchivistPort['diffFlow'];
  readonly runStore?: RunStore;
  /**
   * Fallback root for the run store, used only when `runStore` is not
   * supplied. **A profile's own `outputRoot` is the wrong thing to pass
   * here for a server that serves more than one profile**: `getRun`/
   * `cancelRun` take a bare `runId` with no `profileId`, so this port needs
   * exactly one place to find any run's manifest regardless of which
   * profile started it -- capture bundles and documents, by contrast,
   * correctly land under *each run's own* `profile.outputRoot` inside
   * `executeRun`, which is unrelated to this fallback. A real caller
   * (`apps/mcp-server/src/wire.ts`) should construct an explicit `runStore`
   * rooted somewhere profile-independent (e.g. under
   * `defaultConfigRoot()`) and pass it as `runStore` instead of relying on
   * this default, which exists only so a single-profile test can omit both.
   */
  readonly outputRoot?: string;
  readonly now?: () => Date;
  readonly generateId?: () => string;
  readonly generateRunId?: () => string;
}

// ---------------------------------------------------------------------------
// genesys-docs:// URI construction
//
// Mirrors apps/mcp-server/src/resources.ts's `buildResourceUri` exactly --
// same scheme, same segment order -- without importing it: composition may
// not depend on `apps/*` (the dependency direction runs the other way), so
// this is necessarily a second, small copy of the same string format rather
// than a shared function.
// ---------------------------------------------------------------------------

function flowResourceUri(
  kind: 'snapshot' | 'evidence' | 'business' | 'technical',
  organizationId: string,
  flowId: string,
  version: string,
): string {
  return `genesys-docs://organizations/${organizationId}/flows/${flowId}/versions/${version}/${kind}`;
}

function runResourceUri(kind: 'report' | 'errors', runId: string): string {
  return `genesys-docs://runs/${runId}/${kind}`;
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function defaultNow(): Date {
  return new Date();
}

let idCounter = 0;
/** Not cryptographically random -- ids only need to be unique per process,
 * and a real caller is expected to inject a real generator (e.g.
 * `randomUUID`). This default exists so the port is constructible in a test
 * without also wiring an id source. */
function defaultGenerateId(prefix: string): () => string {
  return () => {
    idCounter += 1;
    return `${prefix}-${String(idCounter)}-${String(Date.now())}`;
  };
}

function toPublicationState(descriptor: {
  readonly publishedVersion: string | null;
}): FlowPublicationState {
  // GenesysSourceProvider's FlowDescriptor (packages/domain/src/
  // source-provider.ts) carries no draft/unpublished distinction -- only
  // whether a published version exists. Claiming 'draft' or 'unpublished'
  // from that alone would be inference presented as fact, which AGENTS.md
  // forbids; 'unknown' is the honest label for "no published version, and
  // this provider cannot say more".
  return descriptor.publishedVersion !== null ? 'published' : 'unknown';
}

function parseDefinition(format: 'yaml' | 'json', body: string): unknown {
  return format === 'json' ? (JSON.parse(body) as unknown) : parseYaml(body);
}

function issueToRunError(issue: RunManifestIssue): RunError {
  return {
    code: issue.code,
    message: issue.message,
    ...(issue.flowId !== undefined && issue.flowId !== null ? { flowId: issue.flowId } : {}),
  };
}

function toRunStatus(manifest: RunManifest): RunStatus {
  return {
    runId: manifest.runId,
    planId: manifest.planId,
    // Written exclusively by this file's own persist() helper below, which
    // only ever assigns a value from application's RunState union -- the
    // cast documents that invariant rather than re-deriving it with a
    // second runtime check the schema already performs on save/load.
    state: manifest.state as RunState,
    perFlowCounts: {
      total: manifest.progress.total,
      queued: manifest.progress.queued,
      running: manifest.progress.running,
      completed: manifest.progress.completed,
      skipped: manifest.progress.skipped,
      failed: manifest.progress.failed,
    },
    errors: manifest.errors.map(issueToRunError),
    warnings: manifest.warnings.map((w) => w.message),
    startedAt: manifest.startedAt ?? null,
    updatedAt: manifest.finishedAt ?? manifest.startedAt ?? manifest.createdAt ?? '',
    finishedAt: manifest.finishedAt ?? null,
    resourceUris: [
      runResourceUri('report', manifest.runId),
      runResourceUri('errors', manifest.runId),
    ],
  };
}

// ---------------------------------------------------------------------------
// createArchivistPort
// ---------------------------------------------------------------------------

export function createArchivistPort(deps: ArchivistPortDeps): ArchivistPort {
  const now = deps.now ?? defaultNow;
  const generateId = deps.generateId ?? defaultGenerateId('plan');
  const generateRunId = deps.generateRunId ?? defaultGenerateId('run');
  // `?? '.'` used to stand where this check does. A caller that supplied
  // neither `runStore` nor `outputRoot` silently rooted the durable run store
  // at the *current working directory* — writing run manifests and lock files
  // into whatever directory the process happened to start in, and, worse,
  // sharing that directory with every other such caller, so two ports could
  // mint the same run id over the same files.
  //
  // A durable store's location is not something to guess a default for.
  if (deps.runStore === undefined && deps.outputRoot === undefined) {
    throw new Error(
      'createArchivistPort requires either a runStore or an outputRoot: the run store ' +
        'needs one durable location to find any run by id, and defaulting it to the ' +
        'working directory would scatter run state wherever the process was started.',
    );
  }
  const runStore = deps.runStore ?? createRunStore({ root: deps.outputRoot as string });

  // Plans are short-lived (15 minutes, per plan.ts's DEFAULT_EXPIRY_MS) and
  // this server process is long-running for the lifetime of one MCP
  // session, so an in-memory cache is sufficient -- unlike a run, a plan
  // does not need to survive a process restart to satisfy docs/03, which
  // only requires *runs* to be durable. A plan that outlives the process it
  // was created in is expired anyway.
  const planCache = new Map<string, Plan>();
  const runIdByPlanId = new Map<string, string>();
  const cancellationRequested = new Map<string, boolean>();

  interface ResolvedProfile {
    readonly profileId: string;
    readonly expectedOrganizationId: string;
    readonly region: string;
    readonly outputRoot: string;
  }

  async function requireProfile(profileId: ProfileId): Promise<ResolvedProfile> {
    const profile = await deps.profileStore.get(profileId);
    if (profile === null) throw new Error('No profile matches the supplied profileId.');
    return profile;
  }

  async function outputRootForOrganization(organizationId: string): Promise<string | null> {
    const { profiles } = await deps.profileStore.list();
    const match = profiles.find((p) => p.expectedOrganizationId === organizationId);
    return match?.outputRoot ?? null;
  }

  const LOAD_RUN_RETRY_ATTEMPTS = 5;
  const LOAD_RUN_RETRY_DELAY_MS = 15;

  /**
   * Loads a run manifest, retrying briefly on a transient 'absent' before
   * concluding the run genuinely does not exist.
   *
   * `promote()` (`@genesys-archivist/storage`'s atomic.ts) makes its target
   * path momentarily absent between its two renames -- documented, correct
   * behavior of the atomic swap, not a bug. A run this port started writes
   * several manifests in quick succession as `executeRun` advances through
   * states, so a caller polling `getRun` shortly after `startRun` returns
   * can land exactly inside that window. Without this retry, that caller
   * would see a spurious "no run matches" for a run that plainly exists and
   * is simply mid-write -- worse than a few milliseconds of extra latency.
   */
  async function loadRunOrThrow(
    runId: string,
  ): Promise<Extract<LoadRunResult, { status: 'found' }>> {
    for (let attempt = 0; attempt < LOAD_RUN_RETRY_ATTEMPTS; attempt += 1) {
      const result = await runStore.load(runId);
      if (result.status === 'found') return result;
      if (result.status === 'corrupt') throw new Error('The run record for this runId is corrupt.');
      if (attempt < LOAD_RUN_RETRY_ATTEMPTS - 1) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, LOAD_RUN_RETRY_DELAY_MS));
      }
    }
    throw new Error('No run matches the supplied runId.');
  }

  async function discoverCandidates(
    provider: GenesysSourceProvider,
    scope: PlanScope,
  ): Promise<PlanCandidateFlow[]> {
    const flowTypes = scope.kind === 'organization' ? scope.flowTypes : undefined;
    const wanted = scope.kind === 'flows' ? new Set(scope.flows.map((f) => f.flowId)) : null;
    const query = flowTypes !== undefined ? { flowTypes } : {};

    const out: PlanCandidateFlow[] = [];
    for await (const flow of provider.listFlows(query)) {
      if (wanted !== null && !wanted.has(flow.flowId)) continue;
      // A flow with no published version has nothing for the default
      // 'published' versionSelection policy to target. Rather than invent a
      // version, it is left out of the candidate set -- if it was
      // explicitly requested by id, plan.ts's matchCandidates already turns
      // "requested but not among the candidates" into a warning on the
      // resulting plan, so this is reported, not silently dropped.
      if (flow.publishedVersion === null) continue;
      out.push({
        flowId: flow.flowId,
        flowType: flow.type,
        targetVersion: flow.publishedVersion,
        // True change detection (docs/07) compares a candidate's version
        // against a prior run's per-flow manifest entry. That comparison is
        // not implemented in this wave; every candidate is conservatively
        // reported as changed, which can only ever over-report work still
        // to be done, never silently skip a flow that actually changed.
        changed: true,
      });
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Run persistence
  // -------------------------------------------------------------------------

  function zeroProgress(total: number): RunManifestProgress {
    return { total, queued: total, running: 0, completed: 0, skipped: 0, failed: 0 };
  }

  function buildManifest(params: {
    readonly runId: string;
    readonly plan: Plan;
    readonly profile: ResolvedProfile;
    readonly state: RunState;
    readonly createdAt: string;
    readonly startedAt: string | null;
    readonly finishedAt: string | null;
    readonly progress: RunManifestProgress;
    readonly warnings: readonly RunManifestIssue[];
    readonly errors: readonly RunManifestIssue[];
    readonly artifacts: readonly RunManifestArtifact[];
  }): RunManifest {
    const { plan } = params;
    return {
      schemaVersion: '1.1',
      stage: 'document',
      runId: params.runId,
      planId: plan.planId,
      planHash: plan.planHash,
      idempotencyKey: `${params.runId}:${plan.planHash}`,
      profileId: plan.profileId,
      organization: { id: params.profile.expectedOrganizationId, region: params.profile.region },
      state: params.state,
      createdAt: params.createdAt,
      startedAt: params.startedAt,
      finishedAt: params.finishedAt,
      policy: {
        // A stage-2 documentation run does not itself capture (runCapture
        // is invoked as an internal step of "extracting" -- see this file's
        // header comment and the task's final report), so the mode this
        // manifest records is capture's own context/migration choice, fixed
        // to 'context' here for the same reason createPlan hardcodes it: no
        // MCP tool exposes migration mode today (ADR-018).
        versionSelection: 'published',
        allowPartialPromotion: false,
        mode: 'context',
      },
      versions: { application: 'genesys-archivist', adapter: 'archivist-port' },
      selection: plan.selectedFlowIds.map((flowId) => ({
        flowId,
        // Neither the public Plan DTO nor capture's own selection records a
        // per-flow type (capture-run.ts's own manifest writer has the
        // identical gap, for the identical reason) -- 'unknown' here is
        // consistent with that existing precedent rather than a new one.
        flowType: 'unknown',
        selectedVersion: plan.targetVersions[flowId] ?? 'unknown',
        expectedAction: 'update',
      })),
      progress: params.progress,
      flowResults: [],
      warnings: params.warnings,
      errors: params.errors,
      artifacts: params.artifacts,
    };
  }

  /** A single merged options bag, rather than two positional objects: every
   * call site persists both "when" (createdAt/startedAt/finishedAt) and
   * "what happened" (progress/warnings/errors/artifacts) together, and a
   * two-object signature only invited exactly the mistake of putting a
   * `PersistOutcome` field into the `times` position that this shape rules
   * out at the type level. */
  interface PersistOptions {
    readonly createdAt: string;
    readonly startedAt: string | null;
    readonly finishedAt: string | null;
    readonly progress?: RunManifestProgress;
    readonly warnings?: readonly RunManifestIssue[];
    readonly errors?: readonly RunManifestIssue[];
    readonly artifacts?: readonly RunManifestArtifact[];
  }

  async function persist(
    runId: string,
    plan: Plan,
    profile: ResolvedProfile,
    state: RunState,
    options: PersistOptions,
  ): Promise<RunManifest> {
    const manifest = buildManifest({
      runId,
      plan,
      profile,
      state,
      createdAt: options.createdAt,
      startedAt: options.startedAt,
      finishedAt: options.finishedAt,
      progress: options.progress ?? zeroProgress(plan.selectedFlowIds.length),
      warnings: options.warnings ?? [],
      errors: options.errors ?? [],
      artifacts: options.artifacts ?? [],
    });
    await runStore.save(manifest);
    return manifest;
  }

  // -------------------------------------------------------------------------
  // Run execution
  // -------------------------------------------------------------------------

  async function executeRun(runId: string, plan: Plan): Promise<void> {
    const profile = await requireProfile(plan.profileId);
    const createdAt = now().toISOString();
    let machine: RunMachineState = initialRunMachineState();
    let startedAt: string | null = null;

    // Cooperative cancellation: fires only where this closure is actually
    // called, which is between this run's own coarse phases (before/after
    // capture, before promotion) -- never inside `runCapture` or
    // `documentBundle` themselves, neither of which accepts a cancellation
    // signal today. That gap is disclosed in this task's final report.
    // REQUEST_CANCEL first folds cancelRun's out-of-band flag into the
    // machine itself, then CHECKPOINT is where the "cooperative" part
    // actually happens: it only moves the run to `cancelled` if that flag
    // is set.
    const checkpoint = async (): Promise<boolean> => {
      if (cancellationRequested.get(runId) ?? false) {
        machine = transition(machine, { type: 'REQUEST_CANCEL' });
      }
      const before = machine.runState;
      machine = transition(machine, { type: 'CHECKPOINT' });
      if (machine.runState === before) return false;
      await persist(runId, plan, profile, machine.runState, {
        createdAt,
        startedAt,
        finishedAt: now().toISOString(),
      });
      return true;
    };

    try {
      machine = transition(machine, { type: 'ENQUEUE' });
      startedAt = now().toISOString();
      await persist(runId, plan, profile, machine.runState, {
        createdAt,
        startedAt,
        finishedAt: null,
      });

      if (await checkpoint()) return;

      machine = transition(machine, { type: 'BEGIN_EXTRACTING' });
      await persist(runId, plan, profile, machine.runState, {
        createdAt,
        startedAt,
        finishedAt: null,
      });

      const provider = await deps.providerFor(plan.profileId);
      const organizationId = asOrganizationId(profile.expectedOrganizationId);
      const captureScope: CaptureScope = { kind: 'flows', flowIds: plan.selectedFlowIds };
      const captureResult = await runCapture({
        root: profile.outputRoot,
        runId,
        planHash: plan.planHash,
        organizationId,
        expectedOrganizationId: organizationId,
        provider,
        mode: 'context',
        scope: captureScope,
        now,
      });

      if (captureResult.state === 'failed' || captureResult.bundleDir === undefined) {
        machine = transition(machine, { type: 'FAIL' });
        await persist(runId, plan, profile, machine.runState, {
          createdAt,
          startedAt,
          finishedAt: now().toISOString(),
          errors: captureResult.errors,
          warnings: captureResult.warnings,
        });
        return;
      }
      const captureWarnings = captureResult.warnings;
      const bundleDir = captureResult.bundleDir;

      if (await checkpoint()) return;

      // documentBundleToDisk performs normalize/analyze/render/write/promote
      // as one call (it composes document-bundle.ts's own normalize/
      // analyze/render pass with the atomic write path) -- it reports no
      // intermediate phase of its own, so the states below are persisted in
      // immediate succession rather than genuinely tracked mid-flight. This
      // is a reporting-granularity limitation, disclosed in this task's
      // final report, not a claim that each phase is separately observable
      // today.
      machine = transition(machine, { type: 'BEGIN_NORMALIZING' });
      await persist(runId, plan, profile, machine.runState, {
        createdAt,
        startedAt,
        finishedAt: null,
      });
      machine = transition(machine, { type: 'BEGIN_ANALYZING' });
      await persist(runId, plan, profile, machine.runState, {
        createdAt,
        startedAt,
        finishedAt: null,
      });
      machine = transition(machine, { type: 'BEGIN_RENDERING' });
      await persist(runId, plan, profile, machine.runState, {
        createdAt,
        startedAt,
        finishedAt: null,
      });

      if (await checkpoint()) return;

      machine = transition(machine, { type: 'BEGIN_VALIDATING' });
      await persist(runId, plan, profile, machine.runState, {
        createdAt,
        startedAt,
        finishedAt: null,
      });

      if (await checkpoint()) return;

      machine = transition(machine, { type: 'BEGIN_PROMOTING' });
      await persist(runId, plan, profile, machine.runState, {
        createdAt,
        startedAt,
        finishedAt: null,
      });

      const diskResult = await documentBundleToDisk({
        bundleDir,
        outputRoot: profile.outputRoot,
        generatedAt: now().toISOString(),
      });

      const skippedIssues: RunManifestIssue[] = diskResult.skipped.map((s) => ({
        code: 'FLOW_NOT_DOCUMENTED',
        category: 'source',
        message: `Flow "${s.flowId}" version "${s.versionId}" could not be documented: ${s.reason}`,
        retryable: false,
        flowId: s.flowId,
      }));

      const artifacts: RunManifestArtifact[] = [
        {
          kind: 'document-set',
          uri: diskResult.outputDir,
          hash: diskResult.contentHash,
          classification: 'confidential',
        },
      ];
      if (captureResult.contentHash !== undefined) {
        artifacts.push({
          kind: 'capture-bundle',
          uri: bundleDir,
          hash: captureResult.contentHash,
          classification: 'restricted',
        });
      }

      const finished = captureWarnings.length > 0 || skippedIssues.length > 0;
      machine = transition(machine, { type: finished ? 'COMPLETE_WITH_WARNINGS' : 'COMPLETE' });
      await persist(runId, plan, profile, machine.runState, {
        createdAt,
        startedAt,
        finishedAt: now().toISOString(),
        progress: {
          total: plan.selectedFlowIds.length,
          queued: 0,
          running: 0,
          completed: diskResult.documentsWritten,
          skipped: diskResult.skipped.length,
          failed: 0,
        },
        warnings: [...captureWarnings, ...skippedIssues],
        artifacts,
      });
    } catch {
      // Never promote past this point, and never claim more than "a run
      // failed": the previous documents directory (if any) was never
      // touched by this branch, satisfying "a failed run leaves previous
      // documentation intact".
      //
      // This persist is itself wrapped, because it can fail too -- a run whose
      // output root has gone away fails here exactly as it failed above. An
      // escaping rejection would leave the manifest at its last non-terminal
      // state forever, and `getRun` would report a dead run as still
      // extracting while an MCP client polled it indefinitely. Recording
      // "failed" is the whole job of this branch; if even that cannot be
      // written, the filesystem is gone and there is nothing honest left to do.
      if (!isTerminalRunState(machine.runState)) machine = transition(machine, { type: 'FAIL' });
      try {
        await persist(runId, plan, profile, machine.runState, {
          createdAt,
          startedAt,
          finishedAt: now().toISOString(),
          errors: [
            {
              code: 'RUN_FAILED',
              category: 'run',
              message: 'The documentation run did not complete.',
              retryable: true,
            },
          ],
        });
      } catch {
        // Deliberately swallowed. See above.
      }
    } finally {
      cancellationRequested.delete(runId);
    }
  }

  // -------------------------------------------------------------------------
  // The port
  // -------------------------------------------------------------------------

  return {
    async listProfiles(): Promise<readonly ProfileSummary[]> {
      const { profiles } = await deps.profileStore.list();
      const summaries: ProfileSummary[] = [];
      for (const profile of profiles) {
        const profileId = asProfileId(profile.profileId);
        let secretStoreStatus: ProfileSummary['secretStoreStatus'] = 'unknown';
        try {
          secretStoreStatus = (await deps.secretStore.has(profileId)) ? 'available' : 'missing';
        } catch {
          secretStoreStatus = 'unknown';
        }
        const safe = toSafeProfileSummary(profile, secretStoreStatus === 'available');
        summaries.push({
          profileId,
          displayName: safe.displayName,
          expectedOrganizationId: asOrganizationId(profile.expectedOrganizationId),
          region: safe.region,
          outputRoot: safe.outputRoot,
          secretStoreStatus,
          lastValidatedAt: safe.lastValidatedAt,
        });
      }
      return summaries;
    },

    async checkConnection(profileId): Promise<ConnectionCheckResult> {
      const checkedAt = now().toISOString();
      const profile = await deps.profileStore.get(profileId);
      if (profile === null) {
        return {
          reachable: false,
          organizationId: null,
          organizationName: null,
          region: null,
          sourceAdapterAvailable: false,
          missingPermissionCategories: [],
          checkedAt,
        };
      }

      let provider: GenesysSourceProvider;
      try {
        provider = await deps.providerFor(profileId);
      } catch {
        return {
          reachable: false,
          organizationId: null,
          organizationName: null,
          region: null,
          sourceAdapterAvailable: false,
          missingPermissionCategories: [],
          checkedAt,
        };
      }

      try {
        const identity = await provider.validateConnection();
        return {
          reachable: true,
          organizationId: identity.organizationId,
          organizationName: identity.organizationName,
          region: identity.region,
          sourceAdapterAvailable: true,
          // GenesysSourceProvider (packages/domain/src/source-provider.ts)
          // has no method reporting missing permission categories today --
          // the S4 permission-matrix spike (CLAUDE.md's Status section) has
          // not run. Always empty until the interface grows one; never
          // fabricated from a partial success.
          missingPermissionCategories: [],
          checkedAt,
        };
      } catch {
        return {
          reachable: false,
          organizationId: null,
          organizationName: null,
          region: null,
          sourceAdapterAvailable: true,
          missingPermissionCategories: [],
          checkedAt,
        };
      }
    },

    async listFlows(profileId, query: FlowListQuery): Promise<FlowListPage> {
      const provider = await deps.providerFor(profileId);
      const flowTypes = query.flowType !== undefined ? [query.flowType] : undefined;
      const discovered = [];
      for await (const flow of provider.listFlows(flowTypes !== undefined ? { flowTypes } : {})) {
        discovered.push(flow);
      }

      let filtered = discovered;
      if (query.divisionId !== undefined) {
        filtered = filtered.filter((f) => f.divisionId === query.divisionId);
      }
      if (query.nameQuery !== undefined) {
        const needle = query.nameQuery.toLowerCase();
        filtered = filtered.filter((f) => f.name.toLowerCase().includes(needle));
      }
      if (query.publicationState !== undefined) {
        filtered = filtered.filter((f) => toPublicationState(f) === query.publicationState);
      }
      // query.changedSince is not enforced: GenesysSourceProvider's
      // FlowDescriptor carries no last-modified timestamp, so this filter
      // cannot be honored without fabricating one. Returning every match
      // rather than silently guessing is the honest choice; see this task's
      // final report.

      const pageSize =
        query.pageSize !== undefined && query.pageSize > 0 ? query.pageSize : filtered.length || 1;
      const requestedOffset =
        query.pageToken !== undefined ? Number.parseInt(query.pageToken, 10) : 0;
      const start = Number.isFinite(requestedOffset) && requestedOffset > 0 ? requestedOffset : 0;
      const page = filtered.slice(start, start + pageSize);

      const items: PortFlowDescriptor[] = page.map((f) => ({
        flowId: f.flowId,
        name: f.name,
        type: f.type,
        divisionId: f.divisionId,
        publicationState: toPublicationState(f),
        lastModifiedAt: null,
        latestVersion: null,
        publishedVersion: f.publishedVersion,
      }));
      const nextOffset = start + pageSize;
      const nextPageToken = nextOffset < filtered.length ? String(nextOffset) : null;

      return { items, nextPageToken, totalKnown: filtered.length };
    },

    async inspectFlow(profileId, flowId: FlowId, version): Promise<FlowInspection> {
      const profile = await requireProfile(profileId);
      const provider = await deps.providerFor(profileId);
      const source = await provider.loadFlowSource({
        flowId,
        versionId: version !== undefined ? asFlowVersionId(version) : null,
      });
      const config = parseDefinition(source.format, source.body);

      const snapshot = normalizeFlow({
        config,
        source: {
          provider: 'platform-api',
          adapterVersion: 'archivist-port-0.1.0',
          extractedAt: now().toISOString(),
          region: profile.region,
          organizationId: profile.expectedOrganizationId,
          trackingIdsAvailable: true,
          redactionApplied: true,
        },
        flow: {
          // No separate display name is available from loadFlowSource alone
          // (RawFlowSource carries no `name` field); the flow id is used as
          // an honest fallback rather than a fabricated one, matching
          // document-bundle.ts's identical choice for the same reason.
          id: flowId,
          name: flowId,
          type: 'unknown',
          secure: false,
          version: { selected: String(source.versionId), state: 'published' },
        },
      });
      const analysis = analyzeFlow(snapshot);

      const dependencyCounts: Record<string, number> = {};
      for (const dependency of snapshot.dependencies) {
        dependencyCounts[dependency.type] = (dependencyCounts[dependency.type] ?? 0) + 1;
      }

      const mainPaths = analysis.journeys
        .slice(0, 10)
        .map((journey) => `${journey.steps.join(' -> ')} (${journey.terminalKind})`);

      const warnings = [
        ...snapshot.warnings.map((w) => w.message),
        ...analysis.findings
          .filter(
            (f) => f.severity === 'warning' || f.severity === 'error' || f.severity === 'critical',
          )
          .map((f) => f.message),
      ].slice(0, 50);

      const orgId = profile.expectedOrganizationId;
      const versionId = String(source.versionId);
      const resourceUris = [
        flowResourceUri('snapshot', orgId, flowId, versionId),
        flowResourceUri('evidence', orgId, flowId, versionId),
        flowResourceUri('business', orgId, flowId, versionId),
        flowResourceUri('technical', orgId, flowId, versionId),
      ];

      return {
        flowId,
        versionId: source.versionId,
        name: flowId,
        type: 'unknown',
        graphCounts: { nodes: snapshot.graph.nodes.length, edges: snapshot.graph.edges.length },
        mainPaths,
        dependencyCounts,
        warnings,
        resourceUris,
      };
    },

    async createPlan(input: PlanInput): Promise<PlanResult> {
      await requireProfile(input.profileId);
      const provider = await deps.providerFor(input.profileId);
      const candidates = await discoverCandidates(provider, input.scope);
      const result = createPlanUseCase(input, {
        now,
        generateId,
        // The MCP-facing plan/run pipeline is always context mode: docs/03's
        // tools describe a documentation workflow, and migration mode has no
        // MCP-facing trigger today (see plan.ts's CreatePlanDeps doc
        // comment and ADR-018).
        mode: 'context',
        candidates,
      });
      if (result.kind === 'plan') planCache.set(result.planId, result);
      return result;
    },

    async startRun(planId, planHash): Promise<RunStatus> {
      const plan = planCache.get(planId);
      if (plan === undefined) {
        throw new PlanRejectedError(
          'PLAN_NOT_FOUND',
          'No stored plan matches the supplied planId.',
        );
      }
      const verification = verifyPlan(plan, planId, planHash, now());
      if (!verification.ok) {
        throw new PlanRejectedError(verification.reason, verification.message);
      }

      const existingRunId = runIdByPlanId.get(planId);
      if (existingRunId !== undefined) {
        // Starting the same valid plan twice returns the existing run's
        // current status rather than creating a second run -- this port
        // owns that dedup because it is the only thing with a durable view
        // of runs across calls (see ArchivistPort.startRun's doc comment).
        const loaded = await runStore.load(existingRunId);
        if (loaded.status === 'found') return toRunStatus(loaded.manifest);
      }

      const runId = generateRunId();
      runIdByPlanId.set(planId, runId);
      cancellationRequested.set(runId, false);

      const profile = await requireProfile(plan.profileId);
      const createdAt = now().toISOString();
      const manifest = await persist(runId, plan, profile, 'planned', {
        createdAt,
        startedAt: null,
        finishedAt: null,
      });

      // Fire-and-forget: docs/03 requires startRun to "return a runId
      // immediately" while "the run continues after this call returns".
      // executeRun's own try/catch always ends in a persisted terminal
      // manifest, but "always" is doing real work there and this is the one
      // call site that cannot observe a failure. The explicit .catch() is the
      // backstop: an unhandled rejection here would take down the host process
      // in a strict Node runtime, and killing an MCP server because one run
      // failed is a far worse outcome than the failed run itself.
      void executeRun(runId, plan).catch(() => undefined);

      return toRunStatus(manifest);
    },

    async getRun(runId): Promise<RunStatus> {
      const result = await loadRunOrThrow(runId);
      return toRunStatus(result.manifest);
    },

    async cancelRun(runId): Promise<RunStatus> {
      const result = await loadRunOrThrow(runId);

      // Cancelling an already-terminal run is a no-op that succeeds: report
      // its current (unchanged) status rather than erroring or mutating it.
      if (isTerminalRunState(result.manifest.state as RunState)) {
        return toRunStatus(result.manifest);
      }

      cancellationRequested.set(runId, true);
      // The persisted state itself does not change here -- cancellation is
      // cooperative and only takes effect at executeRun's next checkpoint.
      // This call reports the run's current status, with the request now
      // recorded for that checkpoint to observe.
      return toRunStatus(result.manifest);
    },

    diffFlow: deps.diffFlow,

    async readResource(locator: ResourceLocator): Promise<ResourceDocument | null> {
      if ('runId' in locator) {
        const result = await runStore.load(locator.runId);
        if (result.status !== 'found') return null;
        const manifest = result.manifest;
        if (locator.kind === 'run-errors') {
          return {
            mimeType: 'application/json',
            text: `${JSON.stringify(manifest.errors, null, 2)}\n`,
          };
        }
        const report = {
          runId: manifest.runId,
          planId: manifest.planId,
          state: manifest.state,
          progress: manifest.progress,
          warnings: manifest.warnings,
          errors: manifest.errors,
          artifacts: manifest.artifacts,
        };
        return { mimeType: 'application/json', text: `${JSON.stringify(report, null, 2)}\n` };
      }

      const outputRoot = await outputRootForOrganization(locator.organizationId);
      if (outputRoot === null) return null;

      // The documents tree is keyed by a slug of the flow's display name plus
      // a short slice of its id -- readable for a human browsing it, which a
      // bare GUID is not. A locator carries only the id, so the directory has
      // to be found rather than reconstructed.
      //
      // Matching on the short id is what makes this unambiguous: the slug half
      // can repeat across flows that share a display name, the id half cannot.
      const shortId = safeSegment(locator.flowId).slice(0, 8);
      let ivrDir: string | null = null;
      try {
        const entries = await readdir(resolveWithinRoot(outputRoot, ['documents', 'ivrs']), {
          withFileTypes: true,
        });
        ivrDir =
          entries.find((entry) => entry.isDirectory() && entry.name.includes(shortId))?.name ??
          null;
      } catch {
        ivrDir = null;
      }
      if (ivrDir === null) return null;

      const base = ['documents', 'ivrs', safeSegment(ivrDir), safeSegment(locator.version)];
      const fileFor = {
        'flow-snapshot': 'flow-snapshot.json',
        'flow-business': 'business.md',
        'flow-technical': 'technical.md',
        'flow-evidence': 'flow-snapshot.json',
      } as const;
      const mimeFor = {
        'flow-snapshot': 'application/json',
        'flow-business': 'text/markdown',
        'flow-technical': 'text/markdown',
        'flow-evidence': 'application/json',
      } as const;

      let text: string;
      try {
        const path = resolveWithinRoot(outputRoot, [...base, fileFor[locator.kind]]);
        text = await readFile(path, 'utf8');
      } catch {
        return null;
      }

      if (locator.kind === 'flow-evidence') {
        try {
          const snapshot = JSON.parse(text) as { readonly evidence?: unknown };
          return {
            mimeType: mimeFor[locator.kind],
            text: `${JSON.stringify(snapshot.evidence ?? [], null, 2)}\n`,
          };
        } catch {
          return null;
        }
      }

      return { mimeType: mimeFor[locator.kind], text };
    },
  };
}
