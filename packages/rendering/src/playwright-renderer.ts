// packages/rendering/src/playwright-renderer.ts
// The real renderer, backed by a headless Chromium instance. Mermaid source
// has no meaning outside a DOM -- it is parsed and laid out by JavaScript
// running against a document -- which is why this goes through a browser
// rather than a pure Node library (see docs/superpowers/specs
// /2026-08-20-genesys-archivist-design.md ADR-008).
//
// `createRenderer` is the only supported way to obtain a renderer pair. It
// never throws: it probes for a working Playwright installation and falls
// back to `NullRenderer`, reporting `degraded: true`, on any failure --
// package not installed, browser binary not downloaded, launch refused,
// sandbox restriction. Per docs/08-failure-analysis.md, diagram rendering
// failure must never block tabular documentation.
import { NullRenderer } from './null-renderer.js';
import type {
  CreateRendererOptions,
  DiagramRenderer,
  DocumentRenderer,
  PdfMeta,
  RendererBundle,
} from './renderer.js';

// Structurally typed against playwright's chromium export so this module
// compiles even when 'playwright' is an optional peer that may not resolve
// in every environment. The dynamic `import('playwright')` inside
// `createRenderer` is what actually decides, at runtime, whether the
// dependency is present.
interface PlaywrightPage {
  setContent(html: string, options?: { waitUntil?: 'load' }): Promise<void>;
  pdf(options?: { printBackground?: boolean }): Promise<Uint8Array>;
}
interface PlaywrightBrowser {
  newPage(): Promise<PlaywrightPage>;
  close(): Promise<void>;
}
interface PlaywrightBrowserType {
  launch(options?: { headless?: boolean }): Promise<PlaywrightBrowser>;
}

/**
 * Renders through a real, headless Chromium instance launched on demand.
 * Each call launches its own browser and closes it in a `finally` block, so
 * no call ever leaves an orphaned browser process behind -- there is no
 * `close`/`dispose` method on {@link DiagramRenderer} or
 * {@link DocumentRenderer} for a caller to invoke.
 */
export class PlaywrightRenderer implements DiagramRenderer, DocumentRenderer {
  constructor(private readonly browserType: PlaywrightBrowserType) {}

  renderSvg(mermaid: string): Promise<string> {
    // Mermaid-to-SVG conversion needs the `mermaid` package loaded into the
    // page's DOM to parse and lay out the diagram source. That package is
    // not yet a dependency of this package -- this task adds Playwright
    // only, per the plan -- so real diagram rendering is deferred to the
    // task that adds `mermaid`. Failing loudly here (rather than returning
    // a placeholder, which is NullRenderer's job) keeps the gap honest
    // instead of silently pretending the diagram rendered.
    void mermaid;
    return Promise.reject(
      new Error(
        'PlaywrightRenderer.renderSvg is not yet implemented: the "mermaid" package ' +
          'is not a dependency of @genesys-archivist/rendering. Use createRenderer() ' +
          'and its NullRenderer fallback, or add mermaid rendering in a follow-up task.',
      ),
    );
  }

  async renderPdf(html: string, meta: PdfMeta): Promise<Uint8Array> {
    const browser = await this.browserType.launch({ headless: true });
    try {
      const page = await browser.newPage();
      // meta.title documents intent for the caller-visible PDF title; the
      // document <title> itself belongs in the supplied HTML, produced by
      // packages/documentation from already-escaped tenant content.
      void meta;
      await page.setContent(html, { waitUntil: 'load' });
      return await page.pdf({ printBackground: true });
    } finally {
      await browser.close();
    }
  }
}

/**
 * Always resolves. Probes for a working Playwright Chromium installation
 * and returns a `PlaywrightRenderer` pair when one is available, or the
 * `NullRenderer` pair -- with `degraded: true` -- on any failure.
 */
export async function createRenderer(options?: CreateRendererOptions): Promise<RendererBundle> {
  if (options?.forceDegraded === true) {
    return degradedBundle();
  }

  try {
    const playwright = (await import('playwright')) as {
      chromium: PlaywrightBrowserType;
    };
    const probe = await playwright.chromium.launch({ headless: true });
    await probe.close();

    const renderer = new PlaywrightRenderer(playwright.chromium);
    return { diagram: renderer, document: renderer, degraded: false };
  } catch {
    // Not installed, browser binary absent, launch refused, sandbox
    // restriction -- every failure mode collapses to the same degraded,
    // never-throws outcome.
    return degradedBundle();
  }
}

function degradedBundle(): RendererBundle {
  const nullRenderer = new NullRenderer();
  return { diagram: nullRenderer, document: nullRenderer, degraded: true };
}
