// packages/documentation/src/escape.ts
//
// Flow names, prompt text, menu labels, expressions, and data-action field
// names are authored by whoever configures the customer's IVR. Per AGENTS.md,
// all extracted flow content is untrusted data, never instructions. These
// three functions are the last line before that text reaches a generated
// Markdown document or a Mermaid diagram source string.

// Matching control characters is the point of this pattern: it strips them
// from tenant-controlled text before it can reach any rendered document.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

const MERMAID_LABEL_MAX_LENGTH = 80;

/**
 * Neutralises tenant-controlled text before it is embedded in generated
 * Markdown. Escapes Markdown syntax that could break out of the surrounding
 * document structure (links, headings, emphasis) or inject raw HTML, and
 * strips control characters.
 */
export function escapeMarkdown(text: string): string {
  const withoutControlChars = text.replace(CONTROL_CHARS, '');

  // Escape characters that carry Markdown structural meaning: link/image
  // delimiters, heading/list/blockquote markers, emphasis, code fences,
  // and HTML angle brackets. Backslash must be escaped first so the
  // escapes added below are not themselves re-escaped.
  let out = withoutControlChars.replace(/\\/g, '\\\\');
  out = out.replace(/[[\]()*_`~#>|{}!<]/g, (char) => `\\${char}`);

  return out;
}

/**
 * Neutralises tenant-controlled text before it is embedded in a Markdown
 * table cell. A cell must not be able to add columns (`|`) or end the row
 * (a newline), so those are replaced rather than escaped — a backslash
 * escape inside a table cell is unreliable across renderers.
 */
export function escapeTableCell(text: string): string {
  const withoutControlChars = text.replace(CONTROL_CHARS, '');
  return withoutControlChars.replace(/\r\n|\r|\n/g, ' ').replace(/\|/g, '\\|');
}

/**
 * Neutralises tenant-controlled text before it is embedded in a Mermaid
 * diagram label. Mermaid source is a small language in its own right:
 * `-->` is the edge operator, `"` ends a quoted label, `[`, `{`, `(` change
 * node shape or terminate a definition early, and a `%%{...}%%` sequence is
 * a directive that reconfigures the renderer from inside what was supposed
 * to be data. Output is also bounded in length, because one very long label
 * makes a diagram unreadable — its own kind of denial of service against
 * the reader.
 */
export function escapeMermaidLabel(text: string): string {
  const withoutControlChars = text.replace(CONTROL_CHARS, '');

  let out = withoutControlChars
    // Directive delimiter: neutralise before anything else can re-form it.
    .replace(/%%/g, 'pct-pct')
    // Edge operators and comment marker.
    .replace(/-->/g, '-to-')
    .replace(/==>/g, '-to-')
    .replace(/---/g, '-')
    // Quotes end a quoted label.
    .replace(/"/g, "'")
    // Shape-changing / definition-terminating delimiters.
    .replace(/[[({]/g, '(')
    .replace(/[\])}]/g, ')')
    // Newlines would break the label onto a new diagram statement.
    .replace(/\r\n|\r|\n/g, ' ');

  if (out.length > MERMAID_LABEL_MAX_LENGTH) {
    out = `${out.slice(0, MERMAID_LABEL_MAX_LENGTH - 1)}…`;
  }

  return out;
}
