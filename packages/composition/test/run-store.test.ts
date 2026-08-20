// packages/composition/test/run-store.test.ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRunStore, type RunManifest } from '../src/run-store.js';

const created: string[] = [];

async function freshRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'archivist-run-store-'));
  created.push(dir);
  return dir;
}

beforeEach(() => {
  created.length = 0;
});

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function makeManifest(overrides: Partial<RunManifest> = {}): RunManifest {
  return {
    schemaVersion: '1.1',
    stage: 'document',
    runId: 'run-1',
    planId: 'plan-1',
    planHash: 'sha256:abcdefabcdefabcd',
    idempotencyKey: 'run-1:sha256:abcdefabcdefabcd',
    profileId: 'sandbox-bfsi',
    organization: { id: 'org-1', region: 'eu-west-1' },
    state: 'planned',
    policy: { versionSelection: 'published', allowPartialPromotion: false },
    versions: { application: 'genesys-archivist', adapter: 'archivist-port' },
    selection: [],
    progress: { total: 0, queued: 0, running: 0, completed: 0, skipped: 0, failed: 0 },
    flowResults: [],
    warnings: [],
    errors: [],
    artifacts: [],
    ...overrides,
  };
}

describe('run-store: round trip', () => {
  it('returns absent for a run that was never saved', async () => {
    const root = await freshRoot();
    const store = createRunStore({ root });
    const result = await store.load('never-saved');
    expect(result.status).toBe('absent');
  });

  it('loads back exactly what was saved', async () => {
    const root = await freshRoot();
    const store = createRunStore({ root });
    const manifest = makeManifest({ runId: 'run-abc', state: 'extracting' });
    await store.save(manifest);

    const result = await store.load('run-abc');
    expect(result.status).toBe('found');
    if (result.status === 'found') expect(result.manifest).toEqual(manifest);
  });
});

describe('run-store: atomic replacement', () => {
  it('a second save replaces the first, leaving only the latest state readable', async () => {
    const root = await freshRoot();
    const store = createRunStore({ root });
    await store.save(makeManifest({ runId: 'run-x', state: 'planned' }));
    await store.save(makeManifest({ runId: 'run-x', state: 'completed' }));

    const result = await store.load('run-x');
    expect(result.status).toBe('found');
    if (result.status === 'found') expect(result.manifest.state).toBe('completed');
  });

  it('rejects an invalid manifest before anything is written to disk', async () => {
    const root = await freshRoot();
    const store = createRunStore({ root });
    const invalid = {
      ...makeManifest({ runId: 'run-bad' }),
      state: undefined,
    } as unknown as RunManifest;

    await expect(store.save(invalid)).rejects.toThrow();
    const result = await store.load('run-bad');
    expect(result.status).toBe('absent');
  });
});

describe('run-store: corrupt manifests are reported, never treated as absent', () => {
  it('reports a manifest that is not valid JSON', async () => {
    const root = await freshRoot();
    const store = createRunStore({ root });
    const dir = join(root, '.archivist', 'runs', 'run-corrupt-json');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'manifest.json'), '{ this is not json', 'utf8');

    const result = await store.load('run-corrupt-json');
    expect(result.status).toBe('corrupt');
    if (result.status === 'corrupt') expect(result.reason.length).toBeGreaterThan(0);
  });

  it('reports a manifest that is valid JSON but fails schema validation', async () => {
    const root = await freshRoot();
    const store = createRunStore({ root });
    const dir = join(root, '.archivist', 'runs', 'run-corrupt-shape');
    await mkdir(dir, { recursive: true });
    // Missing every required field.
    await writeFile(join(dir, 'manifest.json'), JSON.stringify({ hello: 'world' }), 'utf8');

    const result = await store.load('run-corrupt-shape');
    expect(result.status).toBe('corrupt');
    if (result.status === 'corrupt') expect(result.reason).toContain('schema');
  });
});

describe('run-store: concurrent writes are serialized, never interleaved', () => {
  it('two concurrent saves to the same run leave a consistent, non-torn manifest', async () => {
    const root = await freshRoot();
    const store = createRunStore({ root });
    const a = makeManifest({ runId: 'run-concurrent', state: 'extracting', idempotencyKey: 'a' });
    const b = makeManifest({ runId: 'run-concurrent', state: 'normalizing', idempotencyKey: 'b' });

    await Promise.all([store.save(a), store.save(b)]);

    const result = await store.load('run-concurrent');
    expect(result.status).toBe('found');
    if (result.status === 'found') {
      // Whichever writer won, the loaded manifest must equal exactly one of
      // the two full inputs -- never a field-by-field mix, which is what a
      // torn (non-atomic) write would look like.
      const matchesA = JSON.stringify(result.manifest) === JSON.stringify(a);
      const matchesB = JSON.stringify(result.manifest) === JSON.stringify(b);
      expect(matchesA || matchesB).toBe(true);
    }
  });
});

describe('run-store: resumability', () => {
  it('a run interrupted mid-flight reads back exactly the last checkpoint it reached', async () => {
    const root = await freshRoot();
    const store = createRunStore({ root });

    await store.save(makeManifest({ runId: 'run-resume', state: 'queued' }));
    let result = await store.load('run-resume');
    expect(result.status).toBe('found');
    if (result.status === 'found') expect(result.manifest.state).toBe('queued');

    // Simulates the process dying after reaching "extracting" but before any
    // further checkpoint -- the next save() call a fresh process makes.
    await store.save(makeManifest({ runId: 'run-resume', state: 'extracting' }));
    result = await store.load('run-resume');
    expect(result.status).toBe('found');
    if (result.status === 'found') {
      // Honest about where it stopped: 'extracting', never invented later
      // states such as 'completed' that this store was never told happened.
      expect(result.manifest.state).toBe('extracting');
    }
  });

  it('different runs under the same root do not interfere with each other', async () => {
    const root = await freshRoot();
    const store = createRunStore({ root });
    await store.save(makeManifest({ runId: 'run-a', state: 'completed' }));
    await store.save(makeManifest({ runId: 'run-b', state: 'failed' }));

    const a = await store.load('run-a');
    const b = await store.load('run-b');
    expect(a.status).toBe('found');
    expect(b.status).toBe('found');
    if (a.status === 'found' && b.status === 'found') {
      expect(a.manifest.state).toBe('completed');
      expect(b.manifest.state).toBe('failed');
    }
  });
});

describe('run-store: a schema-validation failure never echoes the invalid content', () => {
  it('a canary in a field this store rejects never appears in the rejection reason', async () => {
    const root = await freshRoot();
    const store = createRunStore({ root });
    const canary = 'CANARY-RUN-STORE-8e21fa';
    // `state` outside the schema's enum is rejected; the offending value
    // itself carries the canary, and ajv's error message must not quote it
    // back -- an invalid-manifest error is exactly the kind of message that
    // could otherwise carry tenant- or secret-shaped content into a log.
    const invalid = makeManifest({ runId: 'run-canary', state: canary });

    let rejectionMessage = '';
    try {
      await store.save(invalid);
    } catch (error) {
      rejectionMessage = error instanceof Error ? error.message : String(error);
    }
    expect(rejectionMessage.length).toBeGreaterThan(0);
    expect(rejectionMessage).not.toContain(canary);
  });
});
