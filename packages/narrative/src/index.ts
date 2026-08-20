// @genesys-archivist/narrative
//
// Evidence-pack builder, deterministic prompt construction, the claim
// validator that is the actual grounding control, and a resumable
// narration work queue. This package performs no I/O of its own -- no
// filesystem, no network, no model SDK -- and its own test suite passes
// with `fetch` stubbed to throw.
//
// Exported deliberately, one symbol at a time, in the style of
// packages/composition/src/index.ts: what a consumer of this package can
// reach is a decision recorded here, not a side effect of what happened to
// be importable.

// The typed pack: the only thing this package ever exposes to a model.
export { buildEvidencePack } from './evidence-pack.js';
export type {
  EvidencePack,
  EvidencePackSnapshot,
  BuildEvidencePackOptions,
  PackFlow,
  PackGraph,
  PackGraphNode,
  PackGraphEdge,
  PackVariable,
  PackDependency,
  PackReachability,
  PackCycles,
  PackSubject,
  PackSubjectKind,
  EvidencePackNodeTypeCount,
  EvidencePackEdgeRoleCount,
  EvidencePackEntryPoint,
  EvidencePackTerminalNode,
  EvidencePackReachabilitySummary,
  EvidencePackCycle,
  EvidencePackVariable,
  EvidencePackDependency,
  EvidencePackWarning,
  EvidencePackTruncation,
  EvidencePackSubjectIndexEntry,
} from './evidence-pack.js';

// Tenant-text sanitization, shared by the pack builder and the injection
// corpus tests.
export { sanitizeUntrustedString, makeUntrustedText } from './text.js';
export type { UntrustedText } from './text.js';

// The model boundary: an injected interface this package never implements
// with real I/O. `NullNarrationProvider` keeps `deterministic-only` mode
// (docs/05) supported; `ScriptedNarrationProvider` is for tests.
export { NullNarrationProvider, ScriptedNarrationProvider } from './narration-provider.js';
export type {
  NarrationProvider,
  NarrationRequest,
  NarrationDraft,
  NarrationDraftSection,
  NarrationClaim,
  NarrationClaimSubject,
  ScriptedNarrationResponder,
} from './narration-provider.js';

// Deterministic prompt construction. Defence in depth only -- see
// prompt.ts's module comment for why this is not itself the control.
export { buildNarrationPrompt, NARRATION_SECTION_IDS } from './prompt.js';
export type { NarrationPrompt, NarrationSectionId } from './prompt.js';

// The control: rejects any claim the pack cannot ground.
export { validateNarration, DEFAULT_VALIDATION_POLICY } from './claim-validator.js';
export type {
  ValidationPolicy,
  ValidationOutcome,
  NarrativeSections,
  ValidatedSection,
  ValidatedClaim,
  ClaimRejection,
  RejectionCode,
} from './claim-validator.js';

// The resumable, idempotent narration work queue.
export { runNarrationQueue } from './work-queue.js';
export type {
  NarrationJob,
  NarrationJobStatus,
  NarrationJournal,
  NarrationJournalEntry,
  RunNarrationQueueOptions,
  NarrationQueueJobResult,
  NarrationQueueResult,
} from './work-queue.js';
