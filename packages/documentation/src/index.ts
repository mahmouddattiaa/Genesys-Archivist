// @genesys-archivist/documentation
// Deterministic Markdown rendering, evidence pack assembly, and Mermaid source generation.
//
// This package is the deterministic half of Stage 2. It opens no sockets,
// reads no files, and calls no model: it turns a normalized snapshot and the
// analysis over it into Markdown and Mermaid source, and says plainly where
// the captured configuration does not record something rather than guessing.
//
// `RenderContext` is declared once, in `render-context.ts`, and re-exported
// from here rather than from `business.ts`/`technical.ts`/`operations.ts`
// individually: every renderer imports the same type, so the wildcard
// re-exports below never make the name ambiguous. This explicit re-export
// also takes precedence over any star export of the same name.
export type { RenderContext } from './render-context.js';

export * from './escape.js';
export * from './evidence-marks.js';
export * from './diagrams.js';
export * from './technical.js';
export * from './business.js';
export * from './operations.js';
