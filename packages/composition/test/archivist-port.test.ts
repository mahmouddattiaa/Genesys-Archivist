// packages/composition/test/archivist-port.test.ts
//
// Drives the real ArchivistPort implementation end to end against
// FakeSourceProvider: plan, start, poll to completion, read a resource. Also
// covers the release-blocking properties AGENTS.md and this task's brief
// require: a cancelled run never touches previously promoted output, a
// tampered plan hash is rejected, and no secret or client ID ever appears
// in a port return value or a persisted run manifest.
//
// KNOWN FLAKE, roughly 1 run in 6 on Windows. Two tests here
// ("plans, starts, completes…" and "starting the same valid plan twice…")
// intermittently fail, either on a run that never reaches a terminal state or
// on ENOTEMPTY while the temp root is removed. Investigating it produced three
// real fixes already — a guarded catch-persist and a backstopped
// fire-and-forget in archivist-port.ts, a run drain in this file's afterEach,
// and the removal of a silent `?? '.'` run-store root — but the residue is not
// yet understood, and it is a test-lifecycle problem rather than a product
// defect: startRun is fire-and-forget by contract, and this file races its own
// teardown against work it deliberately started in the background.
//
// It is recorded rather than retried-away on purpose. A retry here would hide
// the one thing worth knowing: whether a run can ever get stuck non-terminal
// in production, which is what an MCP client would poll forever on.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  asFlowId,
  asOrganizationId,
  asProfileId,
  type FlowId,
  type ProfileId,
} from '@genesys-archivist/domain';
import type { ArchivistPort, FlowDiff, Plan, RunStatus } from '@genesys-archivist/application';
import type {
  ConnectionIdentity,
  DependencyRef,
  DependencyResolution,
  FlowDescriptor,
  FlowDiscoveryQuery,
  FlowVersionRef,
  GenesysSourceProvider,
  RawFlowSource,
} from '@genesys-archivist/domain';
import { FakeSourceProvider } from '@genesys-archivist/testing';
import type { ProfileMetadata, SecretStore } from '@genesys-archivist/security';
import type { ProfileListResult, ProfileStore } from '@genesys-archivist/storage';
import { createArchivistPort } from '../src/archivist-port.js';
// Vitest's default testTimeout is 5s, and none of these blocks overrode it.
// Every test in this file drives a real run: capture, normalize, document, and
// an atomic stage-and-promote against the filesystem. Alone that is ~300ms;
// under full-suite load on Windows it was measured at 5,025ms and failed as a
// timeout — which reads like "the run never reached a terminal state" and is
// actually a starved test process. Raising pollUntilTerminal's own budget
// alone would not have helped, because vitest killed the test first.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

// ---------------------------------------------------------------------------
// In-memory adapters, local to this test file (mirrors
// platform-provider-seam.test.ts's own InMemorySecretStore for the same
// reason: composition may not add a shared fake outside
// @genesys-archivist/testing, and adding one there is outside this task's
// file ownership).
// ---------------------------------------------------------------------------

class InMemoryProfileStore implements ProfileStore {
  readonly #profiles = new Map<string, ProfileMetadata>();

  seed(profile: ProfileMetadata): void {
    this.#profiles.set(profile.profileId, profile);
  }

  list(): Promise<ProfileListResult> {
    return Promise.resolve({ profiles: [...this.#profiles.values()], unreadable: [] });
  }
  get(profileId: string): Promise<ProfileMetadata | null> {
    return Promise.resolve(this.#profiles.get(profileId) ?? null);
  }
  put(profile: ProfileMetadata): Promise<void> {
    this.#profiles.set(profile.profileId, profile);
    return Promise.resolve();
  }
  remove(profileId: string): Promise<void> {
    this.#profiles.delete(profileId);
    return Promise.resolve();
  }
}

class InMemorySecretStore implements SecretStore {
  readonly #secrets = new Map<string, string>();
  set(profileId: ProfileId, secret: string): Promise<void> {
    this.#secrets.set(profileId, secret);
    return Promise.resolve();
  }
  get(profileId: ProfileId): Promise<string | null> {
    return Promise.resolve(this.#secrets.get(profileId) ?? null);
  }
  has(profileId: ProfileId): Promise<boolean> {
    return Promise.resolve(this.#secrets.has(profileId));
  }
  remove(profileId: ProfileId): Promise<boolean> {
    return Promise.resolve(this.#secrets.delete(profileId));
  }
}

/** Wraps a real `GenesysSourceProvider` so `loadFlowSource` blocks until the
 * test releases a gate -- the only way to deterministically catch a run
 * mid-flight (between capture and the document phase) without a flaky
 * artificial sleep. */
class GatedProvider implements GenesysSourceProvider {
  #gate: Promise<void> | null = null;

  constructor(private readonly inner: GenesysSourceProvider) {}

  gateLoadFlowSource(): () => void {
    let release!: () => void;
    this.#gate = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    return release;
  }

  validateConnection(): Promise<ConnectionIdentity> {
    return this.inner.validateConnection();
  }
  listFlows(query: FlowDiscoveryQuery): AsyncIterable<FlowDescriptor> {
    return this.inner.listFlows(query);
  }
  async loadFlowSource(ref: FlowVersionRef): Promise<RawFlowSource> {
    if (this.#gate !== null) await this.#gate;
    return this.inner.loadFlowSource(ref);
  }
  resolveDependencies(refs: readonly DependencyRef[]): Promise<readonly DependencyResolution[]> {
    return this.inner.resolveDependencies(refs);
  }
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const VALID_FLOW_YAML = [
  'name: Test Flow',
  'type: inboundcall',
  'flowSequenceItemList: []',
  'variables: []',
  '',
].join('\n');

const ORG_ID = asOrganizationId('org-test-1');
const PROFILE_ID = asProfileId('sandbox-test');
const REGION = 'eu-west-1';

const created: string[] = [];

async function freshOutputRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'archivist-port-'));
  created.push(dir);
  return dir;
}

beforeEach(() => {
  created.length = 0;
});

/**
 * Started runs, so teardown can wait for them.
 *
 * `startRun` is fire-and-forget by contract -- docs/03 requires it to return a
 * runId immediately while the run continues -- so a test that starts a run and
 * does not poll it to completion leaves a background run still writing into
 * the temp directory that `afterEach` is about to delete. On Windows that
 * surfaces as `ENOTEMPTY` from `rmdir` (files keep reappearing under the
 * recursive walk) and, in the following test, as "No run matches the supplied
 * runId" once the store's root has been pulled out from under it.
 *
 * Neither is a product defect. Both are this file failing to wait for work it
 * deliberately started in the background.
 */
const startedRuns: { readonly port: ArchivistPort; readonly runId: string }[] = [];

beforeEach(() => {
  startedRuns.length = 0;
});

afterEach(async () => {
  // Drain first: a run that is still writing will recreate whatever rm removes.
  await Promise.all(
    startedRuns
      .splice(0)
      .map(({ port, runId }) => pollUntilTerminal(port, runId).catch(() => undefined)),
  );
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface TestHarness {
  readonly port: ArchivistPort;
  readonly profileStore: InMemoryProfileStore;
  readonly secretStore: InMemorySecretStore;
  readonly provider: FakeSourceProvider;
  readonly outputRoot: string;
}

function fixedNow(): () => Date {
  return () => new Date('2026-08-20T12:00:00.000Z');
}

function makeCounter(prefix: string): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `${prefix}-${String(n)}`;
  };
}

async function buildHarness(options: {
  readonly outputRoot: string;
  readonly clientId?: string;
  readonly secret?: string;
}): Promise<TestHarness> {
  const profileStore = new InMemoryProfileStore();
  const secretStore = new InMemorySecretStore();
  profileStore.seed({
    profileId: PROFILE_ID,
    displayName: 'Test Sandbox',
    region: REGION,
    expectedOrganizationId: ORG_ID,
    clientId: options.clientId ?? 'not-a-secret-client-id',
    outputRoot: options.outputRoot,
    lastValidatedAt: null,
  });
  if (options.secret !== undefined) await secretStore.set(PROFILE_ID, options.secret);

  const provider = new FakeSourceProvider({ organizationId: ORG_ID, region: REGION });
  provider.seedFlow({
    flowId: asFlowId('flow-a'),
    name: 'Flow A',
    type: 'inboundcall',
    publishedVersion: '1',
    body: VALID_FLOW_YAML,
  });

  const diffFlow: ArchivistPort['diffFlow'] = (_profileId, flowId, fromVersion, toVersion) =>
    Promise.resolve<FlowDiff>({
      flowId,
      fromVersion,
      toVersion,
      addedNodes: [],
      removedNodes: [],
      changedNodes: [],
      addedVariables: [],
      removedVariables: [],
      dependencyChanges: [],
      promptChanges: [],
      materialJourneyChanges: [],
      detailResourceUri: null,
    });

  const port = createArchivistPort({
    profileStore,
    secretStore,
    providerFor: () => Promise.resolve(provider),
    diffFlow,
    outputRoot: options.outputRoot,
    now: fixedNow(),
    generateId: makeCounter('plan'),
    generateRunId: makeCounter('run'),
  });

  return { port, profileStore, secretStore, provider, outputRoot: options.outputRoot };
}

const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled', 'completed_with_warnings']);

/**
 * The budget is deliberately generous, and 10s was measured to be too small.
 *
 * A run here does a real capture, normalization, documentation, and an atomic
 * stage-and-promote against the filesystem. Alone that takes ~300ms; run
 * alongside the rest of the suite on Windows it was observed at 5s and timing
 * out at 10s, which surfaced as "the run reached no terminal state" — a
 * failure that reads like a correctness bug and is really a starved test
 * process. This repository has been bitten by the same shape twice before (the
 * lock probe and the Playwright renderer), and the answer both times was an
 * explicit, roomy budget rather than a retry.
 *
 * A real hang still fails, just later.
 */
async function pollUntilTerminal(
  port: ArchivistPort,
  runId: string,
  timeoutMs = 60_000,
): Promise<RunStatus> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await port.getRun(runId);
    if (TERMINAL_STATES.has(status.state)) return status;
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting for run "${runId}" to reach a terminal state (last: ${status.state}).`,
      );
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
}

async function planAndStart(
  port: ArchivistPort,
  flowId: FlowId,
): Promise<{ plan: Plan; status: RunStatus }> {
  const planResult = await port.createPlan({
    profileId: PROFILE_ID,
    scope: { kind: 'flows', flows: [{ flowId }] },
  });
  expect(planResult.kind).toBe('plan');
  const plan = planResult as Plan;
  const status = await port.startRun(plan.planId, plan.planHash);
  // Registered so afterEach drains it before deleting the temp root -- see the
  // comment on startedRuns. Every path that starts a run goes through here.
  startedRuns.push({ port, runId: status.runId });
  return { plan, status };
}

// ---------------------------------------------------------------------------
// End to end: plan, start, poll to completion, read a resource
// ---------------------------------------------------------------------------

describe('archivist-port: end to end against FakeSourceProvider', () => {
  it('plans, starts, completes, and produces a readable flow-technical resource', async () => {
    const outputRoot = await freshOutputRoot();
    const harness = await buildHarness({ outputRoot });
    const flowId = asFlowId('flow-a');

    const { plan, status } = await planAndStart(harness.port, flowId);
    expect(status.state).not.toBe('failed');

    const final = await pollUntilTerminal(harness.port, status.runId);
    expect(['completed', 'completed_with_warnings']).toContain(final.state);
    expect(final.finishedAt).not.toBeNull();

    const version = plan.targetVersions[flowId] ?? '1';
    const document = await harness.port.readResource({
      kind: 'flow-technical',
      organizationId: ORG_ID,
      flowId,
      version,
    });
    expect(document).not.toBeNull();
    expect(document?.mimeType).toBe('text/markdown');
    expect(document?.text.length ?? 0).toBeGreaterThan(0);

    // The run-report resource is always readable once the run exists.
    const report = await harness.port.readResource({ kind: 'run-report', runId: status.runId });
    expect(report).not.toBeNull();
    const parsed = JSON.parse(report?.text ?? '{}') as { runId: string };
    expect(parsed.runId).toBe(status.runId);
  });

  it('starting the same valid plan twice returns the same run rather than starting a second one', async () => {
    const outputRoot = await freshOutputRoot();
    const harness = await buildHarness({ outputRoot });
    const flowId = asFlowId('flow-a');

    const planResult = await harness.port.createPlan({
      profileId: PROFILE_ID,
      scope: { kind: 'flows', flows: [{ flowId }] },
    });
    const plan = planResult as Plan;
    const first = await harness.port.startRun(plan.planId, plan.planHash);
    const second = await harness.port.startRun(plan.planId, plan.planHash);
    expect(second.runId).toBe(first.runId);

    await pollUntilTerminal(harness.port, first.runId);
  });
});

// ---------------------------------------------------------------------------
// A tampered plan hash is rejected
// ---------------------------------------------------------------------------

describe('archivist-port: plan immutability', () => {
  it('rejects starting a plan with a tampered hash', async () => {
    const outputRoot = await freshOutputRoot();
    const harness = await buildHarness({ outputRoot });
    const flowId = asFlowId('flow-a');

    const planResult = await harness.port.createPlan({
      profileId: PROFILE_ID,
      scope: { kind: 'flows', flows: [{ flowId }] },
    });
    const plan = planResult as Plan;

    await expect(
      harness.port.startRun(plan.planId, 'sha256:0000000000tamperedvalue'),
    ).rejects.toMatchObject({
      code: 'PLAN_HASH_MISMATCH',
    });
  });

  it('rejects starting an unknown planId', async () => {
    const outputRoot = await freshOutputRoot();
    const harness = await buildHarness({ outputRoot });

    await expect(
      harness.port.startRun('plan-that-never-existed', 'sha256:anything'),
    ).rejects.toMatchObject({
      code: 'PLAN_NOT_FOUND',
    });
  });
});

// ---------------------------------------------------------------------------
// A cancelled run leaves previous output byte-identical
// ---------------------------------------------------------------------------

describe('archivist-port: cancellation never disturbs prior good output', () => {
  it('a run cancelled between capture and promotion leaves previously promoted documents untouched', async () => {
    const outputRoot = await freshOutputRoot();
    const harness = await buildHarness({ outputRoot });
    const flowId = asFlowId('flow-a');

    // Baseline: a full, successful run promotes flow-a's documents.
    const { status: firstStatus } = await planAndStart(harness.port, flowId);
    const firstFinal = await pollUntilTerminal(harness.port, firstStatus.runId);
    expect(['completed', 'completed_with_warnings']).toContain(firstFinal.state);

    const technicalPath = join(
      outputRoot,
      'documents',
      'ivrs',
      'test-flow-flow-a',
      '1',
      'technical.md',
    );
    const originalContent = await readFile(technicalPath, 'utf8');
    expect(originalContent.length).toBeGreaterThan(0);

    // Second run: a gated provider blocks inside capture, giving this test a
    // deterministic window to cancel before capture (and therefore the
    // document/promote phase) completes.
    const gated = new GatedProvider(harness.provider);
    const gatedPort = createArchivistPort({
      profileStore: harness.profileStore,
      secretStore: harness.secretStore,
      providerFor: () => Promise.resolve(gated),
      diffFlow: (_profileId, fId, fromVersion, toVersion) =>
        Promise.resolve<FlowDiff>({
          flowId: fId,
          fromVersion,
          toVersion,
          addedNodes: [],
          removedNodes: [],
          changedNodes: [],
          addedVariables: [],
          removedVariables: [],
          dependencyChanges: [],
          promptChanges: [],
          materialJourneyChanges: [],
          detailResourceUri: null,
        }),
      outputRoot,
      now: fixedNow(),
      generateId: makeCounter('plan2'),
      generateRunId: makeCounter('run2'),
    });

    const release = gated.gateLoadFlowSource();
    const planResult2 = await gatedPort.createPlan({
      profileId: PROFILE_ID,
      scope: { kind: 'flows', flows: [{ flowId }] },
    });
    const plan2 = planResult2 as Plan;
    const secondStatus = await gatedPort.startRun(plan2.planId, plan2.planHash);

    // The run is now blocked inside runCapture's loadFlowSource. Request
    // cancellation now, then release the gate so capture can finish and the
    // run reaches its next checkpoint (immediately after capture, before
    // documentBundle/promotion) and honors the request there.
    await gatedPort.cancelRun(secondStatus.runId);
    release();

    const secondFinal = await pollUntilTerminal(gatedPort, secondStatus.runId);
    expect(secondFinal.state).toBe('cancelled');

    const afterCancelContent = await readFile(technicalPath, 'utf8');
    expect(afterCancelContent).toBe(originalContent);
  });

  it('cancelling a run twice succeeds both times and never errors', async () => {
    const outputRoot = await freshOutputRoot();
    const harness = await buildHarness({ outputRoot });
    const flowId = asFlowId('flow-a');

    const { status } = await planAndStart(harness.port, flowId);
    await pollUntilTerminal(harness.port, status.runId);

    const first = await harness.port.cancelRun(status.runId);
    const second = await harness.port.cancelRun(status.runId);
    expect(first.state).toBe(second.state);
  });

  it('cancelling an unknown run is reported, not silently accepted', async () => {
    const outputRoot = await freshOutputRoot();
    const harness = await buildHarness({ outputRoot });
    await expect(harness.port.cancelRun('run-that-never-existed')).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Secret and credential hygiene
// ---------------------------------------------------------------------------

describe('archivist-port: never leaks a secret or a client ID', () => {
  it('listProfiles never emits the client ID', async () => {
    const outputRoot = await freshOutputRoot();
    const canaryClientId = 'CANARY-CLIENT-ID-4b7e';
    const harness = await buildHarness({ outputRoot, clientId: canaryClientId });

    const profiles = await harness.port.listProfiles();
    expect(JSON.stringify(profiles)).not.toContain(canaryClientId);
    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.profileId).toBe(PROFILE_ID);
  });

  it('a secret placed in the profile secret store appears in no port return value or run manifest', async () => {
    const outputRoot = await freshOutputRoot();
    const canarySecret = 'CANARY-SECRET-5c81aa';
    const harness = await buildHarness({ outputRoot, secret: canarySecret });
    const flowId = asFlowId('flow-a');

    const profiles = await harness.port.listProfiles();
    expect(JSON.stringify(profiles)).not.toContain(canarySecret);

    const { plan, status } = await planAndStart(harness.port, flowId);
    expect(JSON.stringify(plan)).not.toContain(canarySecret);
    expect(JSON.stringify(status)).not.toContain(canarySecret);

    const final = await pollUntilTerminal(harness.port, status.runId);
    expect(JSON.stringify(final)).not.toContain(canarySecret);

    const manifestPath = join(outputRoot, '.archivist', 'runs', status.runId, 'manifest.json');
    const manifestRaw = await readFile(manifestPath, 'utf8');
    expect(manifestRaw).not.toContain(canarySecret);
  });
});
