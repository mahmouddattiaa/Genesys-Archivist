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

// Profile persistence and secret resolution. Surfaced here -- rather than
// having apps/cli reach into @genesys-archivist/storage and
// @genesys-archivist/security directly to wire this up itself -- because
// *which* SecretStore backs a real run (OS keyring vs. the CI-only
// env-var fallback) is exactly the kind of adapter-selection decision this
// package exists to own in one place, per ADR-017.
export { openProfileStore, resolveSecretStore } from './profiles.js';
export type { OpenProfileStoreOptions, ResolveSecretStoreOptions } from './profiles.js';

// The per-user directory archivist stores local state under. Re-exported so
// a caller in apps/* (which may depend on composition and application only,
// never security directly -- see eslint.config.mjs's apps/** rule) can root
// its own state (e.g. apps/mcp-server/src/wire.ts's run store) alongside
// profiles.json without reaching past this package for it.
export { defaultConfigRoot } from '@genesys-archivist/security';

export { documentBundle } from './document-bundle.js';
export type { DocumentBundleOptions, DocumentBundleResult } from './document-bundle.js';

// Writes a documentBundle() result to disk, atomically and mergingly (never
// overwriting flows an in-flight call did not itself re-document). Shared by
// archivist-port.ts's startRun and apps/cli's `archivist document` command,
// so the write-and-promote path exists exactly once. `narrate: true` wires
// the opt-in AI narration step through the same call -- see that file's own
// "Narration wiring" section for why it lives here rather than in
// documentBundle itself.
export { documentBundleToDisk } from './document-bundle-to-disk.js';
export type {
  DocumentBundleToDiskOptions,
  DocumentBundleToDiskResult,
  NarrationBundleReport,
} from './document-bundle-to-disk.js';

// The real, Anthropic-API-backed NarrationProvider. `@genesys-archivist/narrative`
// opens no socket of its own (see that package's narration-provider.ts
// header); this is the adapter composition wires in, per AGENTS.md's rule
// that adapters live in composition. The API key is resolved from a
// SecretStore at the moment of use, never accepted as an argument that could
// be logged or serialized -- see this module's own header for the full
// reasoning, which mirrors genesys-provider.ts's for the Genesys client
// secret exactly.
export { createAnthropicNarrationProvider } from './narration-provider.js';
export type { CreateAnthropicNarrationProviderOptions } from './narration-provider.js';

// The resumable narration queue's real, disk-backed persistence, plus the
// in-memory fallback documentBundleToDisk uses when a caller asks for
// narration without supplying one. See narration-journal.ts's own header for
// why this also carries a sections side-store beyond what
// @genesys-archivist/narrative's own NarrationJournal port requires.
export { createFileNarrationJournal, createInMemoryNarrationJournal } from './narration-journal.js';
export type { FileNarrationJournalOptions, NarrationContentJournal } from './narration-journal.js';

// Renders one flow's validated narration sections into narrative.md.
// Exported so a caller wiring documentBundleToDisk's narration step by hand
// (rather than through documentBundleToDisk itself) can reuse the same
// rendering this module's own narration wiring does.
export { renderNarrative } from './render-narrative.js';

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

// Resolves a real, production GenesysSourceProvider for one profile (the
// Platform API adapter, @genesys-archivist/genesys-source) from stored
// profile metadata and the secret store, at the moment of use. The one
// caller-facing implementation of the providerFor injection point
// createArchivistPort takes below -- a caller wires
// `providerFor: (profileId) => createGenesysProvider({ profileId, ... })`.
export { createGenesysProvider } from './genesys-provider.js';
export type { CreateGenesysProviderOptions } from './genesys-provider.js';

// The real ArchivistPort implementation: profile listing, connection
// checks, flow discovery/inspection, plan/run/cancel, and resource reads,
// wired against whichever GenesysSourceProvider and diffFlow function the
// caller injects.
export { createArchivistPort } from './archivist-port.js';
export type { ArchivistPortDeps } from './archivist-port.js';

// The real ArchivistPort['diffFlow']: loads both requested versions through
// a GenesysSourceProvider, normalizes and diffs them
// (@genesys-archivist/analysis), and maps the result onto the FlowDiff DTO.
// Kept separate from archivist-port.ts and injected into it as
// `deps.diffFlow` -- see that file's header comment for why -- rather than
// implemented inline there.
export { createDiffFlow } from './diff-flow.js';
export type { DiffFlowDeps } from './diff-flow.js';

// Durable per-run manifest persistence archivist-port.ts's createArchivistPort
// builds by default; surfaced here so a caller that wants to share one
// RunStore across ports (or point it at a specific root) can construct one
// itself.
export { createRunStore } from './run-store.js';
export type { RunManifest, RunStore, RunStoreOptions, LoadRunResult } from './run-store.js';

// Change-detection I/O: reads what a previous capture run left on disk,
// discovers the current organization through an injected
// GenesysSourceProvider, and calls @genesys-archivist/analysis's
// decideFlowAction per flow -- the I/O that pure function was deliberately
// left without. `runIncrementalCapture` is the `--since-last` primitive: a
// capture that only fetches what changed, while still sealing a bundle that
// describes the whole organization (see that file's own header comment for
// how, and why it is context-mode only).
export { planIncrementalCapture, runIncrementalCapture } from './change-detection-io.js';
export type {
  IncrementalCaptureCounts,
  IncrementalCaptureOptions,
  IncrementalCaptureResult,
  IncrementalCapturePlan,
  InaccessibleFlow,
  OutOfScopeFlow,
  PlanIncrementalCaptureOptions,
  PlannedCapture,
  RetireCandidateFlow,
  SkippedFlow,
} from './change-detection-io.js';

// Drawing the Mermaid sources an already-written documents tree contains.
// Deliberately separate from documenting: writing the sources takes seconds,
// drawing them launches a browser and takes tens of minutes across an
// organization, so the two are different decisions.
export { renderDiagrams } from './render-diagrams.js';
export type { RenderDiagramsOptions, RenderDiagramsResult } from './render-diagrams.js';
