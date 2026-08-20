import { mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BundleWriter } from '../src/bundle-writer.js';
import { verifyBundle } from '../src/bundle-verifier.js';

/**
 * An adversarial sweep over the verifier.
 *
 * A verifier that returns `ok: true` for everything is worse than no verifier
 * at all: it manufactures confidence in a bundle nobody actually checked. The
 * per-feature tests confirm the tampering their author thought of. This asks
 * whether a range of *different* modifications — some of them subtle, some of
 * them not obviously touching the hashed content — are each caught.
 *
 * Written against the public API only, without reading the verifier's
 * implementation first, so it does not accidentally test the same path twice.
 */
const created: string[] = [];

const freshRoot = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'archivist-tamper-'));
  created.push(dir);
  return dir;
};

let root = '';

const opts = (dir: string) => ({
  root: dir,
  captureId: '2026-08-20T14-02-11Z_a1b2c3',
  organization: { id: 'org_1', region: 'euw1' },
  policy: {
    mode: 'migration' as const,
    versionSelection: 'published' as const,
    captureAssets: true,
    captureDataTableRows: true,
  },
  versions: { application: '0.1.0', adapter: '0.1.0', sourceProvider: 'fixture' as const },
  now: () => new Date('2026-08-20T14:31:00Z'),
});

/** A bundle with enough in it that tampering has somewhere to hide. */
async function buildBundle(dir: string): Promise<void> {
  const writer = new BundleWriter(opts(dir));
  await writer.writeFlow('f1', '4.0', 'name: Main Menu\n', {
    id: 'f1',
    type: 'inboundcall',
    format: 'yaml',
  });
  await writer.writeFlow('f2', '2.0', 'name: After Hours\n', {
    id: 'f2',
    type: 'inboundcall',
    format: 'yaml',
  });
  await writer.writeResource('queues', 'q1', { id: 'q1', name: 'Support' });
  await writer.seal();
}

/** Every file in the bundle, relative to its root. */
async function walk(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await walk(join(dir, entry.name), rel)));
    else out.push(rel);
  }
  return out.sort();
}

beforeEach(async () => {
  root = await freshRoot();
  await buildBundle(root);
});

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('the verifier actually catches tampering', () => {
  it('accepts the bundle it was given, untouched', async () => {
    // The control. Without this, every assertion below is satisfied by a
    // verifier that simply always fails.
    const result = await verifyBundle(root);
    expect(result.ok, JSON.stringify(result.findings)).toBe(true);
  });

  it('catches a single flipped byte inside a flow definition', async () => {
    const files = (await walk(root)).filter((f) => f.endsWith('definition.yaml'));
    expect(files.length).toBeGreaterThan(0);
    const target = join(root, files[0] as string);
    const original = await readFile(target, 'utf8');
    await writeFile(target, original.replace('Main Menu', 'Main Menü'), 'utf8');
    expect((await verifyBundle(root)).ok).toBe(false);
  });

  it('catches a truncation of exactly one character', async () => {
    const files = (await walk(root)).filter((f) => f.endsWith('definition.yaml'));
    const target = join(root, files[0] as string);
    const original = await readFile(target, 'utf8');
    await writeFile(target, original.slice(0, -1), 'utf8');
    expect((await verifyBundle(root)).ok).toBe(false);
  });

  it('catches two flow definitions having their contents swapped', async () => {
    // Neither file is added or removed and the byte total is unchanged, so a
    // verifier that hashed a concatenation without binding content to its
    // path would happily accept this.
    const files = (await walk(root)).filter((f) => f.endsWith('definition.yaml'));
    expect(files.length).toBeGreaterThanOrEqual(2);
    const a = join(root, files[0] as string);
    const b = join(root, files[1] as string);
    const [contentA, contentB] = await Promise.all([readFile(a, 'utf8'), readFile(b, 'utf8')]);
    await writeFile(a, contentB, 'utf8');
    await writeFile(b, contentA, 'utf8');
    expect((await verifyBundle(root)).ok).toBe(false);
  });

  it('catches a resource file being deleted', async () => {
    const files = (await walk(root)).filter((f) => f.includes('queues'));
    expect(files.length).toBeGreaterThan(0);
    await rm(join(root, files[0] as string));
    expect((await verifyBundle(root)).ok).toBe(false);
  });

  it('catches the manifest being edited to match tampered content', async () => {
    // The interesting attack: change the content AND update the recorded
    // hash, so the manifest is self-consistent. Only recomputing from the
    // files on disk catches this.
    const files = (await walk(root)).filter((f) => f.endsWith('definition.yaml'));
    const target = join(root, files[0] as string);
    await writeFile(target, 'name: Replaced Entirely\n', 'utf8');

    const manifestPath = join(root, 'bundle-manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    manifest['contentHash'] = `sha256:${'b'.repeat(64)}`;
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    expect((await verifyBundle(root)).ok).toBe(false);
  });

  it('catches a manifest whose counts no longer describe the bundle', async () => {
    const manifestPath = join(root, 'bundle-manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    const counts = manifest['counts'] as Record<string, number>;
    counts['flows'] = (counts['flows'] ?? 0) + 40;
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    expect((await verifyBundle(root)).ok).toBe(false);
  });

  it('never echoes bundle content into a finding message', async () => {
    // Bundles are classified `restricted`. A verifier that quotes the
    // mismatching content into its finding writes customer routing logic,
    // DIDs, or data-table rows into whatever log catches the result.
    const canary = 'CANARY-CUSTOMER-DID-441632900000';
    const files = (await walk(root)).filter((f) => f.endsWith('definition.yaml'));
    await writeFile(join(root, files[0] as string), `name: ${canary}\n`, 'utf8');

    const result = await verifyBundle(root);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result.findings)).not.toContain(canary);
  });

  it('reports rather than throws when the directory is not a bundle at all', async () => {
    const empty = await freshRoot();
    const result = await verifyBundle(empty);
    expect(result.ok).toBe(false);
    expect(result.findings.length).toBeGreaterThan(0);
  });
});

describe('a context bundle can never be mistaken for a migration bundle', () => {
  // The whole risk of having two modes: someone hands a context bundle to the
  // migration server, which recreates an IVR whose prompts are silent and
  // whose queues do not exist. See docs/adr/ADR-018-capture-modes.md.
  const contextOpts = (dir: string) => ({
    ...opts(dir),
    policy: {
      mode: 'context' as const,
      versionSelection: 'published' as const,
      captureAssets: false,
      captureDataTableRows: false,
    },
  });

  it('declares itself not importable, however many flows it holds', async () => {
    const dir = await freshRoot();
    const writer = new BundleWriter(contextOpts(dir));
    // A migration bundle with these same flows WOULD be importable, so this
    // cannot be passing merely because the bundle is empty.
    await writer.writeFlow('f1', '4.0', 'name: Main Menu\n', {
      id: 'f1',
      type: 'inboundcall',
      format: 'yaml',
    });
    await writer.writeFlow('f2', '2.0', 'name: After Hours\n', {
      id: 'f2',
      type: 'inboundcall',
      format: 'yaml',
    });
    const sealed = await writer.seal();

    expect(sealed.manifest.policy.mode).toBe('context');
    expect(sealed.manifest.migrationReadiness?.archyImportableYaml).toBe(false);
    expect(sealed.manifest.migrationReadiness?.assetsCaptured).toBe(false);
  });

  it('says why, in words, not just in a boolean', async () => {
    const dir = await freshRoot();
    const writer = new BundleWriter(contextOpts(dir));
    await writer.writeFlow('f1', '4.0', 'name: Main Menu\n', {
      id: 'f1',
      type: 'inboundcall',
      format: 'yaml',
    });
    const sealed = await writer.seal();

    const caveats = sealed.manifest.migrationReadiness?.caveats ?? [];
    expect(caveats.join(' ')).toMatch(/context mode/i);
    expect(caveats.join(' ')).toMatch(/cannot be migrated|recapture/i);
  });

  it('the same flows in migration mode ARE importable', async () => {
    // The control. Without it, the assertions above are satisfied by a writer
    // that reports nothing as importable, ever.
    const dir = await freshRoot();
    const writer = new BundleWriter(opts(dir));
    await writer.writeFlow('f1', '4.0', 'name: Main Menu\n', {
      id: 'f1',
      type: 'inboundcall',
      format: 'yaml',
    });
    const sealed = await writer.seal();

    expect(sealed.manifest.policy.mode).toBe('migration');
    expect(sealed.manifest.migrationReadiness?.archyImportableYaml).toBe(true);
  });

  it('still seals and verifies as a valid bundle', async () => {
    const dir = await freshRoot();
    const writer = new BundleWriter(contextOpts(dir));
    await writer.writeFlow('f1', '4.0', 'name: Main Menu\n', {
      id: 'f1',
      type: 'inboundcall',
      format: 'yaml',
    });
    await writer.seal();
    const result = await verifyBundle(dir);
    expect(result.ok, JSON.stringify(result.findings)).toBe(true);
  });
});
