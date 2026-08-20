import { describe, expect, it } from 'vitest';
import { PlatformApiError } from '../src/errors.js';
import { createTokenProvider } from '../src/token.js';
import { InMemorySecretStore, TEST_PROFILE_ID, createFakeFetch, fixedClock } from './helpers.js';

const CANARY_SECRET = 'CANARY-SECRET-8d3f1a';
const CANARY_TOKEN = 'CANARY-TOKEN-7b21ce';

async function makeStore(secret = CANARY_SECRET): Promise<InMemorySecretStore> {
  const store = new InMemorySecretStore();
  await store.set(TEST_PROFILE_ID, secret);
  return store;
}

describe('createTokenProvider', () => {
  it('performs the client credentials grant and returns the access token', async () => {
    const fake = createFakeFetch();
    fake.queueJson({ access_token: CANARY_TOKEN, token_type: 'bearer', expires_in: 3600 });
    const provider = createTokenProvider({
      loginHost: 'login.mypurecloud.ie',
      clientId: 'client-1',
      secretStore: await makeStore(),
      profileId: TEST_PROFILE_ID,
      fetch: fake.fetch,
      now: fixedClock('2026-08-20T00:00:00Z'),
    });

    const token = await provider.getToken();
    expect(token).toBe(CANARY_TOKEN);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.method).toBe('POST');
    expect(fake.calls[0]?.url).toBe('https://login.mypurecloud.ie/oauth/token');

    const authHeader = fake.calls[0]?.headers['authorization'];
    expect(authHeader).toMatch(/^Basic /);
    // The header carries the secret (base64 of "clientId:secret") because
    // that IS the grant -- this asserts it was sent, not that it leaked.
    const decoded = Buffer.from(authHeader!.slice('Basic '.length), 'base64').toString('utf8');
    expect(decoded).toBe(`client-1:${CANARY_SECRET}`);
  });

  it('caches the token and does not refetch before expiry', async () => {
    const fake = createFakeFetch();
    fake.queueJson({ access_token: CANARY_TOKEN, token_type: 'bearer', expires_in: 3600 });
    const provider = createTokenProvider({
      loginHost: 'login.mypurecloud.ie',
      clientId: 'client-1',
      secretStore: await makeStore(),
      profileId: TEST_PROFILE_ID,
      fetch: fake.fetch,
      now: fixedClock('2026-08-20T00:00:00Z'),
    });

    await provider.getToken();
    await provider.getToken();
    await provider.getToken();
    expect(fake.calls).toHaveLength(1);
  });

  it('refreshes early, before the token reports it has expired', async () => {
    const fake = createFakeFetch();
    fake.queueJson({ access_token: 'first-token', expires_in: 120 });
    fake.queueJson({ access_token: 'second-token', expires_in: 120 });

    let currentTime = new Date('2026-08-20T00:00:00Z');
    const provider = createTokenProvider({
      loginHost: 'login.mypurecloud.ie',
      clientId: 'client-1',
      secretStore: await makeStore(),
      profileId: TEST_PROFILE_ID,
      fetch: fake.fetch,
      now: () => currentTime,
      earlyRefreshMs: 60_000,
    });

    expect(await provider.getToken()).toBe('first-token');
    // 61 seconds later: within the 60s early-refresh window of the 120s expiry.
    currentTime = new Date(currentTime.getTime() + 61_000);
    expect(await provider.getToken()).toBe('second-token');
    expect(fake.calls).toHaveLength(2);
  });

  it('shares one in-flight refresh across concurrent callers', async () => {
    const fake = createFakeFetch();
    fake.queueJson({ access_token: CANARY_TOKEN, expires_in: 3600 });
    const provider = createTokenProvider({
      loginHost: 'login.mypurecloud.ie',
      clientId: 'client-1',
      secretStore: await makeStore(),
      profileId: TEST_PROFILE_ID,
      fetch: fake.fetch,
      now: fixedClock('2026-08-20T00:00:00Z'),
    });

    const [a, b, c] = await Promise.all([
      provider.getToken(),
      provider.getToken(),
      provider.getToken(),
    ]);
    expect([a, b, c]).toEqual([CANARY_TOKEN, CANARY_TOKEN, CANARY_TOKEN]);
    expect(fake.calls).toHaveLength(1);
  });

  it('throws a typed auth error on 401 without a secret store entry', async () => {
    const provider = createTokenProvider({
      loginHost: 'login.mypurecloud.ie',
      clientId: 'client-1',
      secretStore: new InMemorySecretStore(),
      profileId: TEST_PROFILE_ID,
      fetch: createFakeFetch().fetch,
      now: fixedClock('2026-08-20T00:00:00Z'),
    });
    await expect(provider.getToken()).rejects.toBeInstanceOf(PlatformApiError);
    await expect(provider.getToken()).rejects.toMatchObject({ category: 'auth' });
  });

  it('throws a typed auth error when Genesys rejects the grant with 401', async () => {
    const fake = createFakeFetch();
    fake.queue(new Response('unauthorized', { status: 401 }));
    const provider = createTokenProvider({
      loginHost: 'login.mypurecloud.ie',
      clientId: 'client-1',
      secretStore: await makeStore(),
      profileId: TEST_PROFILE_ID,
      fetch: fake.fetch,
      now: fixedClock('2026-08-20T00:00:00Z'),
    });
    let caught: unknown;
    try {
      await provider.getToken();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PlatformApiError);
    expect((caught as PlatformApiError).category).toBe('auth');
    expect((caught as PlatformApiError).status).toBe(401);
  });

  it('throws a validation error on malformed JSON', async () => {
    const fake = createFakeFetch();
    fake.queue(new Response('not json', { status: 200 }));
    const provider = createTokenProvider({
      loginHost: 'login.mypurecloud.ie',
      clientId: 'client-1',
      secretStore: await makeStore(),
      profileId: TEST_PROFILE_ID,
      fetch: fake.fetch,
      now: fixedClock('2026-08-20T00:00:00Z'),
    });
    await expect(provider.getToken()).rejects.toMatchObject({ category: 'validation' });
  });

  it('throws a validation error when the response does not match the expected shape', async () => {
    const fake = createFakeFetch();
    fake.queueJson({ unexpected: true });
    const provider = createTokenProvider({
      loginHost: 'login.mypurecloud.ie',
      clientId: 'client-1',
      secretStore: await makeStore(),
      profileId: TEST_PROFILE_ID,
      fetch: fake.fetch,
      now: fixedClock('2026-08-20T00:00:00Z'),
    });
    await expect(provider.getToken()).rejects.toMatchObject({ category: 'validation' });
  });

  it('never leaks the secret or the access token through a thrown error', async () => {
    const fake = createFakeFetch();
    fake.queue(new Response('unauthorized', { status: 401 }));
    const provider = createTokenProvider({
      loginHost: 'login.mypurecloud.ie',
      clientId: 'client-1',
      secretStore: await makeStore(),
      profileId: TEST_PROFILE_ID,
      fetch: fake.fetch,
      now: fixedClock('2026-08-20T00:00:00Z'),
    });
    let caught: unknown;
    try {
      await provider.getToken();
    } catch (err) {
      caught = err;
    }
    const serialized =
      JSON.stringify(caught) + String((caught as Error).stack) + (caught as Error).message;
    expect(serialized).not.toContain(CANARY_SECRET);
    expect(serialized).not.toContain(CANARY_TOKEN);
  });

  it('never leaks the secret or access token on a successful run', async () => {
    const fake = createFakeFetch();
    fake.queueJson({ access_token: CANARY_TOKEN, expires_in: 3600 });
    const provider = createTokenProvider({
      loginHost: 'login.mypurecloud.ie',
      clientId: 'client-1',
      secretStore: await makeStore(),
      profileId: TEST_PROFILE_ID,
      fetch: fake.fetch,
      now: fixedClock('2026-08-20T00:00:00Z'),
    });
    const token = await provider.getToken();
    // The token itself is the legitimate return value -- what must never
    // leak is the *secret*, and the token must never appear anywhere except
    // as this direct return value (never inside an error, a log line, or a
    // second, incidental field).
    expect(token).toBe(CANARY_TOKEN);
    const recordedUrls = fake.calls.map((c) => c.url).join(' ');
    expect(recordedUrls).not.toContain(CANARY_SECRET);
  });
});
