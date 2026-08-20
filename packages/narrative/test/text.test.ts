// packages/narrative/test/text.test.ts
//
// Every non-ASCII or control character this file needs is built with
// String.fromCharCode from its numeric code point rather than typed
// literally, so the test file itself stays plain ASCII and unambiguous
// about exactly which character it is asserting on.
import { describe, expect, it } from 'vitest';
import { sanitizeUntrustedString, makeUntrustedText } from '../src/text.js';

const NUL = String.fromCharCode(0x0000);
const BEL = String.fromCharCode(0x0007);
const VT = String.fromCharCode(0x000b);
const US = String.fromCharCode(0x001f);
const DEL = String.fromCharCode(0x007f);
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);
const RTL_OVERRIDE = String.fromCharCode(0x202e);
const BOM = String.fromCharCode(0xfeff);

describe('sanitizeUntrustedString', () => {
  it('normalizes to NFC', () => {
    // "e" + combining acute accent (U+0065 U+0301) vs. the precomposed
    // "e with acute" (U+00E9).
    const decomposed = 'caf' + 'e' + String.fromCharCode(0x0301);
    const precomposed = 'caf' + String.fromCharCode(0x00e9);
    expect(decomposed).not.toBe(precomposed);
    expect(sanitizeUntrustedString(decomposed)).toBe(precomposed);
  });

  it('strips C0 control characters and DEL', () => {
    const withControls = `a${NUL}b${BEL}c${VT}d${US}ef${DEL}`;
    expect(sanitizeUntrustedString(withControls)).toBe('abcdef');
  });

  it('keeps newline, tab, and carriage return', () => {
    expect(sanitizeUntrustedString('line1\nline2\ttab\r\n')).toBe('line1\nline2\ttab\r\n');
  });

  it('strips zero-width, RTL-override, and byte-order-mark characters', () => {
    const poisoned = `ignore${ZERO_WIDTH_SPACE}${RTL_OVERRIDE}text${BOM}`;
    expect(sanitizeUntrustedString(poisoned)).toBe('ignoretext');
  });

  it('is idempotent', () => {
    const input = `Menu ${ZERO_WIDTH_SPACE}"Sales"${RTL_OVERRIDE} end`;
    const once = sanitizeUntrustedString(input);
    expect(sanitizeUntrustedString(once)).toBe(once);
  });
});

describe('makeUntrustedText', () => {
  it('does not truncate a short value', () => {
    const result = makeUntrustedText('hello', 'sha256:abc', 100);
    expect(result).toEqual({
      kind: 'untrusted-text',
      value: 'hello',
      truncatedAt: null,
      evidenceId: 'sha256:abc',
    });
  });

  it('truncates a long value and records the cut length', () => {
    const raw = 'x'.repeat(5000);
    const result = makeUntrustedText(raw, 'sha256:abc', 100);
    expect(result.value).toHaveLength(100);
    expect(result.truncatedAt).toBe(100);
    expect(result.value.length).toBe(result.truncatedAt);
  });

  it('truncates a 2MB string rather than including it whole', () => {
    const twoMegabytes = 'a'.repeat(2 * 1024 * 1024);
    const result = makeUntrustedText(twoMegabytes, 'sha256:abc', 1000);
    expect(result.value).toHaveLength(1000);
    expect(result.truncatedAt).toBe(1000);
  });

  it('sanitizes before measuring length, so stripped characters do not count', () => {
    const raw = ZERO_WIDTH_SPACE.repeat(50) + 'short';
    const result = makeUntrustedText(raw, 'sha256:abc', 100);
    expect(result.value).toBe('short');
    expect(result.truncatedAt).toBeNull();
  });
});
