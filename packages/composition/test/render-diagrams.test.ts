// packages/composition/test/render-diagrams.test.ts
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRenderer, type RendererBundle } from '@genesys-archivist/rendering';
import { renderDiagrams } from '../src/render-diagrams.js';

let root = '';
const MERMAID = 'flowchart TD\n  A["Start"] --> B["End"]\n';

/** A renderer that returns real-looking SVG without a browser. */
function fakeRenderer(onRender?: (source: string) => void): RendererBundle {
  return {
    degraded: false,
    diagram: {
      renderSvg: (source: string) => {
        onRender?.(source);
        return Promise.resolve('<svg id="fake"><g/></svg>');
      },
    },
    document: { renderPdf: () => Promise.resolve(new Uint8Array()) },
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'archivist-render-'));
  await mkdir(join(root, 'ivrs', 'a-flow-1', '1.0', 'diagrams'), { recursive: true });
  await mkdir(join(root, 'ivrs', 'b-flow-2', '1.0', 'diagrams'), { recursive: true });
  await writeFile(join(root, 'ivrs', 'a-flow-1', '1.0', 'diagrams', 'diagram-1.mmd'), MERMAID);
  await writeFile(join(root, 'ivrs', 'a-flow-1', '1.0', 'diagrams', 'diagram-2.mmd'), MERMAID);
  await writeFile(join(root, 'ivrs', 'b-flow-2', '1.0', 'diagrams', 'diagram-1.mmd'), MERMAID);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('renderDiagrams', () => {
  it('draws every Mermaid source it finds, at any depth', async () => {
    const result = await renderDiagrams({ documentsDir: root, renderer: fakeRenderer() });
    expect(result.found).toBe(3);
    expect(result.rendered).toBe(3);
    expect(result.failed).toHaveLength(0);
    const svg = await readFile(
      join(root, 'ivrs', 'a-flow-1', '1.0', 'diagrams', 'diagram-1.svg'),
      'utf8',
    );
    expect(svg.startsWith('<svg')).toBe(true);
  });

  it('skips sources already drawn, so a re-run is cheap', async () => {
    await renderDiagrams({ documentsDir: root, renderer: fakeRenderer() });
    const second = await renderDiagrams({ documentsDir: root, renderer: fakeRenderer() });
    expect(second.rendered).toBe(0);
    expect(second.skipped).toBe(3);
  });

  it('re-draws everything when forced', async () => {
    await renderDiagrams({ documentsDir: root, renderer: fakeRenderer() });
    const forced = await renderDiagrams({
      documentsDir: root,
      renderer: fakeRenderer(),
      force: true,
    });
    expect(forced.rendered).toBe(3);
    expect(forced.skipped).toBe(0);
  });

  it('never writes a .svg the degraded renderer could not actually draw', async () => {
    // NullRenderer returns a placeholder rather than throwing. A file named
    // .svg that no viewer can open is worse than no file at all.
    const degraded = await createRenderer({ forceDegraded: true });
    const result = await renderDiagrams({ documentsDir: root, renderer: degraded });
    expect(result.rendered).toBe(0);
    expect(result.rendererDegraded).toBe(true);
    await expect(
      readFile(join(root, 'ivrs', 'a-flow-1', '1.0', 'diagrams', 'diagram-1.svg'), 'utf8'),
    ).rejects.toThrow();
  });

  it('reports a diagram it could not draw instead of dropping it', async () => {
    const failing: RendererBundle = {
      degraded: false,
      diagram: { renderSvg: () => Promise.reject(new Error('parse error near line 2')) },
      document: { renderPdf: () => Promise.resolve(new Uint8Array()) },
    };
    const result = await renderDiagrams({ documentsDir: root, renderer: failing });
    expect(result.failed).toHaveLength(3);
    expect(result.rendered).toBe(0);
  });

  it('never echoes the diagram source into a failure reason', async () => {
    // Mermaid parse errors quote the offending line, and that line is
    // tenant-authored flow content.
    const canary = 'CANARY-TENANT-TEXT-5d84';
    await writeFile(
      join(root, 'ivrs', 'a-flow-1', '1.0', 'diagrams', 'diagram-1.mmd'),
      `flowchart TD\n  A["${canary}"] --> B\n`,
    );
    const failing: RendererBundle = {
      degraded: false,
      diagram: { renderSvg: (s: string) => Promise.reject(new Error(`bad source: ${s}`)) },
      document: { renderPdf: () => Promise.resolve(new Uint8Array()) },
    };
    const result = await renderDiagrams({ documentsDir: root, renderer: failing });
    expect(JSON.stringify(result)).not.toContain(canary);
  });

  it('reports nothing found rather than failing on a tree with no diagrams', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'archivist-render-empty-'));
    try {
      const result = await renderDiagrams({ documentsDir: empty, renderer: fakeRenderer() });
      expect(result.found).toBe(0);
      expect(result.failed).toHaveLength(0);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it('is deterministic in the order it renders', async () => {
    const seen: string[] = [];
    await renderDiagrams({
      documentsDir: root,
      renderer: fakeRenderer(),
      onProgress: (done) => seen.push(String(done)),
    });
    expect(seen).toEqual(['1', '2', '3']);
  });
});
