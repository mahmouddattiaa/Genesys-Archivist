// packages/narrative/src/patterns.ts
//
// Forbidden-pattern detection for claim-validator.ts. Each detector is a
// pure regex test; `findForbiddenPattern` reports only which *class* of
// pattern matched (mirroring docs/06's redaction category list), never the
// matched substring itself -- rejection reasons reach logs, and a logged
// fragment of what looked like a bearer token is still a leaked fragment.
//
// This is defence in depth against a narration draft that echoes secret-
// or PII-shaped content, not a general secret scanner: the real control is
// that the evidence pack (evidence-pack.ts) never carries a data action's
// endpoint, headers, or credential fields into a field the model can see
// in the first place. These patterns catch what a model invents or copies
// despite that -- a URL it hallucinates, a phone number it infers, a
// credential-shaped string it echoes from somewhere it should not have.

const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/\S+/i;
const WWW_PATTERN = /\bwww\.\S+\.\S+/i;
const EMAIL_PATTERN = /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/i;
// A DID, extension, or phone number: seven-plus digits, optionally grouped
// with spaces, dots, dashes, or parentheses, with an optional leading '+'.
const PHONE_PATTERN = /(?:\+?\d[\d\s().-]{6,}\d)/;
const BASE64_BLOB_PATTERN = /[A-Za-z0-9+/]{80,}={0,2}/;
const CREDENTIAL_KEYWORD_PATTERN =
  /\b(client[\s_-]?secret|access[\s_-]?token|refresh[\s_-]?token|private[\s_-]?key|api[\s_-]?key|secret[\s_-]?key|bearer\s+\S+|authorization\s*[:=])/i;
const GUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const SECRET_WORD_PATTERN = /(secret|key|token|password)/i;
const MARKDOWN_EXTERNAL_LINK_PATTERN = /!?\[[^\]]*]\(\s*(?:https?:|www\.)[^)]*\)/i;
const HTML_TAG_PATTERN = /<\/?[a-z][^>]*>/i;
// Matching control characters is the point of this pattern.
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_PATTERN = new RegExp('[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]');
const MARKDOWN_FENCE_PATTERN = /```/;

export type ForbiddenPatternCode =
  | 'URL'
  | 'EMAIL'
  | 'PHONE'
  | 'BASE64_BLOB'
  | 'CREDENTIAL_SHAPED'
  | 'EXTERNAL_LINK'
  | 'HTML_TAG'
  | 'CONTROL_CHARACTER'
  | 'MARKDOWN_FENCE';

/** A GUID next to a word like "secret" or "key" reads as `<id>: <secret>`
 * even without matching the keyword pattern above on its own -- an
 * OAuth-client-id-plus-secret pair is exactly the shape AGENTS.md forbids. */
function hasGuidNearSecretWord(text: string): boolean {
  const match = GUID_PATTERN.exec(text);
  if (match === null) return false;
  const windowStart = Math.max(0, match.index - 60);
  const windowEnd = Math.min(text.length, match.index + match[0].length + 60);
  return SECRET_WORD_PATTERN.test(text.slice(windowStart, windowEnd));
}

/**
 * Returns the first forbidden-pattern class found in `text`, in a fixed
 * priority order, or `null` if none match. The order only makes the single
 * reported reason deterministic when more than one class matches; it is
 * not a claim about severity. `PHONE` is checked last because it is the
 * broadest, most false-positive-prone pattern (any run of seven-plus
 * digits), so a more specific match is reported first when both apply.
 */
export function findForbiddenPattern(text: string): ForbiddenPatternCode | null {
  if (CONTROL_CHAR_PATTERN.test(text)) return 'CONTROL_CHARACTER';
  if (MARKDOWN_EXTERNAL_LINK_PATTERN.test(text)) return 'EXTERNAL_LINK';
  if (HTML_TAG_PATTERN.test(text)) return 'HTML_TAG';
  if (MARKDOWN_FENCE_PATTERN.test(text)) return 'MARKDOWN_FENCE';
  if (URL_PATTERN.test(text) || WWW_PATTERN.test(text)) return 'URL';
  if (EMAIL_PATTERN.test(text)) return 'EMAIL';
  if (CREDENTIAL_KEYWORD_PATTERN.test(text) || hasGuidNearSecretWord(text))
    return 'CREDENTIAL_SHAPED';
  if (BASE64_BLOB_PATTERN.test(text)) return 'BASE64_BLOB';
  // A GUID's hyphen-separated hex groups can themselves satisfy the phone
  // pattern (e.g. "5717-4562" inside "...-5717-4562-..."), so a bare node
  // or tracking id would otherwise be misreported as a phone number. GUID
  // spans are stripped before this check runs; a real phone number
  // elsewhere in the same text is still caught.
  if (PHONE_PATTERN.test(text.replace(new RegExp(GUID_PATTERN.source, 'gi'), ''))) return 'PHONE';
  return null;
}
