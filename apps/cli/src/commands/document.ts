// apps/cli/src/commands/document.ts
//
// `archivist document` is a thin delegate. The Stage 2 pipeline it runs —
// normalize, analyze, render — spans three packages an app may not import
// directly, so the wiring lives in the composition root and this file exists
// to give the command a stable name and to keep the CLI's public surface
// independent of where that wiring happens to live.
export { runDocument } from '@genesys-archivist/composition';
export type { DocumentDeps, DocumentResult } from '@genesys-archivist/composition';
