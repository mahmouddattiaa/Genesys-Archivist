import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BundleWriter } from '@genesys-archivist/capture';
import { documentBundle } from '../src/document-bundle.js';

/**
 * The seam between the two stages.
 *
 * Stage 1 seals a bundle; Stage 2 reads one. Every test on either side passes
 * while the seam is broken, because each side is exercised against its own
 * fixture rather than against the other's output. That is exactly how the
 * format got lost: capture stored whatever the provider returned into a file
 * named `definition.yaml`, and nothing ever read a real bundle back.
 */
const created: string[] = [];
let bundleDir = '';
let realConfig: string;

const freshDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'archivist-seam-'));
  created.push(dir);
  return dir;
};

const writerOptions = (dir: string) => ({
  root: dir,
  captureId: '2026-08-20T14-02-11Z_a1b2c3',
  organization: { id: 'org_1', region: 'euw1' },
  policy: {
    mode: 'context' as const,
    versionSelection: 'published' as const,
    captureAssets: false,
    captureDataTableRows: false,
  },
  versions: { application: '0.1.0', adapter: '0.1.0', sourceProvider: 'fixture' as const },
  now: () => new Date('2026-08-20T14:31:00Z'),
});

beforeEach(async () => {
  realConfig = await readFile('fixtures/flow-config/inboundcall-47-nodes.json', 'utf8');
  bundleDir = await freshDir();
});

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('documentBundle', () => {
  it('documents a JSON flow definition captured into a bundle', async () => {
    const writer = new BundleWriter(writerOptions(bundleDir));
    await writer.writeFlow('f1', '4.0', realConfig, {
      id: 'f1',
      type: 'inboundcall',
      format: 'json',
    });
    await writer.seal();

    const result = await documentBundle({
      bundleDir,
      generatedAt: '2026-08-20T00:00:00Z',
    });

    expect(result.skipped, JSON.stringify(result.skipped)).toHaveLength(0);
    expect(result.documented).toHaveLength(1);

    const paths = Object.keys(result.files);
    // Derived, not spelled out: the directory is a slug of the flow's own name
    // plus a short id, so a literal path here would break on a fixture rename
    // while testing nothing the endsWith checks do not.
    const dir = paths.find((path) => path.endsWith('/business.md'))?.replace(/\/[^/]+$/, '');
    expect(dir, JSON.stringify(paths)).toBeDefined();
    expect(dir).toMatch(/^ivrs\/[a-z0-9-]+\/4\.0$/);
    expect(paths).toContain(`${dir ?? ''}/technical.md`);
    expect(paths).toContain(`${dir ?? ''}/operations.md`);
    expect(paths).toContain(`${dir ?? ''}/index.md`);
    expect(paths.some((p) => p.endsWith('.mmd'))).toBe(true);

    // The documents describe the real flow, not an empty shell: the reference
    // configuration has 47 nodes and two variables read but never written.
    expect(result.files[`${dir ?? ''}/technical.md`]).toContain('47');
    expect(result.files[`${dir ?? ''}/business.md`]).toMatch(/read but never written/i);
  });

  it('keeps each flow in its own directory', async () => {
    const writer = new BundleWriter(writerOptions(bundleDir));
    await writer.writeFlow('f1', '4.0', realConfig, {
      id: 'f1',
      type: 'inboundcall',
      format: 'json',
    });
    await writer.writeFlow('f2', '1.0', realConfig, {
      id: 'f2',
      type: 'inboundcall',
      format: 'json',
    });
    await writer.seal();

    const result = await documentBundle({ bundleDir, generatedAt: '2026-08-20T00:00:00Z' });
    expect(result.documented).toHaveLength(2);
    // Two flows sharing one fixture share a display name, so this also proves
    // the short-id suffix keeps them apart rather than one overwriting the other.
    const dirs = new Set(
      Object.keys(result.files)
        .filter((path) => path.endsWith('/business.md'))
        .map((path) => path.replace(/\/[^/]+$/, '')),
    );
    expect(dirs.size, [...dirs].join(', ')).toBe(2);
    expect([...dirs].every((d) => d.startsWith('ivrs/'))).toBe(true);
  });

  it('reports a flow it could not document instead of omitting it', async () => {
    // A documentation set that silently covers one of two flows is worse than
    // one that covers one and says so: the reader cannot notice the absence.
    const writer = new BundleWriter(writerOptions(bundleDir));
    await writer.writeFlow('good', '1.0', realConfig, {
      id: 'good',
      type: 'inboundcall',
      format: 'json',
    });
    await writer.writeFlow('broken', '1.0', 'this is not a flow configuration', {
      id: 'broken',
      type: 'inboundcall',
      format: 'json',
    });
    await writer.seal();

    const result = await documentBundle({ bundleDir, generatedAt: '2026-08-20T00:00:00Z' });
    expect(result.documented.map((d) => d.flowId)).toEqual(['good']);
    expect(result.skipped.map((s) => s.flowId)).toEqual(['broken']);
    expect(result.skipped[0]?.reason.length).toBeGreaterThan(0);
  });

  it('never echoes the definition into a skip reason', async () => {
    // Flow definitions are tenant-authored and a parser will happily quote the
    // line it choked on. Bundles are classified restricted.
    const canary = 'CANARY-CUSTOMER-DID-441632900000';
    const writer = new BundleWriter(writerOptions(bundleDir));
    await writer.writeFlow('broken', '1.0', `{ not json ${canary}`, {
      id: 'broken',
      type: 'inboundcall',
      format: 'json',
    });
    await writer.seal();

    const result = await documentBundle({ bundleDir, generatedAt: '2026-08-20T00:00:00Z' });
    expect(result.skipped).toHaveLength(1);
    expect(JSON.stringify(result.skipped)).not.toContain(canary);
  });

  it('takes the organization from the bundle manifest', async () => {
    const writer = new BundleWriter(writerOptions(bundleDir));
    await writer.writeFlow('f1', '4.0', realConfig, {
      id: 'f1',
      type: 'inboundcall',
      format: 'json',
    });
    await writer.seal();

    const result = await documentBundle({ bundleDir, generatedAt: '2026-08-20T00:00:00Z' });
    const technical = Object.entries(result.files).find(([path]) =>
      path.endsWith('/technical.md'),
    )?.[1];
    expect(technical).toContain('org_1');
  });

  it('is deterministic', async () => {
    const writer = new BundleWriter(writerOptions(bundleDir));
    await writer.writeFlow('f1', '4.0', realConfig, {
      id: 'f1',
      type: 'inboundcall',
      format: 'json',
    });
    await writer.seal();

    const a = await documentBundle({ bundleDir, generatedAt: '2026-08-20T00:00:00Z' });
    const b = await documentBundle({ bundleDir, generatedAt: '2026-08-20T00:00:00Z' });
    expect(JSON.stringify(a.files)).toBe(JSON.stringify(b.files));
  });

  it('returns empty rather than throwing on a directory that is not a bundle', async () => {
    const empty = await freshDir();
    const result = await documentBundle({ bundleDir: empty, generatedAt: '2026-08-20T00:00:00Z' });
    expect(result.documented).toHaveLength(0);
    expect(Object.keys(result.files)).toHaveLength(0);
  });
});
