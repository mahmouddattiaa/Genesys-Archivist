// packages/rendering/src/renderer.ts
// Shared interfaces for the rendering package. `packages/documentation` and
// `apps/cli` depend on these interfaces only, never on a concrete renderer,
// so the headless-browser dependency stays isolated behind this seam.

/** Metadata attached to a rendered PDF document. */
export interface PdfMeta {
  readonly title: string;
}

/** Renders Mermaid diagram source to an SVG string. */
export interface DiagramRenderer {
  renderSvg(mermaid: string): Promise<string>;
}

/** Renders an HTML document to a PDF byte stream. */
export interface DocumentRenderer {
  renderPdf(html: string, meta: PdfMeta): Promise<Uint8Array>;
}

/** The pair of renderers a caller needs, plus whether they are degraded. */
export interface RendererBundle {
  readonly diagram: DiagramRenderer;
  readonly document: DocumentRenderer;
  readonly degraded: boolean;
}

/** Options controlling how {@link createRenderer} probes for a browser. */
export interface CreateRendererOptions {
  /**
   * Skip the Playwright probe entirely and return the degraded
   * {@link NullRenderer} pair. Used by tests and by callers that already
   * know a browser will not be available (e.g. a sandboxed environment).
   */
  readonly forceDegraded?: boolean;
}
