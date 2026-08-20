import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PlatformApiClient } from '../src/client.js';
import { PlatformApiError } from '../src/errors.js';
import type { TokenProvider } from '../src/token.js';
import { createFakeFetch, createRecordingLogger, fixedClock, immediateSleep } from './helpers.js';

const CANARY_TOKEN = 'CANARY-TOKEN-7b21ce';

function fixedTokenProvider(token = CANARY_TOKEN): TokenProvider {
  return { getToken: () => Promise.resolve(token) };
}

function makeClient(
  fake: ReturnType<typeof createFakeFetch>,
  overrides: Partial<{ maxRetries: number; maxRequests: number }> = {},
): PlatformApiClient {
  return new PlatformApiClient({
    apiHost: 'api.mypurecloud.ie',
    tokenProvider: fixedTokenProvider(),
    fetch: fake.fetch,
    sleep: immediateSleep(),
    now: fixedClock('2026-08-20T00:00:00Z'),
    ...overrides,
  });
}

const stringSchema = z.object({ id: z.string() });

describe('PlatformApiClient.get', () => {
  it('attaches the bearer token and validates the response against the schema', async () => {
    const fake = createFakeFetch();
    fake.queueJson({ id: 'abc' });
    const client = makeClient(fake);
    const result = await client.get('/api/v2/flows/abc', { schema: stringSchema });
    expect(result).toEqual({ id: 'abc' });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.method).toBe('GET');
    expect(fake.calls[0]?.headers['authorization']).toBe(`Bearer ${CANARY_TOKEN}`);
  });

  it('serializes query parameters, including arrays as repeated keys', async () => {
    const fake = createFakeFetch();
    fake.queueJson({ id: 'abc' });
    const client = makeClient(fake);
    await client.get('/api/v2/flows', {
      query: { type: ['inboundcall', 'workflow'], pageNumber: 1, missing: undefined },
      schema: stringSchema,
    });
    const url = new URL(fake.calls[0]!.url);
    expect(url.searchParams.getAll('type')).toEqual(['inboundcall', 'workflow']);
    expect(url.searchParams.get('pageNumber')).toBe('1');
    expect(url.searchParams.has('missing')).toBe(false);
  });

  it('captures ININ-Correlation-Id on both success and failure', async () => {
    const fake = createFakeFetch();
    fake.queue(
      new Response('not found', { status: 404, headers: { 'inin-correlation-id': 'corr-abc' } }),
    );
    const client = makeClient(fake);
    await expect(
      client.get('/api/v2/flows/missing', { schema: stringSchema }),
    ).rejects.toMatchObject({
      correlationId: 'corr-abc',
    });
  });

  for (const status of [400, 401, 403, 404] as const) {
    it(`does not retry a ${String(status)} and maps it to a typed, non-retryable error`, async () => {
      const fake = createFakeFetch();
      fake.queue(new Response('', { status }));
      const client = makeClient(fake);
      await expect(client.get('/api/v2/flows/x', { schema: stringSchema })).rejects.toBeInstanceOf(
        PlatformApiError,
      );
      expect(fake.calls).toHaveLength(1);
    });
  }

  it('retries a 500 then succeeds', async () => {
    const fake = createFakeFetch();
    fake.queue(new Response('', { status: 500 }));
    fake.queueJson({ id: 'ok' });
    const client = makeClient(fake);
    const result = await client.get('/api/v2/flows/x', { schema: stringSchema });
    expect(result).toEqual({ id: 'ok' });
    expect(fake.calls).toHaveLength(2);
  });

  it('exhausts the retry budget on persistent 5xx and throws a retryable server error', async () => {
    const fake = createFakeFetch();
    const client = makeClient(fake, { maxRetries: 2 });
    for (let i = 0; i < 10; i++) fake.queue(new Response('', { status: 503 }));
    await expect(client.get('/api/v2/flows/x', { schema: stringSchema })).rejects.toMatchObject({
      category: 'server',
      retryable: true,
    });
    expect(fake.calls).toHaveLength(3); // initial + 2 retries
  });

  it('retries a 429 honouring a short Retry-After', async () => {
    const fake = createFakeFetch();
    fake.queue(new Response('', { status: 429, headers: { 'retry-after': '1' } }));
    fake.queueJson({ id: 'ok' });
    const client = makeClient(fake);
    const result = await client.get('/api/v2/flows/x', { schema: stringSchema });
    expect(result).toEqual({ id: 'ok' });
  });

  it('refuses a 429 with no Retry-After rather than guessing a delay', async () => {
    const fake = createFakeFetch();
    fake.queue(new Response('', { status: 429 }));
    const client = makeClient(fake);
    await expect(client.get('/api/v2/flows/x', { schema: stringSchema })).rejects.toMatchObject({
      category: 'rate_limit',
    });
    expect(fake.calls).toHaveLength(1);
  });

  it('refuses a ten-minute Retry-After rather than sleeping through it', async () => {
    const fake = createFakeFetch();
    fake.queue(new Response('', { status: 429, headers: { 'retry-after': String(10 * 60) } }));
    const client = makeClient(fake);
    await expect(client.get('/api/v2/flows/x', { schema: stringSchema })).rejects.toMatchObject({
      category: 'rate_limit',
      retryable: true,
    });
    // Refused on the first attempt: no sleep, no retry request issued.
    expect(fake.calls).toHaveLength(1);
  });

  it('throws a validation error on malformed JSON', async () => {
    const fake = createFakeFetch();
    fake.queue(new Response('not json', { status: 200 }));
    const client = makeClient(fake);
    await expect(client.get('/api/v2/flows/x', { schema: stringSchema })).rejects.toMatchObject({
      category: 'validation',
    });
  });

  it('throws a validation error when the response fails schema validation', async () => {
    const fake = createFakeFetch();
    fake.queueJson({ nope: true });
    const client = makeClient(fake);
    await expect(client.get('/api/v2/flows/x', { schema: stringSchema })).rejects.toMatchObject({
      category: 'validation',
    });
  });

  it('enforces a request budget so a run cannot loop forever', async () => {
    const fake = createFakeFetch();
    fake.queueJson({ id: 'ok' });
    const client = makeClient(fake, { maxRequests: 1 });
    await client.get('/api/v2/flows/x', { schema: stringSchema });
    await expect(client.get('/api/v2/flows/y', { schema: stringSchema })).rejects.toMatchObject({
      category: 'transport',
    });
    expect(fake.calls).toHaveLength(1);
  });

  it('logs request metadata but never the bearer token or response body', async () => {
    const fake = createFakeFetch();
    fake.queueJson({ id: 'secret-shaped-value' });
    const { logger, lines } = createRecordingLogger();
    const client = new PlatformApiClient({
      apiHost: 'api.mypurecloud.ie',
      tokenProvider: fixedTokenProvider(),
      fetch: fake.fetch,
      sleep: immediateSleep(),
      now: fixedClock('2026-08-20T00:00:00Z'),
      logger,
    });
    await client.get('/api/v2/flows/x', { schema: stringSchema });
    const joined = lines.join('\n');
    expect(joined).not.toContain(CANARY_TOKEN);
  });
});

describe('PlatformApiClient.getBinary', () => {
  it('fetches bytes and content type without touching them beyond returning them', async () => {
    const fake = createFakeFetch();
    fake.queue(
      new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { 'content-type': 'audio/wav' },
      }),
    );
    const client = makeClient(fake);
    const result = await client.getBinary('/api/v2/architect/prompts/p1/resources/en-us/audio');
    expect(result.contentType).toBe('audio/wav');
    expect(Array.from(result.bytes)).toEqual([1, 2, 3, 4]);
  });

  it('fetches from an absolute signed media URI without prefixing it with the API host', async () => {
    const fake = createFakeFetch();
    fake.queue(new Response(new Uint8Array([9]), { status: 200 }));
    const client = makeClient(fake);
    await client.getBinary('https://media.example.mypurecloud.ie/signed/xyz?sig=abc');
    expect(fake.calls[0]?.url).toBe('https://media.example.mypurecloud.ie/signed/xyz?sig=abc');
  });

  // docs/spikes/S5-prompt-audio.md: every sampled download succeeded with
  // NO Authorization header at all, and treats the media URI itself as a
  // bearer credential -- sending our own token to a host chosen by an
  // upstream response, rather than by us, is precisely the leak AGENTS.md's
  // first rule forbids.
  it('attaches the bearer token for the configured API host', async () => {
    const fake = createFakeFetch();
    fake.queueJson({ id: 'x' });
    const client = makeClient(fake);
    await client.get('/api/v2/flows/x', { schema: stringSchema });
    expect(fake.calls[0]?.headers['authorization']).toBe(`Bearer ${CANARY_TOKEN}`);
  });

  it('does NOT attach the bearer token for a media/asset host other than the API host', async () => {
    const fake = createFakeFetch();
    fake.queue(new Response(new Uint8Array([1]), { status: 200 }));
    const client = makeClient(fake);
    await client.getBinary('https://media.example.mypurecloud.ie/signed/xyz?sig=abc');
    expect(fake.calls[0]?.headers['authorization']).toBeUndefined();
  });

  it('classifies a 403 from a media host as expired_asset_url, not permission', async () => {
    const fake = createFakeFetch();
    fake.queue(new Response('', { status: 403 }));
    const client = makeClient(fake);
    await expect(
      client.getBinary('https://media.example.mypurecloud.ie/signed/xyz?sig=abc'),
    ).rejects.toMatchObject({ category: 'expired_asset_url', retryable: true, status: 403 });
    // Never retried automatically with the same (still-expired) URL.
    expect(fake.calls).toHaveLength(1);
  });

  it('still classifies a 403 from the API host as permission', async () => {
    const fake = createFakeFetch();
    fake.queue(new Response('', { status: 403 }));
    const client = makeClient(fake);
    await expect(
      client.get('/api/v2/routing/queues/q1', { schema: stringSchema }),
    ).rejects.toMatchObject({
      category: 'permission',
      retryable: false,
    });
  });

  it('never leaks a signed media URL into a thrown error, its message, or its stack', async () => {
    const CANARY_URL = 'https://media.example.mypurecloud.ie/CANARY-SIGNED-URL-a71c?sig=xyz';
    const fake = createFakeFetch();
    fake.queue(new Response('', { status: 403 }));
    const client = makeClient(fake);
    let caught: unknown;
    try {
      await client.getBinary(CANARY_URL);
    } catch (err) {
      caught = err;
    }
    const serialized =
      JSON.stringify(caught) + String((caught as Error).stack) + (caught as Error).message;
    expect(serialized).not.toContain('CANARY-SIGNED-URL-a71c');
  });

  it('never leaks a signed media URL through the logger', async () => {
    const CANARY_URL = 'https://media.example.mypurecloud.ie/CANARY-SIGNED-URL-a71c?sig=xyz';
    const fake = createFakeFetch();
    fake.queue(new Response(new Uint8Array([1]), { status: 200 }));
    const { logger, lines } = createRecordingLogger();
    const client = new PlatformApiClient({
      apiHost: 'api.mypurecloud.ie',
      tokenProvider: fixedTokenProvider(),
      fetch: fake.fetch,
      sleep: immediateSleep(),
      now: fixedClock('2026-08-20T00:00:00Z'),
      logger,
    });
    await client.getBinary(CANARY_URL);
    expect(lines.join('\n')).not.toContain('CANARY-SIGNED-URL-a71c');
  });
});

describe('read-only structural guarantee', () => {
  it('PlatformApiClient exposes no method that could issue anything but GET', () => {
    const proto = Object.getPrototypeOf(
      new PlatformApiClient({
        apiHost: 'api.mypurecloud.ie',
        tokenProvider: fixedTokenProvider(),
        fetch: createFakeFetch().fetch,
        sleep: immediateSleep(),
        now: fixedClock('2026-08-20T00:00:00Z'),
      }),
    ) as object;
    const publicMethods = Object.getOwnPropertyNames(proto).filter(
      (name) => name !== 'constructor' && !name.startsWith('#'),
    );
    // The entire public surface is exactly these two read operations, plus
    // the requestCount accessor. Nothing named create/update/delete/post/put
    // /patch can exist here without this assertion failing.
    expect(new Set(publicMethods).has('get')).toBe(true);
    expect(new Set(publicMethods).has('getBinary')).toBe(true);
    for (const name of publicMethods) {
      expect(name).not.toMatch(/post|put|patch|delete|create|update|remove/i);
    }
  });
});
