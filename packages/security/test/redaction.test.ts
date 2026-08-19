// packages/security/test/redaction.test.ts
import { describe, expect, it } from 'vitest';
import { defaultPolicy, redact } from '../src/redaction.js';

describe('redact', () => {
  it('redacts a known-sensitive key at any depth', () => {
    const input = { a: { b: { authorization: 'Bearer abc123' } } };
    const { value } = redact(input, defaultPolicy);
    expect(JSON.stringify(value)).toContain('[REDACTED:authorization]');
    expect(JSON.stringify(value)).not.toContain('abc123');
  });

  it('redacts inside arrays', () => {
    const { value } = redact({ headers: [{ password: 'hunter2' }] }, defaultPolicy);
    expect(JSON.stringify(value)).not.toContain('hunter2');
  });

  it('strips credentials from a URL but keeps the host and path', () => {
    const { value } = redact({ url: 'https://u:p@api.example.com/v1/x' }, defaultPolicy);
    expect(JSON.stringify(value)).toContain('api.example.com/v1/x');
    expect(JSON.stringify(value)).not.toContain('u:p@');
  });

  it('preserves template placeholders because migration needs them', () => {
    const { value } = redact({ headerTemplate: 'Bearer ${credentials.apiKey}' }, defaultPolicy);
    expect(JSON.stringify(value)).toContain('${credentials.apiKey}');
  });

  it('strips control characters from tenant text', () => {
    const { value } = redact({ flowName: 'Main\u001fMenu\u0000' }, defaultPolicy);
    expect(JSON.stringify(value)).not.toContain('\u001f');
    expect(JSON.stringify(value)).not.toContain('\u0000');
  });

  it('counts what it redacted, by category', () => {
    const { counts } = redact({ a: { password: 'x' }, b: { password: 'y' } }, defaultPolicy);
    expect(counts.get('password')).toBe(2);
  });

  it('is idempotent so hashes stay stable', () => {
    const once = redact({ authorization: 'Bearer abc' }, defaultPolicy);
    const twice = redact(once.value, defaultPolicy);
    expect(JSON.stringify(twice.value)).toBe(JSON.stringify(once.value));
  });

  it('never returns the original secret anywhere in the result', () => {
    const canary = 'CANARY-8f3a1c-DO-NOT-LEAK';
    const { value, counts } = redact({ clientSecret: canary }, defaultPolicy);
    expect(JSON.stringify({ value, counts: [...counts] })).not.toContain(canary);
  });
});
