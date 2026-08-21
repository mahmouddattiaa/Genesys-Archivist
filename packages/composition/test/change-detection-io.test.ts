// packages/composition/test/change-detection-io.test.ts
//
// Drives `planIncrementalCapture` and `runIncrementalCapture` against
// `FakeSourceProvider`, in the same style as document-bundle-to-disk.test.ts
// and diff-flow.test.ts: real filesystem I/O against a temp directory, no
// network. Every scenario below runs the real function twice -- once to
// build a "previous run", once to observe how the second run reacts to it --
// because the module under test has no meaning against a single run alone.
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  asFlowId,
  asOrganizationId,
  asResourceId,
  type ConnectionIdentity,
  type DependencyRef,
  type DependencyResolution,
  type FlowDescriptor,
  type FlowDiscoveryQuery,
  type FlowVersionRef,
  type GenesysSourceProvider,
  type RawFlowSource,
} from '@genesys-archivist/domain';
import { FakeSourceProvider } from '@genesys-archivist/testing';
import { planIncrementalCapture, runIncrementalCapture } from '../src/change-detection-io.js';

const ORG_ID = asOrganizationId('org_test');
const CANARY = 'CANARY-TENANT-TEXT-6f21';

const created: string[] = [];

async function freshDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'archivist-change-detection-'));
  created.push(dir);
  return dir;
}

beforeEach(() => {
  created.length = 0;
});

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Wraps a `FakeSourceProvider` and counts `loadFlowSource` calls per flow
 * id, so a test can assert a carried-forward flow's body was never re-fetched
 * rather than merely observing identical bytes (which a re-fetch of
 * unchanged content would also produce). */
class CountingProvider implements GenesysSourceProvider {
  readonly loadCalls = new Map<string, number>();

  constructor(private readonly inner: FakeSourceProvider) {}

  validateConnection(): Promise<ConnectionIdentity> {
    return this.inner.validateConnection();
  }

  listFlows(query: FlowDiscoveryQuery): AsyncIterable<FlowDescriptor> {
    return this.inner.listFlows(query);
  }

  loadFlowSource(ref: FlowVersionRef): Promise<RawFlowSource> {
    this.loadCalls.set(ref.flowId, (this.loadCalls.get(ref.flowId) ?? 0) + 1);
    return this.inner.loadFlowSource(ref);
  }

  resolveDependencies(refs: readonly DependencyRef[]): Promise<readonly DependencyResolution[]> {
    return this.inner.resolveDependencies(refs);
  }
}

function makeProvider(): FakeSourceProvider {
  return new FakeSourceProvider({ organizationId: ORG_ID, region: 'euw1' });
}

function runOptions(root: string, runId: string, provider: GenesysSourceProvider) {
  return {
    root,
    runId,
    planHash: 'a'.repeat(16),
    organizationId: ORG_ID,
    expectedOrganizationId: ORG_ID,
    provider,
    now: () => new Date('2026-08-21T10:00:00Z'),
  };
}

async function flowIdsInBundle(root: string): Promise<string[]> {
  try {
    const entries = await readdir(join(root, 'bundle', 'flows'), { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

async function readFlowDefinition(root: string, flowId: string, versionId = '1'): Promise<string> {
  return readFile(
    join(root, 'bundle', 'flows', flowId, 'versions', versionId, 'definition.yaml'),
    'utf8',
  );
}

describe('planIncrementalCapture', () => {
  it('with no previous bundle, everything is captured (first run)', async () => {
    const provider = makeProvider();
    provider.seedFlow({ flowId: asFlowId('flow-a'), name: 'Flow A', type: 'inboundcall' });
    provider.seedFlow({ flowId: asFlowId('flow-b'), name: 'Flow B', type: 'inboundcall' });

    const plan = await planIncrementalCapture({ previousBundleDir: null, provider });

    expect(plan.toCapture.map((f) => f.flowId).sort()).toEqual(['flow-a', 'flow-b']);
    expect(plan.toCapture.every((f) => f.isNew)).toBe(true);
    expect(plan.toSkip).toEqual([]);
    expect(plan.retireCandidates).toEqual([]);
    expect(plan.inaccessible).toEqual([]);
  });

  it('is deterministic: the same inputs produce the same plan', async () => {
    const provider = makeProvider();
    provider.seedFlow({ flowId: asFlowId('flow-a'), name: 'Flow A', type: 'inboundcall' });
    provider.seedFlow({ flowId: asFlowId('flow-b'), name: 'Flow B', type: 'inboundcall' });

    const first = await planIncrementalCapture({ previousBundleDir: null, provider });
    const second = await planIncrementalCapture({ previousBundleDir: null, provider });

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('never lets a tenant-authored flow name reach the plan', async () => {
    const provider = makeProvider();
    provider.seedFlow({ flowId: asFlowId('flow-a'), name: CANARY, type: 'inboundcall' });

    const plan = await planIncrementalCapture({ previousBundleDir: null, provider });

    expect(JSON.stringify(plan)).not.toContain(CANARY);
  });
});

describe('runIncrementalCapture: change classification', () => {
  it('an unchanged flow is skipped and its definition is carried forward, without refetching it', async () => {
    const root = await freshDir();
    const provider1 = makeProvider();
    provider1.seedFlow({
      flowId: asFlowId('flow-a'),
      name: 'Flow A',
      type: 'inboundcall',
      body: 'v1\n',
    });
    const counting1 = new CountingProvider(provider1);
    await runIncrementalCapture(runOptions(root, 'run-1', counting1));
    expect(counting1.loadCalls.get('flow-a')).toBe(1);

    const provider2 = makeProvider();
    provider2.seedFlow({
      flowId: asFlowId('flow-a'),
      name: 'Flow A',
      type: 'inboundcall',
      body: 'v1\n',
    });
    const counting2 = new CountingProvider(provider2);
    const result2 = await runIncrementalCapture(runOptions(root, 'run-2', counting2));

    expect(result2.plan.toSkip.map((f) => f.flowId)).toEqual(['flow-a']);
    expect(result2.plan.toSkip[0]?.reason).toBe('METADATA_UNCHANGED');
    expect(counting2.loadCalls.has('flow-a')).toBe(false);

    const definition = await readFlowDefinition(root, 'flow-a');
    expect(definition).toBe('v1\n');
  });

  it('a changed flow is re-captured', async () => {
    const root = await freshDir();
    const provider1 = makeProvider();
    provider1.seedFlow({
      flowId: asFlowId('flow-b'),
      name: 'Flow B',
      type: 'inboundcall',
      publishedVersion: '1',
      body: 'before\n',
    });
    await runIncrementalCapture(runOptions(root, 'run-1', provider1));

    const provider2 = makeProvider();
    provider2.seedFlow({
      flowId: asFlowId('flow-b'),
      name: 'Flow B',
      type: 'inboundcall',
      publishedVersion: '2',
      body: 'after\n',
    });
    const counting2 = new CountingProvider(provider2);
    const result2 = await runIncrementalCapture(runOptions(root, 'run-2', counting2));

    expect(result2.plan.toCapture.map((f) => f.flowId)).toEqual(['flow-b']);
    expect(result2.plan.toCapture[0]?.isNew).toBe(false);
    expect(counting2.loadCalls.get('flow-b')).toBe(1);

    const definition = await readFlowDefinition(root, 'flow-b');
    expect(definition).toBe('after\n');
  });

  it('a new flow is captured', async () => {
    const root = await freshDir();
    const provider1 = makeProvider();
    provider1.seedFlow({ flowId: asFlowId('flow-a'), name: 'Flow A', type: 'inboundcall' });
    await runIncrementalCapture(runOptions(root, 'run-1', provider1));

    const provider2 = makeProvider();
    provider2.seedFlow({ flowId: asFlowId('flow-a'), name: 'Flow A', type: 'inboundcall' });
    provider2.seedFlow({ flowId: asFlowId('flow-c'), name: 'Flow C', type: 'inboundcall' });
    const result2 = await runIncrementalCapture(runOptions(root, 'run-2', provider2));

    expect(result2.plan.toCapture.map((f) => f.flowId)).toEqual(['flow-c']);
    expect(result2.plan.toCapture[0]?.isNew).toBe(true);
    expect(result2.plan.toCapture[0]?.reason).toBe('NEVER_SEEN_BEFORE');

    expect((await flowIdsInBundle(root)).sort()).toEqual(['flow-a', 'flow-c']);
  });

  it('a flow that disappeared becomes a retire-candidate and its previous definition is still carried forward', async () => {
    const root = await freshDir();
    const provider1 = makeProvider();
    provider1.seedFlow({ flowId: asFlowId('flow-a'), name: 'Flow A', type: 'inboundcall' });
    provider1.seedFlow({
      flowId: asFlowId('flow-d'),
      name: 'Flow D',
      type: 'inboundcall',
      body: 'gone\n',
    });
    await runIncrementalCapture(runOptions(root, 'run-1', provider1));

    // flow-d is not seeded at all in run 2's provider: absent from discovery,
    // and resolveDependencies({type:'flow', id:'flow-d'}) falls back to
    // FakeSourceProvider's default 'not_found' -- never 'forbidden'.
    const provider2 = makeProvider();
    provider2.seedFlow({ flowId: asFlowId('flow-a'), name: 'Flow A', type: 'inboundcall' });
    const result2 = await runIncrementalCapture(runOptions(root, 'run-2', provider2));

    expect(result2.plan.retireCandidates.map((f) => f.flowId)).toEqual(['flow-d']);
    expect(result2.plan.inaccessible).toEqual([]);

    expect((await flowIdsInBundle(root)).sort()).toEqual(['flow-a', 'flow-d']);
    const definition = await readFlowDefinition(root, 'flow-d');
    expect(definition).toBe('gone\n');
  });

  it('a flow that became inaccessible is reported as such, not as deleted', async () => {
    const root = await freshDir();
    const provider1 = makeProvider();
    provider1.seedFlow({ flowId: asFlowId('flow-a'), name: 'Flow A', type: 'inboundcall' });
    provider1.seedFlow({
      flowId: asFlowId('flow-e'),
      name: 'Flow E',
      type: 'inboundcall',
      body: 'secret\n',
    });
    await runIncrementalCapture(runOptions(root, 'run-1', provider1));

    // flow-e is absent from discovery in run 2, but this time
    // resolveDependencies reports 'forbidden' for it -- the same
    // {type:'flow', id} convention capture-run.ts documents for reading a
    // flow's own inline reference manifest, reused here to distinguish
    // permission loss from deletion.
    const provider2 = makeProvider();
    provider2.seedFlow({ flowId: asFlowId('flow-a'), name: 'Flow A', type: 'inboundcall' });
    provider2.seedDependency({
      ref: { type: 'flow', id: asResourceId('flow-e') },
      status: 'forbidden',
      displayName: null,
      safeMetadata: {},
    });
    const result2 = await runIncrementalCapture(runOptions(root, 'run-2', provider2));

    expect(result2.plan.inaccessible.map((f) => f.flowId)).toEqual(['flow-e']);
    expect(result2.plan.retireCandidates).toEqual([]);

    expect((await flowIdsInBundle(root)).sort()).toEqual(['flow-a', 'flow-e']);
    const definition = await readFlowDefinition(root, 'flow-e');
    expect(definition).toBe('secret\n');
  });

  it('the resulting bundle contains every flow the previous one did, plus new ones', async () => {
    const root = await freshDir();
    const provider1 = makeProvider();
    const previousFlowIds = ['flow-1', 'flow-2', 'flow-3', 'flow-4', 'flow-5'];
    for (const flowId of previousFlowIds) {
      provider1.seedFlow({ flowId: asFlowId(flowId), name: `Flow ${flowId}`, type: 'inboundcall' });
    }
    await runIncrementalCapture(runOptions(root, 'run-1', provider1));
    expect((await flowIdsInBundle(root)).sort()).toEqual([...previousFlowIds].sort());

    // Run 2: flow-2 changes, flow-4 disappears (retire-candidate), flow-6 is
    // new. flow-1, flow-3, flow-5 are untouched. Every flow from run 1 must
    // still be present afterward, plus flow-6 -- nothing may be silently
    // dropped just because this run only actively fetched two of them.
    const provider2 = makeProvider();
    provider2.seedFlow({ flowId: asFlowId('flow-1'), name: 'Flow flow-1', type: 'inboundcall' });
    provider2.seedFlow({
      flowId: asFlowId('flow-2'),
      name: 'Flow flow-2',
      type: 'inboundcall',
      publishedVersion: '2',
    });
    provider2.seedFlow({ flowId: asFlowId('flow-3'), name: 'Flow flow-3', type: 'inboundcall' });
    provider2.seedFlow({ flowId: asFlowId('flow-5'), name: 'Flow flow-5', type: 'inboundcall' });
    provider2.seedFlow({ flowId: asFlowId('flow-6'), name: 'Flow flow-6', type: 'inboundcall' });
    await runIncrementalCapture(runOptions(root, 'run-2', provider2));

    const afterFlowIds = await flowIdsInBundle(root);
    expect(afterFlowIds.sort()).toEqual([
      'flow-1',
      'flow-2',
      'flow-3',
      'flow-4',
      'flow-5',
      'flow-6',
    ]);
  });

  it('reports counts: captured / carried forward / retired / inaccessible', async () => {
    const root = await freshDir();
    const provider1 = makeProvider();
    provider1.seedFlow({ flowId: asFlowId('flow-1'), name: 'Flow 1', type: 'inboundcall' });
    provider1.seedFlow({ flowId: asFlowId('flow-2'), name: 'Flow 2', type: 'inboundcall' });
    provider1.seedFlow({ flowId: asFlowId('flow-3'), name: 'Flow 3', type: 'inboundcall' });
    await runIncrementalCapture(runOptions(root, 'run-1', provider1));

    const provider2 = makeProvider();
    // flow-1 unchanged, flow-2 gone (retire), flow-3 not seeded but reported
    // forbidden (inaccessible), flow-4 new.
    provider2.seedFlow({ flowId: asFlowId('flow-1'), name: 'Flow 1', type: 'inboundcall' });
    provider2.seedFlow({ flowId: asFlowId('flow-4'), name: 'Flow 4', type: 'inboundcall' });
    provider2.seedDependency({
      ref: { type: 'flow', id: asResourceId('flow-3') },
      status: 'forbidden',
      displayName: null,
      safeMetadata: {},
    });
    const result2 = await runIncrementalCapture(runOptions(root, 'run-2', provider2));

    expect(result2.counts.captured).toBe(1); // flow-4
    expect(result2.counts.retired).toBe(1); // flow-2
    expect(result2.counts.inaccessible).toBe(1); // flow-3
    // Carried forward: flow-1 (unchanged) + flow-2 (retire-candidate) +
    // flow-3 (inaccessible) all still ship in the bundle without a fetch.
    expect(result2.counts.carriedForward).toBe(3);
  });

  it('is deterministic: two fresh runs over identical input produce byte-identical bundles', async () => {
    const rootA = await freshDir();
    const rootB = await freshDir();
    const providerA = makeProvider();
    providerA.seedFlow({ flowId: asFlowId('flow-a'), name: 'Flow A', type: 'inboundcall' });
    const providerB = makeProvider();
    providerB.seedFlow({ flowId: asFlowId('flow-a'), name: 'Flow A', type: 'inboundcall' });

    const resultA = await runIncrementalCapture(runOptions(rootA, 'run-1', providerA));
    const resultB = await runIncrementalCapture(runOptions(rootB, 'run-1', providerB));

    expect(resultA.contentHash).toBeDefined();
    expect(resultA.contentHash).toBe(resultB.contentHash);
  });

  it('never lets a tenant-authored flow name reach a skip reason', async () => {
    const root = await freshDir();
    const provider1 = makeProvider();
    provider1.seedFlow({ flowId: asFlowId('flow-a'), name: CANARY, type: 'inboundcall' });
    await runIncrementalCapture(runOptions(root, 'run-1', provider1));

    const provider2 = makeProvider();
    provider2.seedFlow({ flowId: asFlowId('flow-a'), name: CANARY, type: 'inboundcall' });
    const result2 = await runIncrementalCapture(runOptions(root, 'run-2', provider2));

    expect(JSON.stringify(result2.plan)).not.toContain(CANARY);
    expect(JSON.stringify(result2.counts)).not.toContain(CANARY);
  });
});
