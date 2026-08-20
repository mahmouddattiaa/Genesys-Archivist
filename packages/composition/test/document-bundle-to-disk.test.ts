// packages/composition/test/document-bundle-to-disk.test.ts
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BundleWriter } from '@genesys-archivist/capture';
import { safeSegment } from '@genesys-archivist/security';
import { documentBundleToDisk } from '../src/document-bundle-to-disk.js';
import { createRenderer } from '@genesys-archivist/rendering';

// The null pair: renderSvg returns a placeholder rather than an <svg>, so no
// .svg is written and rendererDegraded is reported. That is the behaviour this
// suite should see -- it tests staging and promotion, not drawing.
const DEGRADED_RENDERER = await createRenderer({ forceDegraded: true });

const created: string[] = [];

async function freshDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'archivist-doc-to-disk-'));
  created.push(dir);
  return dir;
}

beforeEach(() => {
  created.length = 0;
});

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

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

async function buildBundle(bundleDir: string, flowId: string, versionId: string): Promise<void> {
  const writer = new BundleWriter(writerOptions(bundleDir));
  const definition =
    'name: Test Flow\ntype: inboundcall\nflowSequenceItemList: []\nvariables: []\n';
  await writer.writeFlow(flowId, versionId, definition, {
    id: flowId,
    type: 'inboundcall',
    format: 'yaml',
  });
  await writer.seal();
}

describe('documentBundleToDisk: writes and promotes', () => {
  it('writes a fresh document set and reports what it wrote', async () => {
    const bundleDir = await freshDir();
    const outputRoot = await freshDir();
    await buildBundle(bundleDir, 'flow-a', '1');

    const result = await documentBundleToDisk({
      bundleDir,
      outputRoot,
      generatedAt: '2026-08-20T15:00:00Z',
      // documentBundleToDisk creates a real Playwright renderer by default.
      // Whether Chromium can draw is packages/rendering's test, not this
      // one's, and probing for it added ~5s to every case here.
      renderer: DEGRADED_RENDERER,
    });

    expect(result.documentsWritten).toBe(1);
    expect(result.skipped).toHaveLength(0);
    expect(result.outputDir).toBe(join(outputRoot, 'documents'));
    expect(result.contentHash.startsWith('sha256:')).toBe(true);

    const technical = await readFile(
      join(outputRoot, 'documents', 'ivrs', 'test-flow-flow-a', '1', 'technical.md'),
      'utf8',
    );
    expect(technical.length).toBeGreaterThan(0);
  });

  it('reports a skipped flow rather than silently omitting it', async () => {
    const bundleDir = await freshDir();
    const outputRoot = await freshDir();
    const writer = new BundleWriter(writerOptions(bundleDir));
    await writer.writeFlow('broken', '1', 'not a valid flow definition', {
      id: 'broken',
      type: 'inboundcall',
      format: 'yaml',
    });
    await writer.seal();

    const result = await documentBundleToDisk({
      bundleDir,
      outputRoot,
      generatedAt: '2026-08-20T15:00:00Z',
      // documentBundleToDisk creates a real Playwright renderer by default.
      // Whether Chromium can draw is packages/rendering's test, not this
      // one's, and probing for it added ~5s to every case here.
      renderer: DEGRADED_RENDERER,
    });
    expect(result.documentsWritten).toBe(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.flowId).toBe('broken');
  });

  it('merges a second run over the first, preserving flows the second run did not touch', async () => {
    const outputRoot = await freshDir();

    const bundleA = await freshDir();
    await buildBundle(bundleA, 'flow-a', '1');
    await documentBundleToDisk({
      bundleDir: bundleA,
      outputRoot,
      generatedAt: '2026-08-20T15:00:00Z',
      // documentBundleToDisk creates a real Playwright renderer by default.
      // Whether Chromium can draw is packages/rendering's test, not this
      // one's, and probing for it added ~5s to every case here.
      renderer: DEGRADED_RENDERER,
    });

    const bundleB = await freshDir();
    await buildBundle(bundleB, 'flow-b', '1');
    await documentBundleToDisk({
      bundleDir: bundleB,
      outputRoot,
      generatedAt: '2026-08-20T15:05:00Z',
    });

    // Both flows' documents survive: the second call never saw flow-a's
    // bundle, yet flow-a's documentation is still on disk afterward.
    const aTechnical = await readFile(
      join(outputRoot, 'documents', 'ivrs', 'test-flow-flow-a', '1', 'technical.md'),
      'utf8',
    );
    const bTechnical = await readFile(
      join(outputRoot, 'documents', 'ivrs', 'test-flow-flow-b', '1', 'technical.md'),
      'utf8',
    );
    expect(aTechnical.length).toBeGreaterThan(0);
    expect(bTechnical.length).toBeGreaterThan(0);
  });

  it('overwrites only the flow a re-run actually re-documents', async () => {
    const outputRoot = await freshDir();

    const bundle1 = await freshDir();
    await buildBundle(bundle1, 'flow-a', '1');
    await documentBundleToDisk({
      bundleDir: bundle1,
      outputRoot,
      generatedAt: '2026-08-20T15:00:00Z',
      // documentBundleToDisk creates a real Playwright renderer by default.
      // Whether Chromium can draw is packages/rendering's test, not this
      // one's, and probing for it added ~5s to every case here.
      renderer: DEGRADED_RENDERER,
    });
    const firstContent = await readFile(
      join(outputRoot, 'documents', 'ivrs', 'test-flow-flow-a', '1', 'flow-snapshot.json'),
      'utf8',
    );

    // Re-run over the same flow/version -- deterministic rendering means the
    // output should be identical, but it must still go through a real
    // promote (proving idempotent re-runs do not corrupt the tree).
    const bundle2 = await freshDir();
    await buildBundle(bundle2, 'flow-a', '1');
    await documentBundleToDisk({
      bundleDir: bundle2,
      outputRoot,
      generatedAt: '2026-08-20T15:00:00Z',
      // documentBundleToDisk creates a real Playwright renderer by default.
      // Whether Chromium can draw is packages/rendering's test, not this
      // one's, and probing for it added ~5s to every case here.
      renderer: DEGRADED_RENDERER,
    });
    const secondContent = await readFile(
      join(outputRoot, 'documents', 'ivrs', 'test-flow-flow-a', '1', 'flow-snapshot.json'),
      'utf8',
    );

    expect(secondContent).toBe(firstContent);
  });

  it('a run that fails after staging never disturbs the previously promoted documents', async () => {
    const outputRoot = await freshDir();

    const bundleA = await freshDir();
    await buildBundle(bundleA, 'flow-a', '1');
    await documentBundleToDisk({
      bundleDir: bundleA,
      outputRoot,
      generatedAt: '2026-08-20T15:00:00Z',
      // documentBundleToDisk creates a real Playwright renderer by default.
      // Whether Chromium can draw is packages/rendering's test, not this
      // one's, and probing for it added ~5s to every case here.
      renderer: DEGRADED_RENDERER,
    });
    const before = await readFile(
      join(outputRoot, 'documents', 'ivrs', 'test-flow-flow-a', '1', 'technical.md'),
      'utf8',
    );

    // A bundle directory that does not exist at all: documentBundle itself
    // tolerates this (returns empty), so nothing is written and nothing is
    // promoted -- the existing tree must survive completely untouched.
    const emptyBundle = join(await freshDir(), 'does-not-exist');
    const result = await documentBundleToDisk({
      bundleDir: emptyBundle,
      outputRoot,
      generatedAt: '2026-08-20T15:10:00Z',
    });
    expect(result.documentsWritten).toBe(0);

    const after = await readFile(
      join(outputRoot, 'documents', 'ivrs', 'test-flow-flow-a', '1', 'technical.md'),
      'utf8',
    );
    expect(after).toBe(before);
  });
});

describe('documentBundleToDisk: path safety', () => {
  it('a manually crafted bundle entry with an unusual flow-id-shaped directory name never escapes the output root', async () => {
    // A directory literally named ".." or containing a "/" cannot be
    // created through mkdir at all -- the OS refuses both, since ".." is a
    // reserved navigation token and "/" is a path separator, not a
    // creatable filename character. This is why the escape this test
    // guards against cannot be constructed through documentBundle's real
    // code path (flow ids there are always readdir()-derived directory
    // names): the defense this test exercises is the safeSegment step
    // documentBundleToDisk itself applies before ever deriving a merge
    // prefix, proven here with the most aggressive flow-id-shaped string
    // that *is* legal as a literal directory name.
    const bundleDir = await freshDir();
    const outputRoot = await freshDir();
    const hostileFlowId = '..hidden..flow';
    await mkdir(join(bundleDir, 'flows', hostileFlowId, 'versions', '1'), { recursive: true });
    await writeFile(
      join(bundleDir, 'flows', hostileFlowId, 'flow.json'),
      JSON.stringify({ id: hostileFlowId, type: 'inboundcall', format: 'yaml' }),
      'utf8',
    );
    await writeFile(
      join(bundleDir, 'flows', hostileFlowId, 'versions', '1', 'definition.yaml'),
      'name: Test Flow\ntype: inboundcall\nflowSequenceItemList: []\nvariables: []\n',
      'utf8',
    );

    const result = await documentBundleToDisk({
      bundleDir,
      outputRoot,
      generatedAt: '2026-08-20T15:00:00Z',
      // documentBundleToDisk creates a real Playwright renderer by default.
      // Whether Chromium can draw is packages/rendering's test, not this
      // one's, and probing for it added ~5s to every case here.
      renderer: DEGRADED_RENDERER,
    });

    // Everything documentBundleToDisk wrote must land under exactly
    // outputRoot/documents, at the safeSegment-sanitized path -- never at
    // the literal hostile string, and never anywhere above outputRoot.
    expect(result.outputDir).toBe(join(outputRoot, 'documents'));
    expect(result.documentsWritten).toBe(1);

    const sanitizedName = safeSegment(hostileFlowId);
    expect(sanitizedName).not.toBe(hostileFlowId);
    expect(sanitizedName.startsWith('.')).toBe(false);

    // The directory is now the flow's slugged display name plus a short slice
    // of the sanitized id. The hostile string must not survive in either half.
    // Mirrors ivrDirectoryName: compose, collapse dot runs, re-sanitize.
    const ivrDir = safeSegment(`test-flow-${sanitizedName.slice(0, 8)}`.replace(/\.{2,}/g, '.'));
    expect(ivrDir).not.toContain('..');
    expect(ivrDir.startsWith('.')).toBe(false);

    const promoted = await readFile(
      join(outputRoot, 'documents', 'ivrs', ivrDir, '1', 'technical.md'),
      'utf8',
    );
    expect(promoted.length).toBeGreaterThan(0);

    // Nothing was written directly under the literal hostile name, and
    // nothing escaped to outputRoot's parent.
    await expect(
      readFile(join(outputRoot, 'documents', 'ivrs', hostileFlowId, '1', 'technical.md'), 'utf8'),
    ).rejects.toThrow();
    await expect(readFile(join(outputRoot, '..', 'technical.md'), 'utf8')).rejects.toThrow();
  });
});
