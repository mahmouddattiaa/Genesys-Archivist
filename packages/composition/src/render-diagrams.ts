// packages/composition/src/render-diagrams.ts
//
// Renders the Mermaid sources in an already-written documents tree to SVG.
//
// Separate from documenting on purpose. `documentBundleToDisk` writes the
// `.mmd` sources in seconds; drawing them launches a headless browser and
// takes roughly eleven renders per flow, so a 502-flow organization is ~5,500
// renders and tens of minutes. Bundling the two meant nobody could have the
// fast one, and a developer who only wants to read `business.md` was paying
// for pictures they never opened.
//
// So: document first, decide about pictures afterwards. This is what
// `archivist render` calls, and what an MCP client should offer once a
// documentation set exists.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRenderer, type RendererBundle } from '@genesys-archivist/rendering';

export interface RenderDiagramsOptions {
  /** A documents tree, i.e. `<outputRoot>/documents` or a bundle directory. */
  readonly documentsDir: string;
  /** Injected so this is testable without a browser. */
  readonly renderer?: RendererBundle;
  /** Re-render sources that already have an `.svg` beside them. */
  readonly force?: boolean;
  /** Called after each diagram so a caller can report progress on a long run. */
  readonly onProgress?: (done: number, total: number) => void;
}

export interface RenderDiagramsResult {
  readonly found: number;
  readonly rendered: number;
  readonly skipped: number;
  /**
   * Sources that could not be drawn, with the reason.
   *
   * Reported, never omitted: a documentation set where three diagrams silently
   * failed to render looks identical to one where they rendered fine, and the
   * reader has no way to notice the difference.
   */
  readonly failed: readonly { readonly path: string; readonly reason: string }[];
  /** True if no real browser was available, so nothing could be drawn. */
  readonly rendererDegraded: boolean;
}

async function findMermaidSources(dir: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (current: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith('.mmd')) found.push(path);
    }
  };
  await walk(dir);
  // Deterministic order, so progress reporting and any partial run are
  // reproducible rather than dependent on directory iteration order.
  return found.sort();
}

export async function renderDiagrams(
  options: RenderDiagramsOptions,
): Promise<RenderDiagramsResult> {
  const sources = await findMermaidSources(options.documentsDir);
  const failed: { path: string; reason: string }[] = [];
  let rendered = 0;
  let skipped = 0;

  if (sources.length === 0) {
    return { found: 0, rendered: 0, skipped: 0, failed: [], rendererDegraded: false };
  }

  const renderer = options.renderer ?? (await createRenderer());

  // Ask the renderer, rather than inspecting what it returns.
  //
  // NullRenderer deliberately returns a *valid* placeholder SVG reading
  // "Diagram unavailable" -- correct for the automatic documentation path,
  // where a missing picture must not lose the Markdown beside it. It is wrong
  // here: someone running `archivist render` asked for pictures, and handing
  // them five thousand identical "unavailable" placeholders is worse than
  // telling them once that no browser is installed.
  //
  // `degraded` is the interface's own statement about itself, so this reads
  // it instead of guessing from the output shape.
  if (renderer.degraded) {
    return {
      found: sources.length,
      rendered: 0,
      skipped: 0,
      failed: sources.map((path) => ({
        path,
        reason: 'no browser available to render with',
      })),
      rendererDegraded: true,
    };
  }

  let degraded = false;

  for (const [index, source] of sources.entries()) {
    const target = source.replace(/\.mmd$/, '.svg');

    if (options.force !== true) {
      try {
        await readFile(target, 'utf8');
        skipped += 1;
        options.onProgress?.(index + 1, sources.length);
        continue;
      } catch {
        // No existing SVG: fall through and draw it.
      }
    }

    try {
      const svg = await renderer.diagram.renderSvg(await readFile(source, 'utf8'));
      // NullRenderer returns a placeholder rather than throwing, so anything
      // that is not actually SVG must not be written as though it were a
      // picture -- a file called `.svg` that no viewer can open is worse than
      // no file at all.
      if (svg.trimStart().startsWith('<svg')) {
        await writeFile(target, svg, 'utf8');
        rendered += 1;
      } else {
        degraded = true;
        failed.push({ path: source, reason: 'no browser available to render with' });
      }
    } catch {
      // The error is not echoed: Mermaid parse failures quote the source line,
      // and that line is tenant-authored flow content.
      failed.push({ path: source, reason: 'the diagram source could not be rendered' });
    }
    options.onProgress?.(index + 1, sources.length);
  }

  return { found: sources.length, rendered, skipped, failed, rendererDegraded: degraded };
}
