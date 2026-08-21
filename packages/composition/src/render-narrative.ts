// packages/composition/src/render-narrative.ts
//
// Renders `narrative.md`: the AI-assisted counterpart to `business.md`,
// `technical.md`, and `operations.md`. Every input here has already passed
// `validateNarration` (packages/narrative/src/claim-validator.ts) -- the
// control -- before it reaches this module; this file only formats what
// survived. It never receives a model's raw draft, only `ValidatedSection`s
// and typed `ClaimRejection`s.
//
// Two things this renderer exists to make impossible to miss, per AGENTS.md:
//
//   1. Narrated content must be visually distinguishable from the
//      deterministic documents. Every claim is rendered as a blockquote with
//      a bold `[FACT]`/`[DERIVED]`/`[INFERENCE]`/`[UNKNOWN]` tag, inside a
//      document whose own banner states plainly that this page is
//      AI-assisted and not yet reviewed -- never folded silently into
//      business.md or technical.md as though it were the same kind of
//      claim.
//   2. An inference is never presented as fact. `[INFERENCE]` is its own
//      tag, distinct from `[FACT]` and `[DERIVED]`, and this module does not
//      offer a way to render a claim without its kind.
//
// Rejected claims are reported here too -- a per-flow, human-visible count
// by reason code -- because AGENTS.md forbids silently dropping content, and
// a rejection is exactly that: content the model produced that this
// pipeline declined to show. The bundle-level report
// (`document-bundle-to-disk.ts`'s own `NarrationBundleReport`) is the
// operator-facing summary across every flow; this is the same fact, visible
// on the one document a reader of this specific flow will actually open.
import { escapeMarkdown } from '@genesys-archivist/documentation';
import type {
  ClaimRejection,
  NarrativeSections,
  ValidatedClaim,
  ValidatedSection,
} from '@genesys-archivist/narrative';

const SECTION_TITLES: Readonly<Record<string, string>> = {
  purpose: 'Purpose',
  'caller-journeys': 'Caller journeys',
  'business-rules': 'Business rules',
  'external-dependencies': 'External dependencies',
  'failure-behavior': 'Failure behavior',
  risks: 'Risks',
  'other-observations': 'Other observations',
};

function sectionTitle(id: string): string {
  return SECTION_TITLES[id] ?? id;
}

const KIND_TAGS: Readonly<Record<ValidatedClaim['kind'], string>> = {
  fact: '**[FACT]**',
  derived: '**[DERIVED]**',
  inference: "**[INFERENCE — the model's own interpretation, not a fact the capture states]**",
  unknown: '**[UNKNOWN — the model flagged a gap rather than guessing]**',
};

function renderClaim(claim: ValidatedClaim): string {
  const tag = KIND_TAGS[claim.kind];
  const confidence = claim.confidence !== null ? ` _(confidence: ${claim.confidence})_` : '';
  const evidence =
    claim.evidenceIds.length > 0
      ? ` <sub>evidence: ${claim.evidenceIds.map((id) => `\`${id}\``).join(', ')}</sub>`
      : '';
  return `> ${tag}${confidence} ${escapeMarkdown(claim.text)}${evidence}`;
}

function renderSection(section: ValidatedSection): readonly string[] {
  if (section.claims.length === 0) return [];
  const lines: string[] = [`### ${escapeMarkdown(sectionTitle(section.id))}`, ''];
  for (const claim of section.claims) {
    lines.push(renderClaim(claim), '');
  }
  return lines;
}

function renderUnknowns(unknowns: readonly string[]): readonly string[] {
  if (unknowns.length === 0) return [];
  const lines: string[] = ['### Gaps the model flagged rather than guessing at', ''];
  for (const unknown of unknowns) lines.push(`- ${escapeMarkdown(unknown)}`);
  lines.push('');
  return lines;
}

function renderRejections(rejections: readonly ClaimRejection[]): readonly string[] {
  if (rejections.length === 0) return [];
  const counts = new Map<string, number>();
  for (const rejection of rejections)
    counts.set(rejection.code, (counts.get(rejection.code) ?? 0) + 1);
  const sorted = [...counts.entries()].sort(([a], [b]) => a.localeCompare(b));

  const lines: string[] = [
    '### Claims rejected during grounding validation',
    '',
    `${String(rejections.length)} claim(s) the model produced did not pass grounding validation and were not included above. Rejection is not a display choice: a rejected claim is discarded entirely, never rendered in a weaker form.`,
    '',
  ];
  for (const [code, count] of sorted) {
    lines.push(`- \`${code}\`: ${String(count)}`);
  }
  lines.push('');
  return lines;
}

/**
 * Renders `narrative.md` for one flow from its validated `sections` (the
 * output of `validateNarration`) and the `rejections` recorded alongside
 * them. Returns `null` when there is nothing to show -- no accepted claim,
 * no flagged unknown, and no rejection to report -- so a caller can skip
 * writing an empty file rather than adding a document with nothing in it.
 */
export function renderNarrative(
  sections: NarrativeSections,
  rejections: readonly ClaimRejection[],
): string | null {
  const acceptedClaimCount = sections.sections.reduce((n, s) => n + s.claims.length, 0);
  if (acceptedClaimCount === 0 && sections.unknowns.length === 0 && rejections.length === 0) {
    return null;
  }

  const lines: string[] = [
    '# Narrated commentary (AI-assisted, not yet reviewed)',
    '',
    '> This section was drafted by an AI model from the deterministic documentation above and the ' +
      'evidence pack built from this capture. Every statement below passed automated grounding ' +
      'validation -- it cites real evidence from this capture -- but validation cannot prove prose ' +
      'true, and nothing here has been reviewed by a human. Review status: `automated_validated`.',
    '',
  ];

  const nonEmptySections = sections.sections.filter((s) => s.claims.length > 0);
  if (nonEmptySections.length === 0) {
    lines.push('No claim from this run passed grounding validation.', '');
  } else {
    for (const section of nonEmptySections) lines.push(...renderSection(section));
  }

  lines.push(...renderUnknowns(sections.unknowns));
  lines.push(...renderRejections(rejections));

  return lines.join('\n');
}
