// packages/narrative/src/text.ts
//
// Every piece of tenant-authored text (flow names, prompt scripts,
// expressions, data-action display names, finding messages that embed a
// variable or node name) that reaches this package is untrusted per
// AGENTS.md: never instructions, always data. This module is the single
// choke point that turns a raw string plus the evidence id backing it into
// the pack's `UntrustedText` shape -- Unicode-normalized, control-character
// free, and hard-capped in length. Every other module in this package that
// needs to carry tenant text into the pack goes through here, so the
// normalization and truncation rules cannot drift between call sites the
// way three independent copies of "escape markdown" once did in
// packages/documentation (see evidence-marks.ts's own history note).
//
// Both patterns below are built with `new RegExp(source, flags)` from a
// plain string rather than written as `/.../ ` literals, deliberately: the
// character classes name control, bidi-override, and zero-width code
// points, and writing those code points as literal bytes inside this
// source file (even via a regex literal) means the file itself would carry
// invisible/unsafe characters -- exactly the kind of thing that corrupts
// silently in an editor, a diff, or a copy-paste. Spelling them as `\uXXXX`
// escapes inside an ordinary string keeps this file plain ASCII.

// Matching control characters is the point of this pattern: it strips them
// before tenant text reaches a model prompt or a generated document.
// Newline, tab, and carriage return are deliberately left out of the
// class -- a multi-line prompt script is legitimate content, not an
// attack.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = new RegExp('[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]', 'g');

// Bidirectional-override and zero-width characters do not change what a
// human transcribes from the text, only how it *renders*. A tenant can hide
// "ignore previous instructions" inside what displays as an innocuous flow
// name by wrapping it in RTL overrides (U+202E and friends), or splice
// zero-width joiners into a keyword to dodge a naive substring filter.
// Stripping this range removes the rendering trick while leaving the
// readable content (including ordinary control characters, handled above)
// untouched.
//   U+200B-200F  zero-width space/joiners, LTR/RTL marks
//   U+202A-202E  bidi embedding/override controls
//   U+2066-2069  bidi isolate controls
//   U+FEFF       zero-width no-break space / byte-order mark
const BIDI_AND_ZERO_WIDTH = new RegExp(
  '[\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069\\ufeff]',
  'g',
);

/** Normalizes tenant-controlled text before it becomes part of an evidence
 * pack: canonical Unicode form, then strip the two character classes above.
 * Exported on its own because prompt.ts and the test corpus both need to
 * reason about "what does sanitized untrusted text look like" without
 * going through the truncation/evidence-id bookkeeping below. */
export function sanitizeUntrustedString(raw: string): string {
  return raw.normalize('NFC').replace(CONTROL_CHARS, '').replace(BIDI_AND_ZERO_WIDTH, '');
}

/**
 * The pack's only vehicle for tenant-authored content. `kind` is a
 * discriminant so a claim validator or a downstream renderer can tell at a
 * glance -- without inspecting provenance -- that a string came from the
 * customer's configuration rather than from this package's own prose.
 */
export interface UntrustedText {
  readonly kind: 'untrusted-text';
  readonly value: string;
  /** `null` when the field was not cut. Otherwise the length `value` was
   * cut to -- i.e. `value.length === truncatedAt` -- so a reader can tell
   * unambiguously that this is a prefix of a longer original, never a
   * silent, undetectable cut. */
  readonly truncatedAt: number | null;
  readonly evidenceId: string;
}

/** Builds one `UntrustedText` field: sanitize, then hard-cap length. */
export function makeUntrustedText(
  raw: string,
  evidenceId: string,
  maxLength: number,
): UntrustedText {
  const sanitized = sanitizeUntrustedString(raw);
  if (sanitized.length <= maxLength) {
    return { kind: 'untrusted-text', value: sanitized, truncatedAt: null, evidenceId };
  }
  return {
    kind: 'untrusted-text',
    value: sanitized.slice(0, maxLength),
    truncatedAt: maxLength,
    evidenceId,
  };
}
