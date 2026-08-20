// packages/capture/test/capture-run.test.ts
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
import { CANARIES, FakeSourceProvider, createSchemaValidator } from '@genesys-archivist/testing';
import { acquireLock } from '@genesys-archivist/storage';
import { verifyBundle } from '../src/bundle-verifier.js';
import { runCapture, resumeCapture, type CaptureRunOptions } from '../src/capture-run.js';

let root = '';

function provider(count = 3): FakeSourceProvider {
  const p = new FakeSourceProvider({
    organizationId: asOrganizationId('org_1'),
    region: 'test',
    pageSize: 2,
  });
  for (let i = 0; i < count; i += 1) {
    p.seedFlow({
      flowId: asFlowId(`f${String(i)}`),
      name: `Flow ${String(i)}`,
      type: 'inboundcall',
    });
  }
  return p;
}

/** Seeds a flow-self manifest reference plus a downstream chain, so the
 * resource-graph walk has somewhere to go. See the "modeling convention"
 * comment at the top of capture-run.ts for why `resolveDependencies` is used
 * this way. */
function withChain(p: FakeSourceProvider): FakeSourceProvider {
  p.seedDependency({
    ref: { type: 'flow', id: asResourceId('f0') },
    status: 'resolved',
    displayName: 'Flow 0',
    safeMetadata: { references: [{ type: 'queue', id: 'q1' }] },
  });
  p.seedDependency({
    ref: { type: 'queue', id: asResourceId('q1') },
    status: 'resolved',
    displayName: 'Queue 1',
    safeMetadata: { references: [{ type: 'integration', id: 'i1' }] },
  });
  p.seedDependency({
    ref: { type: 'integration', id: asResourceId('i1') },
    status: 'resolved',
    displayName: 'Integration 1',
    safeMetadata: {
      references: [],
      asset: {
        bytes: new Uint8Array([1, 2, 3, 4]),
        originalName: 'greeting.wav',
        mimeType: 'audio/wav',
      },
      dataTableRows: [{ column: 'value' }],
    },
  });
  return p;
}

/** Counts every call the run makes against the provider, without touching
 * @genesys-archivist/testing (out of this task's ownership). */
class CountingProvider implements GenesysSourceProvider {
  calls = { validateConnection: 0, listFlows: 0, loadFlowSource: 0, resolveDependencies: 0 };
  constructor(private readonly inner: GenesysSourceProvider) {}
  validateConnection(): Promise<ConnectionIdentity> {
    this.calls.validateConnection += 1;
    return this.inner.validateConnection();
  }
  async *listFlows(query: FlowDiscoveryQuery): AsyncIterable<FlowDescriptor> {
    this.calls.listFlows += 1;
    yield* this.inner.listFlows(query);
  }
  loadFlowSource(ref: FlowVersionRef): Promise<RawFlowSource> {
    this.calls.loadFlowSource += 1;
    return this.inner.loadFlowSource(ref);
  }
  resolveDependencies(refs: readonly DependencyRef[]): Promise<readonly DependencyResolution[]> {
    this.calls.resolveDependencies += 1;
    return this.inner.resolveDependencies(refs);
  }
  get total(): number {
    return (
      this.calls.validateConnection +
      this.calls.listFlows +
      this.calls.loadFlowSource +
      this.calls.resolveDependencies
    );
  }
}

/** Fails part-way through loading one specific flow, without needing
 * FakeSourceProvider itself to support failure injection. */
class FlakyLoadProvider implements GenesysSourceProvider {
  constructor(
    private readonly inner: GenesysSourceProvider,
    private readonly failFlowId: string,
  ) {}
  validateConnection(): Promise<ConnectionIdentity> {
    return this.inner.validateConnection();
  }
  listFlows(query: FlowDiscoveryQuery): AsyncIterable<FlowDescriptor> {
    return this.inner.listFlows(query);
  }
  loadFlowSource(ref: FlowVersionRef): Promise<RawFlowSource> {
    if (ref.flowId === this.failFlowId) {
      return Promise.reject(new Error('CANARY-simulated upstream failure, never surfaced'));
    }
    return this.inner.loadFlowSource(ref);
  }
  resolveDependencies(refs: readonly DependencyRef[]): Promise<readonly DependencyResolution[]> {
    return this.inner.resolveDependencies(refs);
  }
}

/** Discovers a couple of flows, then blows up mid-iteration -- simulates a
 * connection drop during discovery, after some staging content may already
 * have been written by an earlier phase of the same run. */
class BrokenDiscoveryProvider implements GenesysSourceProvider {
  constructor(private readonly inner: GenesysSourceProvider) {}
  validateConnection(): Promise<ConnectionIdentity> {
    return this.inner.validateConnection();
  }
  async *listFlows(query: FlowDiscoveryQuery): AsyncIterable<FlowDescriptor> {
    let n = 0;
    for await (const flow of this.inner.listFlows(query)) {
      if (n >= 1) throw new Error('CANARY-discovery-connection-dropped, never surfaced');
      yield flow;
      n += 1;
    }
  }
  loadFlowSource(ref: FlowVersionRef): Promise<RawFlowSource> {
    return this.inner.loadFlowSource(ref);
  }
  resolveDependencies(refs: readonly DependencyRef[]): Promise<readonly DependencyResolution[]> {
    return this.inner.resolveDependencies(refs);
  }
}

const opts = (overrides: Partial<CaptureRunOptions> = {}): CaptureRunOptions => ({
  root,
  runId: 'run_1',
  planHash: 'sha256:' + 'a'.repeat(64),
  organizationId: asOrganizationId('org_1'),
  expectedOrganizationId: asOrganizationId('org_1'),
  provider: provider(),
  mode: 'context',
  ...overrides,
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'archivist-run-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('runCapture', () => {
  it('completes and seals a bundle', async () => {
    const result = await runCapture(opts());
    expect(result.state).toBe('completed');
    expect(result.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('captures every discovered flow across pages', async () => {
    expect((await runCapture(opts({ provider: provider(7) }))).progress.completed).toBe(7);
  });

  it('aborts before any read when the organization does not match', async () => {
    const p = new CountingProvider(provider());
    const result = await runCapture(
      opts({ provider: p, expectedOrganizationId: asOrganizationId('org_OTHER') }),
    );
    expect(result.state).toBe('failed');
    expect(result.errors.some((e) => e.code === 'TENANT_MISMATCH')).toBe(true);
    expect(p.calls.listFlows).toBe(0);
    expect(p.calls.loadFlowSource).toBe(0);
  });

  // CORRECTED per the plan: acquire the lock deterministically first rather
  // than racing two unawaited runCapture() calls against each other.
  it('refuses to start when another run holds the lock', async () => {
    const held = await acquireLock(root, 'capture');
    expect(held).not.toBeNull();
    try {
      const blocked = await runCapture(opts({ runId: 'run_b' }));
      expect(blocked.state).toBe('failed');
      expect(blocked.errors.some((e) => e.code === 'OUTPUT_LOCKED')).toBe(true);
    } finally {
      await held?.release();
    }
  });

  it('persists a run manifest that satisfies the published schema', async () => {
    // allowUnionTypes: the schema legitimately declares `selectedVersion` as
    // `["integer", "string"]`; ajv's strict mode otherwise treats a plain
    // (non-"error") union type declaration as suspicious and throws.
    const validate = await createSchemaValidator('schemas/run-manifest.schema.json', {
      allowUnionTypes: true,
    });

    await runCapture(opts());
    const manifest: unknown = JSON.parse(
      await readFile(join(root, '.archivist', 'state', 'runs', 'run_1.json'), 'utf8'),
    );
    const ok = validate(manifest);
    if (!ok) {
      throw new Error(
        `manifest failed schema validation: ${JSON.stringify(validate.errors, null, 2)}`,
      );
    }
    expect(ok).toBe(true);
  });

  it('resumes without refetching completed flows', async () => {
    await runCapture(opts());
    const resumed = await resumeCapture('run_1', opts());
    expect(resumed.progress.skipped).toBeGreaterThan(0);
  });

  it('refuses to resume under a different plan hash', async () => {
    await runCapture(opts());
    const resumed = await resumeCapture('run_1', opts({ planHash: 'sha256:' + 'b'.repeat(64) }));
    expect(resumed.state).toBe('failed');
    expect(resumed.errors.some((e) => e.code === 'PLAN_HASH_MISMATCH')).toBe(true);
  });

  it('continues past one failing flow and reports it', async () => {
    const p = new FlakyLoadProvider(provider(3), 'f1');
    const result = await runCapture(opts({ provider: p }));
    expect(result.state).toBe('completed_with_warnings');
    expect(result.progress.completed).toBe(2);
    expect(result.progress.failed).toBe(1);
  });

  describe('ADR-018: context vs migration', () => {
    it('context mode makes strictly fewer provider calls than migration mode over the same scope', async () => {
      const contextProvider = new CountingProvider(withChain(provider(1)));
      const migrationProvider = new CountingProvider(withChain(provider(1)));

      await runCapture(opts({ provider: contextProvider, mode: 'context', runId: 'run_ctx' }));
      await runCapture(opts({ provider: migrationProvider, mode: 'migration', runId: 'run_mig' }));

      expect(contextProvider.total).toBeLessThan(migrationProvider.total);
    });

    it('context bundle is never migration-ready and does not fetch resource bodies or assets', async () => {
      const result = await runCapture(
        opts({ provider: withChain(provider(1)), mode: 'context', runId: 'run_ctx2' }),
      );
      expect(result.state).toBe('completed');
      const manifest: {
        policy: { mode: string; captureAssets: boolean };
        counts: { assets: number };
        migrationReadiness: { archyImportableYaml: boolean; caveats?: string[] };
      } = JSON.parse(await readFile(join(root, 'bundle', 'bundle-manifest.json'), 'utf8')) as never;
      expect(manifest.policy.mode).toBe('context');
      expect(manifest.policy.captureAssets).toBe(false);
      expect(manifest.counts.assets).toBe(0);
      expect(manifest.migrationReadiness.archyImportableYaml).toBe(false);
      expect(manifest.migrationReadiness.caveats?.some((c) => c.includes('context'))).toBe(true);
    });

    it('migration mode walks resources to closure, downloads assets, and is migration-ready', async () => {
      const result = await runCapture(
        opts({ provider: withChain(provider(1)), mode: 'migration', runId: 'run_mig2' }),
      );
      expect(result.state).toBe('completed');
      const manifest: {
        policy: { mode: string; captureAssets: boolean };
        counts: { resources: number; assets: number };
        migrationReadiness: { archyImportableYaml: boolean; assetsCaptured: boolean };
      } = JSON.parse(await readFile(join(root, 'bundle', 'bundle-manifest.json'), 'utf8')) as never;
      expect(manifest.policy.mode).toBe('migration');
      expect(manifest.policy.captureAssets).toBe(true);
      expect(manifest.counts.resources).toBeGreaterThanOrEqual(2); // queue + integration bodies
      expect(manifest.counts.assets).toBe(1);
      expect(manifest.migrationReadiness.archyImportableYaml).toBe(true);
      expect(manifest.migrationReadiness.assetsCaptured).toBe(true);
    });

    it('surfaces a truncated resource walk as a bundle caveat rather than presenting it as complete', async () => {
      const p = provider(1);
      p.seedDependency({
        ref: { type: 'flow', id: asResourceId('f0') },
        status: 'resolved',
        displayName: 'Flow 0',
        safeMetadata: { references: [{ type: 'queue', id: 'q1' }] },
      });
      p.seedDependency({
        ref: { type: 'queue', id: asResourceId('q1') },
        status: 'resolved',
        displayName: 'Queue 1',
        safeMetadata: { references: [{ type: 'integration', id: 'i1' }] },
      });
      p.seedDependency({
        ref: { type: 'integration', id: asResourceId('i1') },
        status: 'resolved',
        displayName: 'Integration 1',
        safeMetadata: { references: [{ type: 'dataaction', id: 'd1' }] },
      });
      p.seedDependency({
        ref: { type: 'dataaction', id: asResourceId('d1') },
        status: 'resolved',
        displayName: 'Data Action 1',
        safeMetadata: { references: [] },
      });

      const result = await runCapture(
        opts({ provider: p, mode: 'migration', runId: 'run_trunc', maxRequests: 2 }),
      );
      expect(result.state).toBe('completed_with_warnings');
      const manifest: { migrationReadiness: { caveats?: string[] } } = JSON.parse(
        await readFile(join(root, 'bundle', 'bundle-manifest.json'), 'utf8'),
      ) as never;
      expect(
        manifest.migrationReadiness.caveats?.some((c) => c.toLowerCase().includes('trunc')),
      ).toBe(true);
    });
  });

  describe('atomicity', () => {
    it('a failed run leaves the previously promoted bundle completely intact', async () => {
      const first = await runCapture(opts({ runId: 'run_good' }));
      expect(first.state).toBe('completed');
      const before = JSON.parse(
        await readFile(join(root, 'bundle', 'bundle-manifest.json'), 'utf8'),
      ) as { contentHash: string };

      const broken = new BrokenDiscoveryProvider(provider(3));
      const second = await runCapture(opts({ provider: broken, runId: 'run_bad' }));
      expect(second.state).toBe('failed');

      const verification = await verifyBundle(join(root, 'bundle'));
      expect(verification.ok).toBe(true);
      const after = JSON.parse(
        await readFile(join(root, 'bundle', 'bundle-manifest.json'), 'utf8'),
      ) as { contentHash: string };
      expect(after.contentHash).toBe(before.contentHash);
    });
  });

  describe('security', () => {
    it('never lets a canary planted in captured content or a provider error reach the run manifest', async () => {
      const p = provider(0);
      p.seedFlow({
        flowId: asFlowId('canary-flow'),
        name: 'Canary flow',
        type: 'inboundcall',
        body: `name: ${CANARIES[0] ?? 'MISSING-CANARY'}\n`,
      });
      const flaky = new FlakyLoadProvider(p, 'never-matches-so-loads-fine');
      await runCapture(opts({ provider: flaky, runId: 'run_canary' }));
      const manifestText = await readFile(
        join(root, '.archivist', 'state', 'runs', 'run_canary.json'),
        'utf8',
      );
      for (const canary of CANARIES) {
        expect(manifestText).not.toContain(canary);
      }
    });
  });
});
