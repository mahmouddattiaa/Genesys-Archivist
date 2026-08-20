// packages/capture/test/bundle-verifier.test.ts
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BundleWriter } from '../src/bundle-writer.js';
import { verifyBundle } from '../src/bundle-verifier.js';

let root = '';

async function seededBundle(dir: string): Promise<void> {
  const writer = new BundleWriter({
    root: dir,
    captureId: '2026-08-20T14-02-11Z_a1b2c3',
    organization: { id: 'org_1', region: 'mec1' },
    policy: { versionSelection: 'published', captureAssets: true, captureDataTableRows: true },
    versions: { application: '0.1.0', adapter: '0.1.0', sourceProvider: 'fixture' },
    now: () => new Date('2026-08-20T14:31:00Z'),
  });
  await writer.writeFlow('f1', '1', 'name: Main\n', { id: 'f1', type: 'inboundcall' });
  await writer.seal();
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'archivist-verify-'));
  await seededBundle(root);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('verifyBundle', () => {
  it('accepts an untouched bundle', async () => {
    expect((await verifyBundle(root)).ok).toBe(true);
  });

  it('detects a modified flow definition', async () => {
    await writeFile(
      join(root, 'flows', 'f1', 'versions', '1', 'definition.yaml'),
      'name: Tampered\n',
    );
    const result = await verifyBundle(root);
    expect(result.ok).toBe(false);
    expect(result.findings.some((f) => f.code === 'CONTENT_HASH_MISMATCH')).toBe(true);
  });

  it('detects a deleted file', async () => {
    await rm(join(root, 'flows', 'f1', 'versions', '1', 'definition.yaml'));
    expect((await verifyBundle(root)).ok).toBe(false);
  });

  it('detects a tampered manifest hash', async () => {
    const path = join(root, 'bundle-manifest.json');
    const manifest = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    manifest['contentHash'] = 'sha256:' + '0'.repeat(64);
    await writeFile(path, JSON.stringify(manifest));
    expect((await verifyBundle(root)).ok).toBe(false);
  });

  it('reports a missing manifest rather than throwing', async () => {
    await rm(join(root, 'bundle-manifest.json'));
    const result = await verifyBundle(root);
    expect(result.ok).toBe(false);
    expect(result.findings.some((f) => f.code === 'MANIFEST_MISSING')).toBe(true);
  });

  it('rejects a manifest that does not satisfy the published schema', async () => {
    const path = join(root, 'bundle-manifest.json');
    const manifest = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    manifest['classification'] = 'public';
    await writeFile(path, JSON.stringify(manifest));
    const result = await verifyBundle(root);
    expect(result.findings.some((f) => f.code === 'MANIFEST_SCHEMA_INVALID')).toBe(true);
  });

  it('never includes bundle content in a finding message', async () => {
    await writeFile(
      join(root, 'flows', 'f1', 'versions', '1', 'definition.yaml'),
      'name: SECRET-CUSTOMER\n',
    );
    const result = await verifyBundle(root);
    expect(JSON.stringify(result)).not.toContain('SECRET-CUSTOMER');
  });
});
