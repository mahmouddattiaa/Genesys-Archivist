// apps/mcp-server/test/fake-port.ts
//
// The fake `ArchivistPort` the whole test suite runs against -- the same
// pattern `packages/capture` used before its production Genesys adapter
// existed (see FakeSourceProvider): every tool, resource, and prompt in
// this package is proven against this fixture, and wave 2 swaps `wire.ts`
// for a real port without any test here changing shape.
//
// Every "backend" behavior a real port would own lives here: pagination
// over a `pageToken`, plan hashing and expiry, run idempotency keyed by
// planId+planHash, and cooperative cancellation. Tests seed data through the
// `seed*`/`set*`/`throwOn` methods below and never reach into private state.
import { createHash } from 'node:crypto';
import type { FlowId, ProfileId } from '@genesys-archivist/domain';
import { buildResourceUri } from '../src/resources.js';
import {
  PlanRejectedError,
  type ArchivistPort,
  type ConnectionCheckResult,
  type FlowDescriptor,
  type FlowDiff,
  type FlowInspection,
  type FlowListPage,
  type FlowListQuery,
  type Plan,
  type PlanInput,
  type PlanResult,
  type ProfileSummary,
  type ResourceDocument,
  type ResourceLocator,
  type RunError,
  type RunState,
  type RunStatus,
} from '../src/port.js';

export interface FakePortOptions {
  readonly now?: () => Date;
  readonly policyMax?: number;
  readonly planTtlMs?: number;
}

function resourceKey(locator: ResourceLocator): string {
  return buildResourceUri(locator);
}

function hashPlan(input: {
  readonly profileId: string;
  readonly flowIds: readonly string[];
  readonly targetVersions: Readonly<Record<string, string>>;
}): string {
  const canonical = JSON.stringify({
    profileId: input.profileId,
    flowIds: [...input.flowIds].sort(),
    targetVersions: input.targetVersions,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

const TERMINAL_STATES: readonly RunState[] = [
  'completed',
  'failed',
  'cancelled',
  'completed_with_warnings',
];

export class FakeArchivistPort implements ArchivistPort {
  readonly #now: () => Date;
  readonly #policyMax: number;
  readonly #planTtlMs: number;

  readonly #profiles: ProfileSummary[] = [];
  readonly #connectionResults = new Map<string, ConnectionCheckResult>();
  readonly #flowList: FlowDescriptor[] = [];
  readonly #inspections = new Map<string, FlowInspection>();
  readonly #plans = new Map<string, Plan>();
  readonly #runs = new Map<string, RunStatus>();
  readonly #runsByIdempotencyKey = new Map<string, string>();
  readonly #diffs = new Map<string, FlowDiff>();
  readonly #resources = new Map<string, ResourceDocument>();
  readonly #throwOn = new Map<keyof ArchivistPort, Error>();

  #planCounter = 0;
  #runCounter = 0;

  constructor(options: FakePortOptions = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#policyMax = options.policyMax ?? 25;
    this.#planTtlMs = options.planTtlMs ?? 15 * 60 * 1000;
  }

  // -- seeding -------------------------------------------------------------

  seedProfile(profile: ProfileSummary): void {
    this.#profiles.push(profile);
  }

  setConnectionResult(profileId: string, result: ConnectionCheckResult): void {
    this.#connectionResults.set(profileId, result);
  }

  seedFlow(descriptor: FlowDescriptor): void {
    this.#flowList.push(descriptor);
  }

  seedFlows(descriptors: readonly FlowDescriptor[]): void {
    this.#flowList.push(...descriptors);
  }

  setInspection(flowId: string, inspection: FlowInspection): void {
    this.#inspections.set(flowId, inspection);
  }

  setDiff(flowId: string, fromVersion: string, toVersion: string, diff: FlowDiff): void {
    this.#diffs.set(`${flowId}:${fromVersion}:${toVersion}`, diff);
  }

  setResource(locator: ResourceLocator, document: ResourceDocument): void {
    this.#resources.set(resourceKey(locator), document);
  }

  /** Forces the named operation to throw `error` on its next call (and every
   * call after, until cleared) -- used to prove a raw, hostile, or
   * canary-carrying exception never survives `runTool`'s translation into a
   * safe envelope. */
  throwOn(operation: keyof ArchivistPort, error: Error): void {
    this.#throwOn.set(operation, error);
  }

  clearThrow(operation: keyof ArchivistPort): void {
    this.#throwOn.delete(operation);
  }

  /** Directly reads back a run's current state, bypassing the port
   * interface -- lets a test assert internal consistency (e.g. cancelling
   * twice) without a second `getRun` round trip changing anything. */
  peekRun(runId: string): RunStatus | undefined {
    return this.#runs.get(runId);
  }

  /** Test-only: forces a run into a given state, simulating a background
   * worker having advanced it past `queued` -- e.g. to `completed`, so a
   * test can prove cancelling an already-finished run is a safe no-op
   * rather than clobbering it back to `cancelled`. */
  setRunState(runId: string, state: RunState): void {
    const existing = this.#runs.get(runId);
    if (existing === undefined) throw new Error('setRunState: no such run in this fixture.');
    this.#runs.set(runId, { ...existing, state, updatedAt: this.#now().toISOString() });
  }

  // -- ArchivistPort ---------------------------------------------------------

  listProfiles(): Promise<readonly ProfileSummary[]> {
    this.#maybeThrow('listProfiles');
    return Promise.resolve([...this.#profiles]);
  }

  checkConnection(profileId: ProfileId): Promise<ConnectionCheckResult> {
    this.#maybeThrow('checkConnection');
    const result = this.#connectionResults.get(String(profileId));
    if (result === undefined) {
      return Promise.resolve({
        reachable: false,
        organizationId: null,
        organizationName: null,
        region: null,
        sourceAdapterAvailable: false,
        missingPermissionCategories: [],
        checkedAt: this.#now().toISOString(),
      });
    }
    return Promise.resolve(result);
  }

  listFlows(_profileId: ProfileId, query: FlowListQuery): Promise<FlowListPage> {
    this.#maybeThrow('listFlows');
    let items = this.#flowList;
    if (query.flowType !== undefined) items = items.filter((f) => f.type === query.flowType);
    if (query.divisionId !== undefined) {
      items = items.filter((f) => f.divisionId === query.divisionId);
    }
    if (query.nameQuery !== undefined) {
      const needle = query.nameQuery.toLowerCase();
      items = items.filter((f) => f.name.toLowerCase().includes(needle));
    }
    if (query.publicationState !== undefined) {
      items = items.filter((f) => f.publicationState === query.publicationState);
    }

    const offset = query.pageToken !== undefined ? decodePortPageToken(query.pageToken) : 0;
    const pageSize = query.pageSize ?? 50;
    const page = items.slice(offset, offset + pageSize);
    const nextOffset = offset + pageSize;
    const nextPageToken = nextOffset < items.length ? encodePortPageToken(nextOffset) : null;

    return Promise.resolve({ items: page, nextPageToken, totalKnown: items.length });
  }

  inspectFlow(_profileId: ProfileId, flowId: FlowId, _version?: string): Promise<FlowInspection> {
    this.#maybeThrow('inspectFlow');
    const inspection = this.#inspections.get(String(flowId));
    if (inspection === undefined) {
      return Promise.reject(new Error('No inspection seeded for this flow.'));
    }
    return Promise.resolve(inspection);
  }

  createPlan(input: PlanInput): Promise<PlanResult> {
    this.#maybeThrow('createPlan');
    let flowIds: readonly FlowId[];

    if (input.scope.kind === 'flows') {
      flowIds = input.scope.flows.map((f) => f.flowId);
    } else {
      const flowTypes = input.scope.flowTypes;
      const candidateIds = this.#flowList
        .filter((f) => flowTypes === undefined || flowTypes.includes(f.type))
        .map((f) => f.flowId);
      if (
        candidateIds.length > this.#policyMax &&
        (input.confirmedMax === undefined || input.confirmedMax < candidateIds.length)
      ) {
        const preview: PlanResult = {
          kind: 'preview',
          reason: 'Organization-wide selection exceeds the policy maximum.',
          candidateCount: candidateIds.length,
          policyMax: this.#policyMax,
        };
        return Promise.resolve(preview);
      }
      flowIds = candidateIds;
    }

    const now = this.#now();
    this.#planCounter += 1;
    const planId = `plan_${String(this.#planCounter)}`;
    const targetVersions = Object.fromEntries(flowIds.map((id) => [String(id), 'latest']));
    const planHash = hashPlan({
      profileId: String(input.profileId),
      flowIds: flowIds.map(String),
      targetVersions,
    });

    const plan: Plan = {
      kind: 'plan',
      planId,
      planHash,
      profileId: input.profileId,
      selectedFlowIds: flowIds,
      targetVersions,
      changedCount: flowIds.length,
      unchangedCount: 0,
      expectedOutputPaths: flowIds.map((id) => `flows/${String(id)}/`),
      estimatedWorkUnits: flowIds.length,
      warnings: [],
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.#planTtlMs).toISOString(),
    };
    this.#plans.set(planId, plan);
    return Promise.resolve(plan);
  }

  startRun(planId: string, planHash: string): Promise<RunStatus> {
    this.#maybeThrow('startRun');
    const plan = this.#plans.get(planId);
    if (plan === undefined) {
      return Promise.reject(
        new PlanRejectedError('PLAN_NOT_FOUND', 'No plan exists with this ID.'),
      );
    }
    if (plan.planHash !== planHash) {
      return Promise.reject(
        new PlanRejectedError(
          'PLAN_HASH_MISMATCH',
          'The plan hash does not match the stored plan.',
        ),
      );
    }
    if (new Date(plan.expiresAt).getTime() <= this.#now().getTime()) {
      return Promise.reject(new PlanRejectedError('PLAN_EXPIRED', 'The plan has expired.'));
    }

    const idempotencyKey = `${planId}:${planHash}`;
    const existingRunId = this.#runsByIdempotencyKey.get(idempotencyKey);
    if (existingRunId !== undefined) {
      const existing = this.#runs.get(existingRunId);
      if (existing !== undefined) return Promise.resolve(existing);
    }

    this.#runCounter += 1;
    const runId = `run_${String(this.#runCounter)}`;
    const now = this.#now().toISOString();
    const status: RunStatus = {
      runId,
      planId,
      state: 'queued',
      perFlowCounts: {},
      errors: [],
      warnings: [],
      startedAt: now,
      updatedAt: now,
      finishedAt: null,
      resourceUris: [
        buildResourceUri({ kind: 'run-report', runId }),
        buildResourceUri({ kind: 'run-errors', runId }),
      ],
    };
    this.#runs.set(runId, status);
    this.#runsByIdempotencyKey.set(idempotencyKey, runId);
    return Promise.resolve(status);
  }

  getRun(runId: string): Promise<RunStatus> {
    this.#maybeThrow('getRun');
    const status = this.#runs.get(runId);
    if (status === undefined) return Promise.reject(new Error('No run exists with this ID.'));
    return Promise.resolve(status);
  }

  cancelRun(runId: string): Promise<RunStatus> {
    this.#maybeThrow('cancelRun');
    const existing = this.#runs.get(runId);
    if (existing === undefined) return Promise.reject(new Error('No run exists with this ID.'));
    if (TERMINAL_STATES.includes(existing.state)) return Promise.resolve(existing);

    const updated: RunStatus = {
      ...existing,
      state: 'cancelled',
      finishedAt: this.#now().toISOString(),
      updatedAt: this.#now().toISOString(),
    };
    this.#runs.set(runId, updated);
    return Promise.resolve(updated);
  }

  diffFlow(
    _profileId: ProfileId,
    flowId: FlowId,
    fromVersion: string,
    toVersion: string,
  ): Promise<FlowDiff> {
    this.#maybeThrow('diffFlow');
    const diff = this.#diffs.get(`${String(flowId)}:${fromVersion}:${toVersion}`);
    if (diff === undefined) return Promise.reject(new Error('No diff seeded for this pair.'));
    return Promise.resolve(diff);
  }

  readResource(locator: ResourceLocator): Promise<ResourceDocument | null> {
    this.#maybeThrow('readResource');
    return Promise.resolve(this.#resources.get(resourceKey(locator)) ?? null);
  }

  // -- internals -------------------------------------------------------------

  #maybeThrow(operation: keyof ArchivistPort): void {
    const error = this.#throwOn.get(operation);
    if (error !== undefined) throw error;
  }
}

/** A dummy, unhelpful run error, useful as filler when a test only cares
 * about the error *count*, not content. */
export function fillerRunError(index: number): RunError {
  return { code: 'FILLER', message: `Filler error ${String(index)}` };
}

function encodePortPageToken(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64url');
}

function decodePortPageToken(token: string): number {
  const parsed = Number(Buffer.from(token, 'base64url').toString('utf8'));
  return Number.isFinite(parsed) ? parsed : 0;
}
