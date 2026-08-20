import { describe, expect, it } from 'vitest';
import { redactResourceBody } from '../src/redact-resource.js';

describe('redactResourceBody', () => {
  it('strips credential-shaped fields defensively, even though S3 found them structurally absent', () => {
    const result = redactResourceBody({
      id: 'i1',
      name: 'Web Services',
      credentials: { username: 'svc', password: 'CANARY-PASSWORD-abc' },
    }) as Record<string, unknown>;
    expect(JSON.stringify(result)).not.toContain('CANARY-PASSWORD-abc');
    expect((result['credentials'] as Record<string, unknown>)['password']).not.toBe(
      'CANARY-PASSWORD-abc',
    );
  });

  it('strips the general-purpose fields the shared logger policy already knows', () => {
    const result = redactResourceBody({
      clientSecret: 'CANARY-SECRET-1',
      accessToken: 'CANARY-TOKEN-1',
    }) as Record<string, unknown>;
    expect(JSON.stringify(result)).not.toContain('CANARY-SECRET-1');
    expect(JSON.stringify(result)).not.toContain('CANARY-TOKEN-1');
  });

  it('leaves ordinary tenant content untouched', () => {
    const result = redactResourceBody({ name: 'Sales Queue', id: 'q1' });
    expect(result).toEqual({ name: 'Sales Queue', id: 'q1' });
  });
});
