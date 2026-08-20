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
// so the write-and-promote path exists exactly once.
export { documentBundleToDisk } from './document-bundle-to-disk.js';
export type {
  DocumentBundleToDiskOptions,
  DocumentBundleToDiskResult,
} from './document-bundle-to-disk.js';

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

// Durable per-run manifest persistence archivist-port.ts's createArchivistPort
// builds by default; surfaced here so a caller that wants to share one
// RunStore across ports (or point it at a specific root) can construct one
// itself.
export { createRunStore } from './run-store.js';
export type { RunManifest, RunStore, RunStoreOptions, LoadRunResult } from './run-store.js';
