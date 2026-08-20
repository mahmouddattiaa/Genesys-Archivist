// packages/capture/test/bundle-writer.test.ts
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BundleWriter } from '../src/bundle-writer.js';
import type { ResourceGraphResult } from '../src/resource-graph.js';

let root = '';
// Tests below build extra writers against their own temp roots (to compare
// content hashes across independent bundles). `afterEach` only ever knew
// about the single `root` from `beforeEach`, so every one of those extra
// directories used to leak forever across the suite. Track every directory
// this file creates and remove all of them here.
const extraRoots: string[] = [];

const opts = () => ({
  root,
  captureId: '2026-08-20T14-02-11Z_a1b2c3',
  organization: { id: 'org_1', region: 'mec1' },
  policy: {
    mode: 'migration' as const,
    versionSelection: 'published' as const,
    captureAssets: true,
    captureDataTableRows: true,
  },
  versions: { application: '0.1.0', adapter: '0.1.0', sourceProvider: 'fixture' as const },
  now: () => new Date('2026-08-20T14:31:00Z'),
});

async function extraRoot(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  extraRoots.push(dir);
  return dir;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'archivist-bundle-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await Promise.all(extraRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('BundleWriter', () => {
  it('produces a manifest that validates against the published schema', async () => {
    const { default: Ajv2020 } = await import('ajv/dist/2020.js');
    const { default: addFormats } = await import('ajv-formats');
    const schema: unknown = JSON.parse(
      await readFile('schemas/capture-bundle.schema.json', 'utf8'),
    );
    const ajv = new Ajv2020({ strict: true });
    addFormats(ajv);
    const writer = new BundleWriter(opts());
    await writer.writeFlow('f1', '1', 'name: Main\n', { id: 'f1', type: 'inboundcall' });
    const sealed = await writer.seal();
    expect(ajv.compile(schema)(sealed.manifest)).toBe(true);
  });

  it('classifies every bundle as restricted', async () => {
    const writer = new BundleWriter(opts());
    expect((await writer.seal()).manifest.classification).toBe('restricted');
  });

  it('produces the same content hash for the same content', async () => {
    const a = new BundleWriter({ ...opts(), root: await extraRoot('a-') });
    const b = new BundleWriter({ ...opts(), root: await extraRoot('b-') });
    for (const w of [a, b])
      await w.writeFlow('f1', '1', 'name: Main\n', { id: 'f1', type: 'inboundcall' });
    expect((await a.seal()).contentHash).toBe((await b.seal()).contentHash);
  });

  it('produces a different content hash when a flow definition changes', async () => {
    const a = new BundleWriter({ ...opts(), root: await extraRoot('a-') });
    const b = new BundleWriter({ ...opts(), root: await extraRoot('b-') });
    await a.writeFlow('f1', '1', 'name: Main\n', { id: 'f1', type: 'inboundcall' });
    await b.writeFlow('f1', '1', 'name: Changed\n', { id: 'f1', type: 'inboundcall' });
    expect((await a.seal()).contentHash).not.toBe((await b.seal()).contentHash);
  });

  it('ignores volatile fields, so a signed URL does not fake a change', async () => {
    const a = new BundleWriter({ ...opts(), root: await extraRoot('a-') });
    const b = new BundleWriter({ ...opts(), root: await extraRoot('b-') });
    await a.writeResource('prompts', 'p1', {
      id: 'p1',
      mediaUri: 'https://x/sig=AAA',
      extractedAt: '2026-01-01T00:00:00Z',
    });
    await b.writeResource('prompts', 'p1', {
      id: 'p1',
      mediaUri: 'https://x/sig=BBB',
      extractedAt: '2026-06-06T00:00:00Z',
    });
    expect((await a.seal()).contentHash).toBe((await b.seal()).contentHash);
  });

  it('counts what it captured', async () => {
    const writer = new BundleWriter(opts());
    await writer.writeFlow('f1', '1', 'x', { id: 'f1', type: 'inboundcall' });
    await writer.writeResource('queues', 'q1', { id: 'q1' });
    const sealed = await writer.seal();
    expect(sealed.manifest.counts.flows).toBe(1);
    expect(sealed.manifest.counts.resources).toBe(1);
  });

  it('records migration readiness honestly when assets were not captured', async () => {
    const writer = new BundleWriter({
      ...opts(),
      policy: { ...opts().policy, captureAssets: false },
    });
    const sealed = await writer.seal();
    expect(sealed.manifest.migrationReadiness?.assetsCaptured).toBe(false);
  });

  it('writes definition.yaml where a migration tool expects it', async () => {
    const writer = new BundleWriter(opts());
    await writer.writeFlow('f1', '1', 'name: Main\n', { id: 'f1', type: 'inboundcall' });
    await writer.seal();
    const path = join(root, 'flows', 'f1', 'versions', '1', 'definition.yaml');
    expect(await readFile(path, 'utf8')).toBe('name: Main\n');
  });

  it('stores an asset once and counts it', async () => {
    const writer = new BundleWriter(opts());
    const bytes = new TextEncoder().encode('hello prompt audio');
    const address = await writer.putAsset(bytes, {
      originalName: 'greeting.wav',
      mimeType: 'audio/wav',
      usedBy: { type: 'prompt', id: 'p1', language: 'en-us' },
    });
    expect(address).toMatch(/^sha256:[0-9a-f]{64}$/);
    const sealed = await writer.seal();
    expect(sealed.manifest.counts.assets).toBe(1);
    expect(sealed.manifest.counts.assetBytes).toBe(bytes.byteLength);
  });

  it('deduplicates identical asset bytes by content hash', async () => {
    const writer = new BundleWriter(opts());
    const bytes = new TextEncoder().encode('identical bytes');
    await writer.putAsset(bytes, {
      originalName: 'a.wav',
      mimeType: 'audio/wav',
      usedBy: { type: 'prompt', id: 'p1' },
    });
    await writer.putAsset(bytes, {
      originalName: 'b.wav',
      mimeType: 'audio/wav',
      usedBy: { type: 'prompt', id: 'p2' },
    });
    const sealed = await writer.seal();
    expect(sealed.manifest.counts.assets).toBe(1);
  });

  it('records unresolved references from the resource graph honestly', async () => {
    const writer = new BundleWriter(opts());
    const result: ResourceGraphResult = {
      graph: {
        nodes: [
          {
            key: 'queue:q1',
            type: 'queue',
            id: 'q1',
            displayName: 'Q1',
            resolutionStatus: 'resolved',
          },
          {
            key: 'queue:q2',
            type: 'queue',
            id: 'q2',
            displayName: null,
            resolutionStatus: 'not_found',
          },
        ],
        edges: [],
        orphans: ['queue:q1', 'queue:q2'],
      },
      truncated: false,
      requests: 2,
    };
    await writer.writeResourceGraph(result);
    const sealed = await writer.seal();
    expect(sealed.manifest.counts.unresolvedReferences).toBe(1);
  });

  it('never claims a truncated capture is complete', async () => {
    const writer = new BundleWriter(opts());
    const result: ResourceGraphResult = {
      graph: { nodes: [], edges: [], orphans: [] },
      truncated: true,
      requests: 10_000,
    };
    await writer.writeResourceGraph(result);
    const sealed = await writer.seal();
    expect(
      sealed.manifest.migrationReadiness?.caveats?.some((c) => c.toLowerCase().includes('truncat')),
    ).toBe(true);
  });
});
