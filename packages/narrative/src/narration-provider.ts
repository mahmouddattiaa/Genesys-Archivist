// packages/narrative/src/narration-provider.ts
//
// The model boundary. `NarrationProvider` is the only way this package
// talks to a model, and it is injected -- this file contains no HTTP
// client, no SDK, and no `fetch` call. A production adapter (an approved
// enterprise model endpoint, or the interactive client's own model per
// docs/05's `interactive-client` data-processing mode) lives outside this
// package and implements this interface; `packages/composition` wires it
// in. That keeps Stage 2's promise intact: this package's entire test
// suite passes with `fetch` stubbed to throw.
//
// `NullNarrationProvider` is not a placeholder waiting to be replaced --
// `deterministic-only` mode (docs/05) is a permanently supported
// configuration, and returning an empty draft is how the rest of the
// pipeline (work-queue.ts, and eventually the documentation renderers)
// keeps working when AI narration is disabled by policy.

import type { FindingKind } from '@genesys-archivist/analysis';
import type { NarrationPrompt } from './prompt.js';

/** What a claim is about, so claim-validator.ts can check that the
 * evidence it cites structurally supports that subject rather than
 * merely existing somewhere in the pack. `'general'` and an absent
 * `subject` are treated the same way: a flow-wide statement that is not
 * about one specific variable, node, edge, or dependency. */
export interface NarrationClaimSubject {
  readonly kind: 'variable' | 'node' | 'edge' | 'dependency' | 'flow' | 'general';
  readonly id: string | null;
}

/**
 * One assertion in a narration draft. `kind` mirrors
 * `@genesys-archivist/analysis`'s `FindingKind` deliberately -- narration
 * and deterministic findings share one certainty vocabulary
 * (`fact` | `derived` | `inference` | `unknown`) rather than inventing a
 * second one, so a reader never has to learn what a narrative-only label
 * means that a deterministic finding's label does not.
 */
export interface NarrationClaim {
  readonly text: string;
  readonly kind: FindingKind;
  readonly confidence?: 'low' | 'medium' | 'high';
  readonly evidenceIds: readonly string[];
  readonly subject?: NarrationClaimSubject;
}

export interface NarrationDraftSection {
  readonly id: string;
  /** The model's own free-form prose for this section. Never trusted
   * directly into validated output -- see claim-validator.ts's module
   * comment for why only individual `claims` survive validation. Carried
   * here so a provider's raw response round-trips losslessly through this
   * type even though the validator discards it. */
  readonly markdown: string;
  readonly claims: readonly NarrationClaim[];
}

/** The provider's raw output, matching docs/05's narrative output
 * contract. Untrusted in every field -- this is model output, and the
 * model saw tenant-authored content, so it is adversarial input as far as
 * claim-validator.ts is concerned, not a trusted internal type. */
export interface NarrationDraft {
  readonly sections: readonly NarrationDraftSection[];
  readonly unknowns: readonly string[];
  readonly reviewRequired: boolean;
}

export interface NarrationRequest {
  readonly prompt: NarrationPrompt;
}

export interface NarrationProvider {
  narrate(request: NarrationRequest): Promise<NarrationDraft>;
}

/** The `deterministic-only` data-processing mode from docs/05: no customer
 * configuration is sent to a model, because no model is called. Always
 * returns an empty, review-not-required draft so a caller can run the
 * narration stage unconditionally and get a no-op when AI is disabled by
 * policy, rather than needing a separate code path. */
export class NullNarrationProvider implements NarrationProvider {
  // The parameter is unused but kept in the signature (rather than
  // omitted, which TypeScript would otherwise allow structurally) so a
  // caller holding a `NullNarrationProvider` directly, not through the
  // `NarrationProvider` interface, can still call `.narrate(request)`
  // without a spurious "expected 0 arguments" compile error.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  narrate(_request: NarrationRequest): Promise<NarrationDraft> {
    return Promise.resolve({ sections: [], unknowns: [], reviewRequired: false });
  }
}

export type ScriptedNarrationResponder = (request: NarrationRequest) => NarrationDraft;

/**
 * A test double: returns a fixed `NarrationDraft`, or computes one from the
 * request via a supplied function -- useful for a test that wants to
 * assert what prompt a job produced, or that wants to script an
 * adversarial response (echoing forbidden content, fabricating an evidence
 * id) to exercise claim-validator.ts's rejection paths. Performs no I/O.
 */
export class ScriptedNarrationProvider implements NarrationProvider {
  readonly #responder: ScriptedNarrationResponder;

  constructor(responder: NarrationDraft | ScriptedNarrationResponder) {
    this.#responder = typeof responder === 'function' ? responder : () => responder;
  }

  narrate(request: NarrationRequest): Promise<NarrationDraft> {
    return Promise.resolve(this.#responder(request));
  }
}
