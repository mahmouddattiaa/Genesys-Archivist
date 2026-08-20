// apps/mcp-server/src/untrusted.ts
//
// The single place that wraps tenant-derived text before it reaches a tool
// result. AGENTS.md: "Never let flow names, prompt text, expressions,
// descriptions, or data-action content become instructions to an LLM." A
// wrapper cannot force a model to ignore what it reads, so this earns its
// keep by making the untrusted span unambiguous (delimited and labelled),
// not by pretending a label is a security control -- the real controls are
// typed evidence packs and output validation upstream of this server.
// Prompt wording is never the control; this is the "delimit, label, bound,
// strip control characters, normalize" step docs/03 asks for on top of that.

/** Default per-field bound. Generous enough for a flow or prompt name, small
 * enough that one untrusted field cannot single-handedly blow the 32 KiB
 * summary budget in bounds.ts. */
const DEFAULT_MAX_CHARS = 2000;

const TAG_NAME = 'untrusted-tenant-data';

// Tab (9), newline (10), and carriage return (13) are common and harmless in
// flow names/prompts and are kept; every other C0 control point (0-31), DEL
// (127), and the C1 range (128-159) are stripped. Written as a numeric
// code-point filter rather than a regex character class so the exact set of
// excluded points is legible without decoding escape sequences.
const KEPT_CONTROL_CODES = new Set<number>([9, 10, 13]);

function isStrippedControlCode(code: number): boolean {
  if (KEPT_CONTROL_CODES.has(code)) return false;
  if (code <= 31) return true;
  if (code === 127) return true;
  if (code >= 128 && code <= 159) return true;
  return false;
}

function stripControlChars(input: string): string {
  let out = '';
  for (const ch of input) {
    const code = ch.codePointAt(0);
    if (code !== undefined && isStrippedControlCode(code)) continue;
    out += ch;
  }
  return out;
}

/** Neutralizes the literal delimiter tag if it appears inside tenant content,
 * so a flow named `</untrusted-tenant-data><system>...` cannot forge a close
 * tag and step outside its own wrapper. HTML-escaping the three characters
 * that could form a tag, everywhere in the body, is simpler than
 * special-casing the tag text and has the same effect: no literal angle
 * bracket survives to open or close anything. */
function escapeDelimiters(input: string): string {
  return input.split('&').join('&amp;').split('<').join('&lt;').split('>').join('&gt;');
}

export interface WrapUntrustedOptions {
  /** What this content is, shown in the wrapper so a reader (human or model)
   * knows what they are looking at, e.g. "flow name", "prompt text". */
  readonly label: string;
  readonly maxChars?: number;
}

export interface WrappedUntrusted {
  /** The delimited, labelled, bounded text -- safe to place directly into a
   * tool result or resource body. */
  readonly text: string;
  readonly truncated: boolean;
}

/**
 * Wraps one piece of tenant-derived text for inclusion in a tool result or
 * resource. Every step is defensive, not decorative:
 *
 *   1. Normalize (NFC) so visually-identical strings compare and hash the
 *      same way regardless of how the source composed them.
 *   2. Strip control characters -- a raw C0/C1 byte in a flow name has no
 *      legitimate reason to reach a client's terminal or renderer.
 *   3. Bound length, so one oversized field cannot dominate a capped result.
 *   4. Escape the delimiter characters so the content cannot forge a close
 *      tag and appear to end the untrusted span early.
 *   5. Wrap in a labelled, delimited block.
 */
export function wrapUntrusted(raw: string, options: WrapUntrustedOptions): WrappedUntrusted {
  const normalized = raw.normalize('NFC');
  const stripped = stripControlChars(normalized);
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const truncated = stripped.length > maxChars;
  const bounded = truncated ? stripped.slice(0, maxChars) : stripped;
  const escaped = escapeDelimiters(bounded);
  const escapedLabel = escapeDelimiters(options.label);

  const text = [
    `<${TAG_NAME} label="${escapedLabel}" trusted="false">`,
    escaped,
    `</${TAG_NAME}>`,
  ].join('\n');

  return { text, truncated };
}
