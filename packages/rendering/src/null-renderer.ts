// packages/rendering/src/null-renderer.ts
// The supported degraded-mode renderer, per docs/08-failure-analysis.md:
// "Diagram too complex -> split or omit diagram and retain tables." A capture
// that produces correct Markdown and no SVG is a success with a warning; a
// renderer that throws because a browser is missing is a failure that loses
// real work. NullRenderer never throws.
import type { DiagramRenderer, DocumentRenderer, PdfMeta } from './renderer.js';

// A fixed placeholder. The Mermaid source that would have produced the real
// diagram is never interpolated into this string: that source is untrusted
// tenant content (flow names, expressions, prompt text), and echoing it into
// an SVG -- which a browser parses and executes as XML/HTML -- would turn a
// rendering fallback into an injection vector. Build from a template; never
// interpolate the input.
const PLACEHOLDER_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="120" role="img"',
  '     aria-label="Diagram unavailable">',
  '  <rect width="480" height="120" fill="#f4f4f5" stroke="#d4d4d8"/>',
  '  <text x="240" y="65" text-anchor="middle" font-family="sans-serif" font-size="16"',
  '        fill="#3f3f46">Diagram unavailable</text>',
  '</svg>',
].join('\n');

/**
 * The production degraded mode. Returns a valid placeholder SVG and an empty
 * PDF instead of throwing, so a rendering-stage failure never blocks the
 * tabular documentation it accompanies.
 */
export class NullRenderer implements DiagramRenderer, DocumentRenderer {
  renderSvg(mermaid: string): Promise<string> {
    // The interface is async because the real renderer needs to be; this
    // path never does. `void` marks the parameter deliberately unused
    // without weakening the interface it implements.
    void mermaid;
    return Promise.resolve(PLACEHOLDER_SVG);
  }

  renderPdf(html: string, meta: PdfMeta): Promise<Uint8Array> {
    void html;
    void meta;
    return Promise.resolve(new Uint8Array(0));
  }
}
