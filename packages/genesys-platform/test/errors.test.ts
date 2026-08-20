import { describe, expect, it } from 'vitest';
import { PlatformApiError } from '../src/errors.js';

describe('PlatformApiError', () => {
  it('carries only the allow-listed fields, never a body or arbitrary header', () => {
    const err = new PlatformApiError({
      status: 403,
      category: 'permission',
      retryable: false,
      correlationId: 'corr-123',
      endpoint: '/api/v2/routing/queues/abc',
      message: 'The connected OAuth client lacks a permission this operation requires.',
    });

    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('PlatformApiError');
    expect(err.status).toBe(403);
    expect(err.category).toBe('permission');
    expect(err.retryable).toBe(false);
    expect(err.correlationId).toBe('corr-123');
    expect(err.endpoint).toBe('/api/v2/routing/queues/abc');

    // Structural: the only own-enumerable fields beyond what Error itself
    // provides are the six documented ones. Anything else appearing here
    // would mean a call site smuggled extra data onto the instance.
    const own = Object.keys(err);
    expect(new Set(own)).toEqual(
      new Set(['name', 'status', 'category', 'retryable', 'correlationId', 'endpoint']),
    );
  });

  it('toJSON serializes exactly the allow-listed fields', () => {
    const err = new PlatformApiError({
      status: 500,
      category: 'server',
      retryable: true,
      correlationId: null,
      endpoint: '/api/v2/flows',
      message: 'Genesys Cloud returned a server error.',
    });
    const json = err.toJSON();
    expect(new Set(Object.keys(json))).toEqual(
      new Set(['name', 'message', 'status', 'category', 'retryable', 'correlationId', 'endpoint']),
    );
    expect(JSON.stringify(err)).toBe(JSON.stringify(json));
  });

  it('has no constructor parameter or field for a request or response body', () => {
    // Compile-time proof lives in the type signature (PlatformApiErrorInit
    // has no `body` or `headers` field); this is the runtime companion,
    // confirming no such property exists on a real instance either.
    const err = new PlatformApiError({
      status: 400,
      category: 'validation',
      retryable: false,
      correlationId: null,
      endpoint: '/api/v2/flows',
      message: 'Genesys Cloud rejected the request as invalid.',
    });
    expect('body' in err).toBe(false);
    expect('headers' in err).toBe(false);
    expect('response' in err).toBe(false);
    expect('request' in err).toBe(false);
  });
});
