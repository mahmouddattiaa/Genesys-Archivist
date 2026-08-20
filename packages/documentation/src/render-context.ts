// packages/documentation/src/render-context.ts
// Shared by every `render*` function in this package (`renderBusiness`,
// `renderTechnical`, `renderOperations`). Each renderer needs exactly one
// piece of injected state to stay pure and deterministic: the generation
// timestamp, which must come from here rather than `new Date()`.
//
// This lives in its own module, rather than being declared once per
// renderer, because `index.ts` re-exports every renderer with
// `export * from './<renderer>.js'`. Three independent `RenderContext`
// declarations of the same shape would make that export ambiguous — under
// ES module semantics an ambiguous star export is silently dropped, and our
// TypeScript settings turn that into a hard error, so no consumer could
// import the type at all. A single shared declaration avoids the collision
// and keeps the three renderers from drifting apart on what "context" means.

/** Everything a `render*` function needs injected to stay pure. */
export interface RenderContext {
  readonly generatedAt: string;
}
