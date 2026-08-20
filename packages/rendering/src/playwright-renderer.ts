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
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
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
  addScriptTag(options: { content: string }): Promise<unknown>;
  evaluate<T>(fn: (arg: string) => T | Promise<T>, arg: string): Promise<T>;
}
interface PlaywrightBrowser {
  newPage(): Promise<PlaywrightPage>;
  close(): Promise<void>;
}
interface PlaywrightBrowserType {
  launch(options?: { headless?: boolean }): Promise<PlaywrightBrowser>;
}

let cachedBundle: string | null = null;

/**
 * Reads Mermaid's browser bundle from node_modules once per process.
 *
 * `securityLevel: 'strict'` is set at initialize time, but the primary
 * defence against hostile diagram text is escapeMermaidLabel in
 * packages/documentation, applied before source ever reaches here.
 */
async function readMermaidBundle(): Promise<string> {
  if (cachedBundle !== null) return cachedBundle;
  const require = createRequire(import.meta.url);
  const packageJsonPath = require.resolve('mermaid/package.json');
  const bundlePath = join(dirname(packageJsonPath), 'dist', 'mermaid.min.js');
  cachedBundle = await readFile(bundlePath, 'utf8');
  return cachedBundle;
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

  /**
   * Renders Mermaid source to SVG inside the page.
   *
   * The Mermaid bundle is read from `node_modules` and injected as inline
   * script content. It is deliberately NOT loaded from a CDN: the design
   * requires Stage 2 to open no sockets, and a documentation run that
   * silently reached the network would break that guarantee for every
   * customer whose configuration it is rendering.
   *
   * `startOnLoad` is false and the source is passed as an argument rather
   * than written into the page, so tenant-authored diagram text is never
   * interpolated into HTML.
   */
  async renderSvg(mermaidSource: string): Promise<string> {
    const bundle = await readMermaidBundle();
    const browser = await this.browserType.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent('<!doctype html><html><body></body></html>', { waitUntil: 'load' });
      await page.addScriptTag({ content: bundle });
      return await page.evaluate(async (source: string) => {
        const globalWithMermaid = globalThis as unknown as {
          mermaid: {
            initialize(config: Record<string, unknown>): void;
            render(id: string, text: string): Promise<{ svg: string }>;
          };
        };
        globalWithMermaid.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
        const { svg } = await globalWithMermaid.mermaid.render('archivist-diagram', source);
        return svg;
      }, mermaidSource);
    } finally {
      await browser.close();
    }
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
