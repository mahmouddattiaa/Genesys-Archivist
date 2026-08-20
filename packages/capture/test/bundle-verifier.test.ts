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
    policy: {
      mode: 'migration' as const,
      versionSelection: 'published' as const,
      captureAssets: true,
      captureDataTableRows: true,
    },
    versions: { application: '0.1.0', adapter: '0.1.0', sourceProvider: 'fixture' },
    now: () => new Date('2026-08-20T14:31:00Z'),
  });
  await writer.writeFlow('f1', '1', 'name: Main\n', {
    id: 'f1',
    type: 'inboundcall',
    format: 'yaml',
  });
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

describe('verifyBundle: a bundle that actually contains an asset', () => {
  // Every case above seals a bundle with no assets in it, which is why a
  // one-character mismatch in the hashed asset digest survived: the writer
  // hashed the address it hands callers ("sha256:<hex>") while the verifier
  // could only reconstruct assets/index.json's own bare-hex keys. The two
  // forms never met, so no test noticed that every migration bundle -- the
  // only kind that carries assets -- failed its own verification.
  let assetRoot = '';

  beforeEach(async () => {
    assetRoot = await mkdtemp(join(tmpdir(), 'archivist-verify-asset-'));
    const writer = new BundleWriter({
      root: assetRoot,
      captureId: '2026-08-21T09-00-00Z_asset1',
      organization: { id: 'org_1', region: 'mec1' },
      policy: {
        mode: 'migration' as const,
        versionSelection: 'published' as const,
        captureAssets: true,
        captureDataTableRows: true,
      },
      versions: { application: '0.1.0', adapter: '0.1.0', sourceProvider: 'fixture' },
      now: () => new Date('2026-08-21T09:00:00Z'),
    });
    await writer.writeFlow('f1', '1', 'name: Main\n', {
      id: 'f1',
      type: 'inboundcall',
      format: 'yaml',
    });
    await writer.putAsset(new Uint8Array([1, 2, 3, 4, 5]), {
      originalName: 'greeting-en-us.wav',
      mimeType: 'audio/wav',
      usedBy: { type: 'userPrompt', id: 'p1' },
    });
    await writer.seal();
  });

  afterEach(async () => {
    await rm(assetRoot, { recursive: true, force: true });
  });

  it('verifies a sealed bundle containing an asset', async () => {
    const result = await verifyBundle(assetRoot);
    expect(result.ok, JSON.stringify(result.findings)).toBe(true);
  });

  it('still detects a tampered asset index', async () => {
    const indexPath = join(assetRoot, 'assets', 'index.json');
    const index = JSON.parse(await readFile(indexPath, 'utf8')) as Record<string, unknown>;
    const first = Object.keys(index)[0]!;
    (index[first] as Record<string, unknown>)['byteLength'] = 999999;
    await writeFile(indexPath, JSON.stringify(index));
    expect((await verifyBundle(assetRoot)).ok).toBe(false);
  });

  it('records the same digest form the index is keyed by', async () => {
    // The concrete shape of the bug: a bare-hex key, never "sha256:"-prefixed.
    const index = JSON.parse(
      await readFile(join(assetRoot, 'assets', 'index.json'), 'utf8'),
    ) as Record<string, unknown>;
    for (const key of Object.keys(index)) {
      expect(key).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
