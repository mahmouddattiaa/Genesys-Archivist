// packages/documentation/test/escape.test.ts
import { describe, expect, it } from 'vitest';
import { escapeMarkdown, escapeMermaidLabel, escapeTableCell } from '../src/escape.js';

describe('escapeMarkdown', () => {
  it('neutralises a link break-out', () => {
    expect(escapeMarkdown('](javascript:alert(1))')).not.toContain('](javascript:');
  });
  it('neutralises raw HTML', () => {
    expect(escapeMarkdown('<script>x</script>')).not.toContain('<script>');
  });
  it('neutralises a heading injected at line start', () => {
    expect(escapeMarkdown('# Fake Heading')).not.toMatch(/^# /);
  });
  it('strips control characters', () => {
    expect(escapeMarkdown(`a${String.fromCharCode(0)}b`)).toBe('ab');
  });
  it('leaves ordinary text alone', () => {
    expect(escapeMarkdown('Main Service IVR')).toBe('Main Service IVR');
  });
});

describe('escapeTableCell', () => {
  it('escapes a pipe so a cell cannot add columns', () => {
    expect(escapeTableCell('a|b')).not.toBe('a|b');
  });
  it('collapses newlines, which would break the row', () => {
    expect(escapeTableCell('a\nb')).not.toContain('\n');
  });
});

describe('escapeMermaidLabel', () => {
  it('neutralises the comment sequence', () => {
    expect(escapeMermaidLabel('a --> b')).not.toContain('-->');
  });
  it('neutralises quotes that would end the label', () => {
    expect(escapeMermaidLabel('say "hi"')).not.toContain('"');
  });
  it('neutralises brackets that would change node shape', () => {
    const out = escapeMermaidLabel('a[b]{c}(d)');
    expect(out).not.toContain('[');
    expect(out).not.toContain('{');
  });
  it('strips a directive', () => {
    expect(escapeMermaidLabel('%%{init:{"x":1}}%%')).not.toContain('%%');
  });
  it('bounds length so one label cannot dominate a diagram', () => {
    expect(escapeMermaidLabel('x'.repeat(500)).length).toBeLessThanOrEqual(80);
  });
});

describe('escapeTableCell: raw HTML', () => {
  // Table cells carry the majority of tenant text in these documents -- every
  // dependency display name, queue name and prompt name -- and the documents
  // are rendered to PDF through headless Chromium. Raw markup in a cell
  // therefore reaches a real browser.
  it('neutralises a script tag in a display name', () => {
    const cell = escapeTableCell('<script>alert(1)</script>');
    expect(cell).not.toContain('<script>');
    expect(cell).not.toContain('</script>');
    expect(cell).toContain('&lt;script&gt;');
  });

  it('neutralises an img onerror payload', () => {
    expect(escapeTableCell('<img src=x onerror=alert(1)>')).not.toMatch(/<img/i);
  });

  it('neutralises an HTML comment, which could swallow the rest of the table', () => {
    const cell = escapeTableCell('<!-- everything after this vanishes');
    expect(cell).not.toContain('<!--');
  });

  it('encodes ampersands first so a literal entity cannot round-trip into a tag', () => {
    // Without encoding `&` first, a tenant writing `&lt;script&gt;` would be
    // rendered by the browser as a real `<script>` tag.
    expect(escapeTableCell('&lt;script&gt;')).toBe('&amp;lt;script&amp;gt;');
  });

  it('still prevents column injection and row termination', () => {
    expect(escapeTableCell('a|b')).toBe(String.raw`a\|b`);
    expect(escapeTableCell('a\nb')).toBe('a b');
  });

  it('leaves ordinary text alone', () => {
    expect(escapeTableCell('Main Menu (English)')).toBe('Main Menu (English)');
  });
});
