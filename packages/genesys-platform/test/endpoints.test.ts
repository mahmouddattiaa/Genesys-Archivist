import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { PlatformApiClient } from '../src/client.js';
import {
  getFlow,
  getFlowVersionConfiguration,
  getFlows,
  getIntegration,
  getOrganizationsMe,
  getRoutingQueue,
} from '../src/endpoints.js';
import type { TokenProvider } from '../src/token.js';
import { createFakeFetch, fixedClock, immediateSleep } from './helpers.js';

function makeClient(fake: ReturnType<typeof createFakeFetch>): PlatformApiClient {
  const tokenProvider: TokenProvider = { getToken: () => Promise.resolve('t') };
  return new PlatformApiClient({
    apiHost: 'api.mypurecloud.ie',
    tokenProvider,
    fetch: fake.fetch,
    sleep: immediateSleep(),
    now: fixedClock('2026-08-20T00:00:00Z'),
  });
}

describe('endpoint path construction', () => {
  it('getOrganizationsMe calls the documented path', async () => {
    const fake = createFakeFetch();
    fake.queueJson({ id: 'org-1', name: 'Acme' });
    await getOrganizationsMe(makeClient(fake));
    expect(new URL(fake.calls[0]!.url).pathname).toBe('/api/v2/organizations/me');
  });

  it('getFlows paginates against the unfiltered endpoint by default', async () => {
    const fake = createFakeFetch();
    fake.queueJson({ entities: [], pageCount: 1 });
    await getFlows(makeClient(fake), { pageNumber: 1, pageSize: 100 });
    const url = new URL(fake.calls[0]!.url);
    expect(url.pathname).toBe('/api/v2/flows');
    expect(url.searchParams.has('type')).toBe(false);
  });

  it('getFlows passes an explicit type filter as repeated query params', async () => {
    const fake = createFakeFetch();
    fake.queueJson({ entities: [] });
    await getFlows(makeClient(fake), { type: ['inboundcall'], pageNumber: 1, pageSize: 100 });
    const url = new URL(fake.calls[0]!.url);
    expect(url.searchParams.getAll('type')).toEqual(['inboundcall']);
  });

  it('getFlow URL-encodes the flow id into the path', async () => {
    const fake = createFakeFetch();
    fake.queueJson({ id: 'a/b', name: 'x', type: 'inboundcall' });
    await getFlow(makeClient(fake), 'a/b');
    expect(new URL(fake.calls[0]!.url).pathname).toBe('/api/v2/flows/a%2Fb');
  });

  it('getRoutingQueue calls /api/v2/routing/queues/{id}', async () => {
    const fake = createFakeFetch();
    fake.queueJson({ id: 'q1', name: 'Sales' });
    await getRoutingQueue(makeClient(fake), 'q1');
    expect(new URL(fake.calls[0]!.url).pathname).toBe('/api/v2/routing/queues/q1');
  });

  it('getIntegration response never round-trips a credentials field even if present', async () => {
    const fake = createFakeFetch();
    fake.queueJson({ id: 'i1', name: 'Web Services', credentials: { secret: 'x' } });
    const result = await getIntegration(makeClient(fake), 'i1');
    // The typed accessor surface (what the rest of this repo actually reads)
    // has no `credentials` field to read -- defence in depth on top of S3's
    // finding that the field is structurally absent from a real response.
    expect((result as { credentials?: unknown }).credentials).toBeUndefined();
  });
});

describe('getFlowVersionConfiguration against the real sanitized fixture', () => {
  it('parses the manifest into every resource type the fixture carries', async () => {
    const raw = await readFile('fixtures/flow-config/inboundcall-47-nodes.json', 'utf8');
    const fixture: unknown = JSON.parse(raw);
    const fake = createFakeFetch();
    fake.queueJson(fixture);
    const config = await getFlowVersionConfiguration(makeClient(fake), 'flow-1', '4.0');
    expect(config.manifest).toBeDefined();
    const manifestKeys = Object.keys(config.manifest ?? {});
    expect(manifestKeys).toEqual(
      expect.arrayContaining([
        'dataAction',
        'queue',
        'ttsEngine',
        'ttsVoice',
        'language',
        'systemPrompt',
      ]),
    );
    expect(config.nextTrackingNumber).toBe(57);
  });
});
