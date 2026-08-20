// @genesys-archivist/composition
// The composition root: the one place concrete adapters are wired together.
//
// `apps/*` may import `application` and `composition` only — ESLint enforces
// it — so anything an app needs from capture, normalization, analysis,
// documentation or rendering is surfaced here deliberately, one symbol at a
// time. That is the point of the rule: the set of things the CLI can reach is
// a decision recorded in this file, not a side effect of what happened to be
// importable.

export { runDocument } from './document-flow.js';
export type { DocumentDeps, DocumentResult } from './document-flow.js';

export { documentBundle } from './document-bundle.js';
export type { DocumentBundleOptions, DocumentBundleResult } from './document-bundle.js';

// Stage 1. `runCapture` is the only thing in this repo that talks to Genesys,
// and it does so through an injected `GenesysSourceProvider` — no production
// adapter exists yet, so a caller must supply one.
export { runCapture, resumeCapture, verifyBundle } from '@genesys-archivist/capture';
export type {
  CaptureMode,
  CaptureRunOptions,
  CaptureRunResult,
  CaptureScope,
  VerificationFinding,
  VerificationResult,
} from '@genesys-archivist/capture';
