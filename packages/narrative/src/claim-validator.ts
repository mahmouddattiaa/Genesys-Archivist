// packages/narrative/src/claim-validator.ts
//
// THIS is the security control, not prompt.ts. AGENTS.md: "typed evidence
// packs and output validation -- prompt wording is not a control." Every
// rule below assumes the model is adversarial -- not because a well-behaved
// provider is expected to attack the pipeline, but because a tenant who
// controls flow content controls part of what the model sees, and this
// package has no way to tell a compromised or merely sloppy response from
// a deliberately hostile one. The validator does not care which it is.
//
// Design invariants:
//   1. A claim is judged only against `pack` -- the fixed, typed evidence
//      pack it was generated from. Nothing else is a source of truth.
//   2. A rejection is individual and typed. `validateNarration` never
//      throws on bad input and never drops a claim without recording why
//      -- AGENTS.md's "never silently drop", applied to model output the
//      same way it applies to an unsupported flow node.
//   3. Rejection reasons are fixed, generic strings (see `reasonFor`).
//      They never interpolate claim text, quoted content, or evidence
//      values -- reasons reach logs, and a logged fragment of what looked
//      like a secret is still a leaked fragment. Only structural metadata
//      that is safe by construction (a section id, a claim index, a count)
//      may appear in one.
//   4. The model's free-form `section.markdown` is never trusted into
//      validated output. Only individual claims that pass every check
//      below survive. This is deliberately more conservative than
//      docs/05's illustrative example might suggest, and it is the choice
//      that makes "nested markdown that closes a code fence" a non-issue
//      in the injection-corpus test: that text is simply never re-emitted,
//      because raw markdown is never re-emitted. A downstream renderer
//      composes the actual document markdown from validated claims, not
//      from a model's prose.
//   5. `inference` never claims more than a claim is worth, but it is not
//      free either: it still must cite real evidence and stay within
//      every size and pattern rule below. The only thing labelling a claim
//      `inference` relaxes is the structural-subject-support check (rule
//      8), because an inference is explicitly the model going beyond what
//      the pack proves.

import type { FindingKind } from '@genesys-archivist/analysis';
import { z } from 'zod';
import type { EvidencePack } from './evidence-pack.js';
import type { NarrationClaimSubject, NarrationDraft } from './narration-provider.js';
import { NARRATION_SECTION_IDS } from './prompt.js';
import { findForbiddenPattern, type ForbiddenPatternCode } from './patterns.js';

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export interface ValidationPolicy {
  readonly allowedSectionIds: readonly string[];
  readonly allowInference: boolean;
  readonly maxClaimTextLength: number;
  readonly maxClaimsPerSection: number;
  readonly maxSectionCharLength: number;
  readonly maxClaimsPerDraft: number;
  readonly maxDraftCharLength: number;
  readonly maxQuotationLength: number;
  readonly maxUnknownsLength: number;
  readonly maxUnknownTextLength: number;
}

export const DEFAULT_VALIDATION_POLICY: ValidationPolicy = {
  allowedSectionIds: NARRATION_SECTION_IDS,
  allowInference: true,
  maxClaimTextLength: 500,
  maxClaimsPerSection: 40,
  maxSectionCharLength: 8000,
  maxClaimsPerDraft: 200,
  maxDraftCharLength: 40000,
  maxQuotationLength: 120,
  maxUnknownsLength: 50,
  maxUnknownTextLength: 500,
};

// ---------------------------------------------------------------------------
// Output shape
// ---------------------------------------------------------------------------

export interface ValidatedClaim {
  readonly text: string;
  readonly kind: FindingKind;
  readonly confidence: 'low' | 'medium' | 'high' | null;
  readonly evidenceIds: readonly string[];
  readonly subject: NarrationClaimSubject | null;
}

export interface ValidatedSection {
  readonly id: string;
  readonly claims: readonly ValidatedClaim[];
}

export interface NarrativeSections {
  readonly sections: readonly ValidatedSection[];
  readonly unknowns: readonly string[];
  /** Always `true`. AI-touched narrative content is never presented as
   * approved on its own -- docs/05's review lifecycle
   * (`generated -> automated_validated -> human_review_required ->
   * approved`) puts a human step after this validator unconditionally, so
   * this flag is not a computed judgement about draft quality, it is a
   * standing fact about anything this function returns. */
  readonly reviewRequired: boolean;
}

export type RejectionCode =
  | 'MALFORMED_CLAIM'
  | 'SECTION_NOT_ALLOWED'
  | 'FABRICATED_EVIDENCE_ID'
  | 'MISSING_EVIDENCE'
  | 'UNSUPPORTED_SUBJECT'
  | 'CLAIM_TOO_LARGE'
  | 'SECTION_TOO_LARGE'
  | 'DRAFT_TOO_LARGE'
  | 'FORBIDDEN_PATTERN_URL'
  | 'FORBIDDEN_PATTERN_EMAIL'
  | 'FORBIDDEN_PATTERN_PHONE'
  | 'FORBIDDEN_PATTERN_BASE64_BLOB'
  | 'FORBIDDEN_PATTERN_CREDENTIAL'
  | 'FORBIDDEN_PATTERN_EXTERNAL_LINK'
  | 'FORBIDDEN_PATTERN_HTML_TAG'
  | 'FORBIDDEN_PATTERN_CONTROL_CHARACTER'
  | 'FORBIDDEN_PATTERN_MARKDOWN_FENCE'
  | 'INFERENCE_NOT_PERMITTED'
  | 'UNBOUNDED_QUOTATION'
  | 'FABRICATED_QUOTATION';

export interface ClaimRejection {
  readonly code: RejectionCode;
  readonly sectionId: string | null;
  readonly claimIndex: number | null;
  readonly reason: string;
}

export interface ValidationOutcome {
  readonly sections: NarrativeSections;
  readonly rejections: readonly ClaimRejection[];
}

// ---------------------------------------------------------------------------
// Fixed, content-free rejection reasons. See invariant 3 above: nothing
// interpolated here may ever be tenant- or model-authored text.
// ---------------------------------------------------------------------------

function reasonFor(code: RejectionCode): string {
  switch (code) {
    case 'MALFORMED_CLAIM':
      return 'Claim did not match the required shape (text, kind, evidenceIds).';
    case 'SECTION_NOT_ALLOWED':
      return 'Section id is not on the allowed list.';
    case 'FABRICATED_EVIDENCE_ID':
      return 'Claim cites an evidence id that does not exist in the evidence pack.';
    case 'MISSING_EVIDENCE':
      return 'Claim declares kind "fact" or "derived" but cites no evidence.';
    case 'UNSUPPORTED_SUBJECT':
      return 'Claim cites evidence that does not structurally support its declared subject.';
    case 'CLAIM_TOO_LARGE':
      return 'Claim text exceeds the maximum allowed length.';
    case 'SECTION_TOO_LARGE':
      return 'Section exceeds its claim-count or character budget.';
    case 'DRAFT_TOO_LARGE':
      return 'Draft exceeds its claim-count or character budget.';
    case 'FORBIDDEN_PATTERN_URL':
      return 'Claim text contains a URL.';
    case 'FORBIDDEN_PATTERN_EMAIL':
      return 'Claim text contains an email address.';
    case 'FORBIDDEN_PATTERN_PHONE':
      return 'Claim text contains a phone number or DID pattern.';
    case 'FORBIDDEN_PATTERN_BASE64_BLOB':
      return 'Claim text contains a long base64-shaped blob.';
    case 'FORBIDDEN_PATTERN_CREDENTIAL':
      return 'Claim text contains a credential-shaped value.';
    case 'FORBIDDEN_PATTERN_EXTERNAL_LINK':
      return 'Claim text contains a markdown link or image with an external target.';
    case 'FORBIDDEN_PATTERN_HTML_TAG':
      return 'Claim text contains an HTML tag.';
    case 'FORBIDDEN_PATTERN_CONTROL_CHARACTER':
      return 'Claim text contains a control character.';
    case 'FORBIDDEN_PATTERN_MARKDOWN_FENCE':
      return 'Claim text contains a markdown code fence.';
    case 'INFERENCE_NOT_PERMITTED':
      return 'Claim is labelled "inference" but policy forbids inference claims.';
    case 'UNBOUNDED_QUOTATION':
      return 'Claim quotes source text longer than the allowed quotation length.';
    case 'FABRICATED_QUOTATION':
      return 'Claim quotes text that does not appear anywhere in the evidence pack.';
  }
}

function forbiddenPatternToRejection(code: ForbiddenPatternCode): RejectionCode {
  switch (code) {
    case 'URL':
      return 'FORBIDDEN_PATTERN_URL';
    case 'EMAIL':
      return 'FORBIDDEN_PATTERN_EMAIL';
    case 'PHONE':
      return 'FORBIDDEN_PATTERN_PHONE';
    case 'BASE64_BLOB':
      return 'FORBIDDEN_PATTERN_BASE64_BLOB';
    case 'CREDENTIAL_SHAPED':
      return 'FORBIDDEN_PATTERN_CREDENTIAL';
    case 'EXTERNAL_LINK':
      return 'FORBIDDEN_PATTERN_EXTERNAL_LINK';
    case 'HTML_TAG':
      return 'FORBIDDEN_PATTERN_HTML_TAG';
    case 'CONTROL_CHARACTER':
      return 'FORBIDDEN_PATTERN_CONTROL_CHARACTER';
    case 'MARKDOWN_FENCE':
      return 'FORBIDDEN_PATTERN_MARKDOWN_FENCE';
  }
}

// ---------------------------------------------------------------------------
// Defensive shape parsing. `NarrationDraft` is typed, but it is model
// output round-tripped through JSON somewhere upstream of this package --
// the compile-time type is a claim about the happy path, not a runtime
// guarantee. zod re-validates each claim's leaf shape individually (rather
// than the whole draft as one schema) so one malformed claim rejects only
// itself, never its whole section or the rest of the draft.
// ---------------------------------------------------------------------------

const FindingKindSchema = z.enum(['fact', 'derived', 'inference', 'unknown']);
const ConfidenceSchema = z.enum(['low', 'medium', 'high']);
const SubjectKindSchema = z.enum(['variable', 'node', 'edge', 'dependency', 'flow', 'general']);

const ClaimSubjectSchema = z.object({
  kind: SubjectKindSchema,
  id: z.string().nullable(),
});

const ClaimSchema = z.object({
  text: z.string(),
  kind: FindingKindSchema,
  confidence: ConfidenceSchema.optional(),
  evidenceIds: z.array(z.string()),
  subject: ClaimSubjectSchema.optional(),
});

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort(compareStrings);
}

/** Every `UntrustedText.value` anywhere in the pack, concatenated. A quoted
 * span in a claim must be a substring of this to be considered a genuine
 * quotation rather than an invention -- see invariant/rule for
 * `FABRICATED_QUOTATION` below. */
function packTextCorpus(pack: EvidencePack): string {
  const parts: string[] = [pack.flow.name.value];
  if (pack.flow.description !== null) parts.push(pack.flow.description.value);
  for (const e of pack.structural.entryPoints) parts.push(e.name.value);
  for (const t of pack.structural.terminalNodes) parts.push(t.name.value);
  for (const v of pack.variables) parts.push(v.name.value);
  for (const d of pack.dependencies) {
    if (d.displayName !== null) parts.push(d.displayName.value);
  }
  for (const w of pack.warnings) parts.push(w.message.value);
  return parts.join('\n');
}

/** Extracts substrings a claim presents as verbatim quotation: text
 * wrapped in straight double quotes, backticks, or curly double quotes.
 * Each pattern is declared fresh per call so a shared `RegExp`'s
 * `lastIndex` never leaks state between claims. */
function extractQuotations(text: string): readonly string[] {
  const patterns: readonly RegExp[] = [/"([^"]*)"/g, /`([^`]*)`/g, /“([^”]*)”/g];
  const quotes: string[] = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const inner = match[1];
      if (inner !== undefined && inner.length > 0) quotes.push(inner);
    }
  }
  return quotes;
}

function evidenceIdsSupportSubject(
  pack: EvidencePack,
  evidenceIds: readonly string[],
  subject: NarrationClaimSubject,
): boolean {
  const idSet = new Set(evidenceIds);
  return pack.subjectIndex.some(
    (entry) =>
      idSet.has(entry.evidenceId) &&
      entry.subject.kind === subject.kind &&
      entry.subject.id === subject.id,
  );
}

type ClaimResult =
  | { readonly ok: true; readonly claim: ValidatedClaim }
  | { readonly ok: false; readonly rejection: ClaimRejection };

function validateClaim(
  rawClaim: unknown,
  pack: EvidencePack,
  corpus: string,
  policy: ValidationPolicy,
  sectionId: string,
  claimIndex: number,
): ClaimResult {
  const reject = (code: RejectionCode): ClaimResult => ({
    ok: false,
    rejection: { code, sectionId, claimIndex, reason: reasonFor(code) },
  });

  const parsed = ClaimSchema.safeParse(rawClaim);
  if (!parsed.success) return reject('MALFORMED_CLAIM');
  const claim = parsed.data;

  if (claim.text.length > policy.maxClaimTextLength) return reject('CLAIM_TOO_LARGE');

  const forbidden = findForbiddenPattern(claim.text);
  if (forbidden !== null) return reject(forbiddenPatternToRejection(forbidden));

  for (const quote of extractQuotations(claim.text)) {
    if (quote.length > policy.maxQuotationLength) return reject('UNBOUNDED_QUOTATION');
    if (!corpus.includes(quote)) return reject('FABRICATED_QUOTATION');
  }

  const evidenceIds = sortedUnique(claim.evidenceIds);
  const validEvidenceIds = new Set(pack.evidenceIds);
  if (evidenceIds.some((id) => !validEvidenceIds.has(id))) return reject('FABRICATED_EVIDENCE_ID');

  if (claim.kind !== 'unknown' && evidenceIds.length === 0) return reject('MISSING_EVIDENCE');

  if (claim.kind === 'inference' && !policy.allowInference)
    return reject('INFERENCE_NOT_PERMITTED');

  if (
    (claim.kind === 'fact' || claim.kind === 'derived') &&
    claim.subject !== undefined &&
    claim.subject.kind !== 'general'
  ) {
    if (!evidenceIdsSupportSubject(pack, evidenceIds, claim.subject)) {
      return reject('UNSUPPORTED_SUBJECT');
    }
  }

  return {
    ok: true,
    claim: {
      text: claim.text,
      kind: claim.kind,
      confidence: claim.confidence ?? null,
      evidenceIds,
      subject: claim.subject ?? null,
    },
  };
}

interface RawSectionLike {
  readonly id: unknown;
  readonly claims: unknown;
}

function asRawSection(value: unknown): RawSectionLike | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  return { id: record['id'], claims: record['claims'] };
}

function validateSection(
  rawSection: unknown,
  pack: EvidencePack,
  corpus: string,
  policy: ValidationPolicy,
  rejections: ClaimRejection[],
): ValidatedSection | null {
  const section = asRawSection(rawSection);
  const id = section !== null && typeof section.id === 'string' ? section.id : null;

  if (id === null || !policy.allowedSectionIds.includes(id)) {
    rejections.push({
      code: 'SECTION_NOT_ALLOWED',
      sectionId: id,
      claimIndex: null,
      reason: reasonFor('SECTION_NOT_ALLOWED'),
    });
    return null;
  }

  const rawClaims = section !== null && Array.isArray(section.claims) ? section.claims : [];
  const accepted: ValidatedClaim[] = [];
  let sectionCharTotal = 0;

  rawClaims.forEach((rawClaim: unknown, index: number) => {
    if (accepted.length >= policy.maxClaimsPerSection) {
      rejections.push({
        code: 'SECTION_TOO_LARGE',
        sectionId: id,
        claimIndex: index,
        reason: reasonFor('SECTION_TOO_LARGE'),
      });
      return;
    }

    const result = validateClaim(rawClaim, pack, corpus, policy, id, index);
    if (!result.ok) {
      rejections.push(result.rejection);
      return;
    }

    if (sectionCharTotal + result.claim.text.length > policy.maxSectionCharLength) {
      rejections.push({
        code: 'SECTION_TOO_LARGE',
        sectionId: id,
        claimIndex: index,
        reason: reasonFor('SECTION_TOO_LARGE'),
      });
      return;
    }

    sectionCharTotal += result.claim.text.length;
    accepted.push(result.claim);
  });

  return { id, claims: accepted };
}

/** Applies the whole-draft claim-count and character budget across every
 * accepted section, in order, so the cut point is deterministic: the
 * first claims (by section order, then claim order) fill the budget, and
 * everything after the budget is exhausted is rejected as
 * `DRAFT_TOO_LARGE` rather than the draft being rejected wholesale. */
function enforceDraftBudget(
  sections: readonly ValidatedSection[],
  policy: ValidationPolicy,
  rejections: ClaimRejection[],
): readonly ValidatedSection[] {
  let totalClaims = 0;
  let totalChars = 0;
  const out: ValidatedSection[] = [];

  for (const section of sections) {
    const kept: ValidatedClaim[] = [];
    section.claims.forEach((claim, index) => {
      const overBudget =
        totalClaims >= policy.maxClaimsPerDraft ||
        totalChars + claim.text.length > policy.maxDraftCharLength;
      if (overBudget) {
        rejections.push({
          code: 'DRAFT_TOO_LARGE',
          sectionId: section.id,
          claimIndex: index,
          reason: reasonFor('DRAFT_TOO_LARGE'),
        });
        return;
      }
      totalClaims += 1;
      totalChars += claim.text.length;
      kept.push(claim);
    });
    out.push({ id: section.id, claims: kept });
  }

  return out;
}

function validateUnknowns(
  rawUnknowns: readonly unknown[],
  policy: ValidationPolicy,
  rejections: ClaimRejection[],
): readonly string[] {
  const out: string[] = [];

  rawUnknowns.forEach((raw, index) => {
    if (out.length >= policy.maxUnknownsLength) {
      rejections.push({
        code: 'DRAFT_TOO_LARGE',
        sectionId: null,
        claimIndex: index,
        reason: reasonFor('DRAFT_TOO_LARGE'),
      });
      return;
    }
    if (typeof raw !== 'string') {
      rejections.push({
        code: 'MALFORMED_CLAIM',
        sectionId: null,
        claimIndex: index,
        reason: reasonFor('MALFORMED_CLAIM'),
      });
      return;
    }
    if (raw.length > policy.maxUnknownTextLength) {
      rejections.push({
        code: 'CLAIM_TOO_LARGE',
        sectionId: null,
        claimIndex: index,
        reason: reasonFor('CLAIM_TOO_LARGE'),
      });
      return;
    }
    const forbidden = findForbiddenPattern(raw);
    if (forbidden !== null) {
      const code = forbiddenPatternToRejection(forbidden);
      rejections.push({ code, sectionId: null, claimIndex: index, reason: reasonFor(code) });
      return;
    }
    out.push(raw);
  });

  return out;
}

/**
 * The grounding validator: rejects, individually and with a typed reason,
 * any claim in `draft` that this evidence pack does not support. Never
 * throws. Always returns both the claims that passed (however few) and an
 * explicit record of every rejection -- never a silent drop.
 */
export function validateNarration(
  draft: NarrationDraft,
  pack: EvidencePack,
  policy: ValidationPolicy = DEFAULT_VALIDATION_POLICY,
): ValidationOutcome {
  const rejections: ClaimRejection[] = [];
  const corpus = packTextCorpus(pack);

  const rawSections: readonly unknown[] = Array.isArray(draft.sections) ? draft.sections : [];
  const parsedSections: ValidatedSection[] = [];
  for (const rawSection of rawSections) {
    const section = validateSection(rawSection, pack, corpus, policy, rejections);
    if (section !== null) parsedSections.push(section);
  }

  const budgeted = enforceDraftBudget(parsedSections, policy, rejections);
  const rawUnknowns: readonly unknown[] = Array.isArray(draft.unknowns) ? draft.unknowns : [];
  const unknowns = validateUnknowns(rawUnknowns, policy, rejections);

  return {
    sections: { sections: budgeted, unknowns, reviewRequired: true },
    rejections,
  };
}
