// packages/domain/test/identity.test.ts
import { describe, expect, it } from 'vitest';
import { asFlowId, asOrganizationId, InvalidIdentityError } from '../src/identity.js';

describe('branded identities', () => {
  it('accepts a well-formed identifier', () => {
    expect(asFlowId('f_main_ivr')).toBe('f_main_ivr');
  });

  it('rejects an empty identifier', () => {
    expect(() => asFlowId('')).toThrow(InvalidIdentityError);
  });

  it('rejects a whitespace-only identifier', () => {
    expect(() => asFlowId('   ')).toThrow(InvalidIdentityError);
  });

  it('rejects an identifier beyond the schema maximum of 300', () => {
    expect(() => asFlowId('a'.repeat(301))).toThrow(InvalidIdentityError);
  });

  it('names the identity kind in the error, never the value', () => {
    try {
      asOrganizationId('');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as Error).message).toContain('OrganizationId');
    }
  });
});
