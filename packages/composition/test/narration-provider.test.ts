// packages/composition/test/narration-provider.test.ts
//
// createAnthropicNarrationProvider against an injected fake fetch: every
// case here runs with no real socket. `secretStore` is an in-memory fake so
// the canary test can plant a credential-shaped string and prove it never
// escapes into a thrown error, a log, or a returned value.
import { describe, expect, it, vi } from 'vitest';
import { asProfileId } from '@genesys-archivist/domain';
import type { SecretStore } from '@genesys-archivist/security';
import type { NarrationPrompt } from '@genesys-archivist/narrative';
import { createAnthropicNarrationProvider } from '../src/narration-provider.js';

const PROFILE_ID = asProfileId('narration-test-profile');

function fakeSecretStore(secret: string | null): SecretStore {
  return {
    get: () => Promise.resolve(secret),
    set: () => Promise.resolve(),
    has: () => Promise.resolve(secret !== null),
    remove: () => Promise.resolve(secret !== null),
  };
}

function fakePrompt(): NarrationPrompt {
  return {
    packContentHash: 'sha256:' + 'a'.repeat(64),
    nonce: 'deadbeef',
    instructions: 'You are drafting narrative documentation.',
    delimiterOpen: '<<<OPEN>>>',
    delimiterClose: '<<<CLOSE>>>',
    delimitedData: '<<<OPEN>>>{"packVersion":"1"}<<<CLOSE>>>',
    allowedSectionIds: ['purpose'],
  };
}

function anthropicSuccessBody(draft: unknown): unknown {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: JSON.stringify(draft) }],
    model: 'claude-sonnet-5',
    stop_reason: 'end_turn',
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const VALID_DRAFT = {
  sections: [{ id: 'purpose', markdown: 'x', claims: [] }],
  unknowns: [],
  reviewRequired: true,
};

describe('createAnthropicNarrationProvider', () => {
  it('returns the parsed draft on a 200 response', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(jsonResponse(200, anthropicSuccessBody(VALID_DRAFT))),
    );
    const provider = createAnthropicNarrationProvider({
      profileId: PROFILE_ID,
      secretStore: fakeSecretStore('sk-real-key'),
      fetch: fetchMock,
      sleep: () => Promise.resolve(),
    });

    const draft = await provider.narrate({ prompt: fakePrompt() });
    expect(draft.sections).toHaveLength(1);
    expect(draft.sections[0]?.id).toBe('purpose');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends the API key only in the x-api-key header, never in the body', async () => {
    let capturedInit: RequestInit | undefined;
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      capturedInit = init;
      return Promise.resolve(jsonResponse(200, anthropicSuccessBody(VALID_DRAFT)));
    });
    const provider = createAnthropicNarrationProvider({
      profileId: PROFILE_ID,
      secretStore: fakeSecretStore('sk-real-key'),
      fetch: fetchMock,
      sleep: () => Promise.resolve(),
    });
    await provider.narrate({ prompt: fakePrompt() });

    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-real-key');
    const sentBody = typeof capturedInit?.body === 'string' ? capturedInit.body : '';
    expect(sentBody).not.toContain('sk-real-key');
  });

  it('retries once on 429 and then succeeds', async () => {
    let calls = 0;
    const fetchMock = vi.fn(() => {
      calls += 1;
      if (calls === 1) return Promise.resolve(jsonResponse(429, { error: 'rate limited' }));
      return Promise.resolve(jsonResponse(200, anthropicSuccessBody(VALID_DRAFT)));
    });
    const sleepMock = vi.fn(() => Promise.resolve());
    const provider = createAnthropicNarrationProvider({
      profileId: PROFILE_ID,
      secretStore: fakeSecretStore('sk-real-key'),
      fetch: fetchMock,
      sleep: sleepMock,
    });

    const draft = await provider.narrate({ prompt: fakePrompt() });
    expect(draft.sections).toHaveLength(1);
    expect(calls).toBe(2);
    expect(sleepMock).toHaveBeenCalledTimes(1);
  });

  it('retries on 500 and then succeeds', async () => {
    let calls = 0;
    const fetchMock = vi.fn(() => {
      calls += 1;
      if (calls <= 2) return Promise.resolve(jsonResponse(500, { error: 'internal' }));
      return Promise.resolve(jsonResponse(200, anthropicSuccessBody(VALID_DRAFT)));
    });
    const provider = createAnthropicNarrationProvider({
      profileId: PROFILE_ID,
      secretStore: fakeSecretStore('sk-real-key'),
      fetch: fetchMock,
      sleep: () => Promise.resolve(),
      maxAttempts: 5,
    });

    await provider.narrate({ prompt: fakePrompt() });
    expect(calls).toBe(3);
  });

  it('does not retry on 401 and rejects immediately', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(401, { error: 'unauthorized' })));
    const provider = createAnthropicNarrationProvider({
      profileId: PROFILE_ID,
      secretStore: fakeSecretStore('sk-bad-key'),
      fetch: fetchMock,
      sleep: () => Promise.resolve(),
    });

    await expect(provider.narrate({ prompt: fakePrompt() })).rejects.toThrow(/401/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry on 400 or 403 either', async () => {
    for (const status of [400, 403]) {
      const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(status, { error: 'bad' })));
      const provider = createAnthropicNarrationProvider({
        profileId: PROFILE_ID,
        secretStore: fakeSecretStore('sk-real-key'),
        fetch: fetchMock,
        sleep: () => Promise.resolve(),
      });
      await expect(provider.narrate({ prompt: fakePrompt() })).rejects.toThrow();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it('gives up after maxAttempts on persistent 429s', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(429, { error: 'rate limited' })));
    const provider = createAnthropicNarrationProvider({
      profileId: PROFILE_ID,
      secretStore: fakeSecretStore('sk-real-key'),
      fetch: fetchMock,
      sleep: () => Promise.resolve(),
      maxAttempts: 3,
    });

    await expect(provider.narrate({ prompt: fakePrompt() })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('rejects with a fixed message on a malformed 200 response, and the raw body never appears in the error', async () => {
    const weirdBody = 'CANARY-BODY-SHOULD-NEVER-LEAK-9f21';
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(weirdBody, { status: 200, headers: { 'content-type': 'text/plain' } }),
      ),
    );
    const provider = createAnthropicNarrationProvider({
      profileId: PROFILE_ID,
      secretStore: fakeSecretStore('sk-real-key'),
      fetch: fetchMock,
      sleep: () => Promise.resolve(),
    });

    let caught: unknown;
    try {
      await provider.narrate({ prompt: fakePrompt() });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toContain(weirdBody);
  });

  it('rejects when the model text content is not valid JSON, without echoing it', async () => {
    const modelGarbage = 'CANARY-MODEL-TEXT-SHOULD-NEVER-LEAK-a12c';
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        jsonResponse(200, {
          content: [{ type: 'text', text: modelGarbage }],
        }),
      ),
    );
    const provider = createAnthropicNarrationProvider({
      profileId: PROFILE_ID,
      secretStore: fakeSecretStore('sk-real-key'),
      fetch: fetchMock,
      sleep: () => Promise.resolve(),
    });

    let caught: unknown;
    try {
      await provider.narrate({ prompt: fakePrompt() });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toContain(modelGarbage);
  });

  it('canary: a planted API key never appears in a thrown error or the returned draft', async () => {
    const canary = 'CANARY-SECRET-2e91fa';
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(401, { error: 'unauthorized' })));
    const provider = createAnthropicNarrationProvider({
      profileId: PROFILE_ID,
      secretStore: fakeSecretStore(canary),
      fetch: fetchMock,
      sleep: () => Promise.resolve(),
    });

    let caught: unknown;
    try {
      await provider.narrate({ prompt: fakePrompt() });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(JSON.stringify(caught instanceof Error ? caught.message : caught)).not.toContain(canary);
  });

  it('canary: a planted API key never appears in a successful draft round-trip either', async () => {
    const canary = 'CANARY-SECRET-2e91fa';
    const fetchMock = vi.fn(() =>
      Promise.resolve(jsonResponse(200, anthropicSuccessBody(VALID_DRAFT))),
    );
    const provider = createAnthropicNarrationProvider({
      profileId: PROFILE_ID,
      secretStore: fakeSecretStore(canary),
      fetch: fetchMock,
      sleep: () => Promise.resolve(),
    });

    const draft = await provider.narrate({ prompt: fakePrompt() });
    expect(JSON.stringify(draft)).not.toContain(canary);
  });

  it('rejects with a clear message when no key is stored, never calling fetch', async () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error('must not be called')));
    const provider = createAnthropicNarrationProvider({
      profileId: PROFILE_ID,
      secretStore: fakeSecretStore(null),
      fetch: fetchMock,
      sleep: () => Promise.resolve(),
    });

    await expect(provider.narrate({ prompt: fakePrompt() })).rejects.toThrow(/narration api key/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('defaults to the claude-sonnet-5 model when none is given', async () => {
    let capturedBody: string | undefined;
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      capturedBody = typeof init?.body === 'string' ? init.body : '';
      return Promise.resolve(jsonResponse(200, anthropicSuccessBody(VALID_DRAFT)));
    });
    const provider = createAnthropicNarrationProvider({
      profileId: PROFILE_ID,
      secretStore: fakeSecretStore('sk-real-key'),
      fetch: fetchMock,
      sleep: () => Promise.resolve(),
    });
    await provider.narrate({ prompt: fakePrompt() });
    const parsed: unknown = JSON.parse(capturedBody ?? '{}');
    expect((parsed as { model?: string }).model).toBe('claude-sonnet-5');
  });
});
