import { describe, expect, it } from 'vitest';
import { PlatformApiClient } from '@genesys-archivist/genesys-platform';
import { createResourceReaders } from '../src/resource-readers.js';
import {
  apiRoute,
  createRoutedFetch,
  fixedClock,
  immediateSleep,
  jsonResponse,
} from './helpers.js';

const API_HOST = 'api.mypurecloud.ie';

function makeClient(fetch: ReturnType<typeof createRoutedFetch>['fetch']): PlatformApiClient {
  return new PlatformApiClient({
    apiHost: API_HOST,
    tokenProvider: { getToken: () => Promise.resolve('t') },
    fetch,
    sleep: immediateSleep(),
    now: fixedClock('2026-08-20T00:00:00Z'),
  });
}

describe('createResourceReaders: queue', () => {
  it('resolves a queue', async () => {
    const routed = createRoutedFetch([
      apiRoute(API_HOST, '/api/v2/routing/queues/:id', () =>
        jsonResponse({ id: 'q1', name: 'Sales' }),
      ),
    ]);
    const readers = createResourceReaders(makeClient(routed.fetch));
    const result = await readers.get('queue')!('q1');
    expect(result).toMatchObject({ status: 'resolved', displayName: 'Sales' });
    expect(result.safeMetadata['name']).toBe('Sales');
  });

  it('maps 403 to forbidden and 404 to not_found', async () => {
    const routed = createRoutedFetch([
      apiRoute(API_HOST, '/api/v2/routing/queues/:id', (url) =>
        url.pathname.endsWith('forbidden')
          ? new Response('', { status: 403 })
          : new Response('', { status: 404 }),
      ),
    ]);
    const readers = createResourceReaders(makeClient(routed.fetch));
    expect((await readers.get('queue')!('forbidden')).status).toBe('forbidden');
    expect((await readers.get('queue')!('missing')).status).toBe('not_found');
  });

  it('maps a persistent server error to partially_resolved, not a false not_found or forbidden', async () => {
    const routed = createRoutedFetch([
      apiRoute(API_HOST, '/api/v2/routing/queues/:id', () => new Response('', { status: 503 })),
    ]);
    const client = new PlatformApiClient({
      apiHost: API_HOST,
      tokenProvider: { getToken: () => Promise.resolve('t') },
      fetch: routed.fetch,
      sleep: immediateSleep(),
      now: fixedClock('2026-08-20T00:00:00Z'),
      maxRetries: 1,
    });
    const readers = createResourceReaders(client);
    const result = await readers.get('queue')!('flaky');
    expect(result.status).toBe('partially_resolved');
    expect(result.safeMetadata['resolutionIssue']).toBe('server');
  });
});

describe('createResourceReaders: dataAction -> integration', () => {
  it('resolves a data action and surfaces its integration as an outward reference', async () => {
    const routed = createRoutedFetch([
      apiRoute(API_HOST, '/api/v2/integrations/actions/:id', () =>
        jsonResponse({
          id: 'a1',
          name: 'Lookup',
          integrationId: 'i1',
          category: 'custom',
          secure: false,
        }),
      ),
    ]);
    const readers = createResourceReaders(makeClient(routed.fetch));
    const result = await readers.get('dataAction')!('a1');
    expect(result.status).toBe('resolved');
    expect(result.safeMetadata['references']).toEqual([{ type: 'integration', id: 'i1' }]);
  });

  it('resolves an integration with no outward integration reference when absent', async () => {
    const routed = createRoutedFetch([
      apiRoute(API_HOST, '/api/v2/integrations/actions/:id', () =>
        jsonResponse({ id: 'a1', name: 'Lookup' }),
      ),
    ]);
    const readers = createResourceReaders(makeClient(routed.fetch));
    const result = await readers.get('dataAction')!('a1');
    expect(result.safeMetadata['references']).toEqual([]);
  });
});

describe('createResourceReaders: integration credential stripping', () => {
  it('never surfaces a credentials field even if a future response carried one', async () => {
    const routed = createRoutedFetch([
      apiRoute(API_HOST, '/api/v2/integrations/:id', () =>
        jsonResponse({
          id: 'i1',
          name: 'Web Services',
          credentials: { apiKey: 'CANARY-INTEGRATION-SECRET' },
        }),
      ),
    ]);
    const readers = createResourceReaders(makeClient(routed.fetch));
    const result = await readers.get('integration')!('i1');
    expect(JSON.stringify(result.safeMetadata)).not.toContain('CANARY-INTEGRATION-SECRET');
  });
});

describe('createResourceReaders: dataTable', () => {
  it('resolves a data table and fetches its rows', async () => {
    const routed = createRoutedFetch([
      apiRoute(API_HOST, '/api/v2/flows/datatables/:id', () =>
        jsonResponse({ id: 't1', name: 'Overrides' }),
      ),
      apiRoute(API_HOST, '/api/v2/flows/datatables/:id/rows', () =>
        jsonResponse({ entities: [{ key: 'a', value: '1' }], pageCount: 1 }),
      ),
    ]);
    const readers = createResourceReaders(makeClient(routed.fetch));
    const result = await readers.get('dataTable')!('t1');
    expect(result.status).toBe('resolved');
    expect(result.safeMetadata['dataTableRows']).toEqual([{ key: 'a', value: '1' }]);
  });

  it('reports a table with no rows without a dataTableRows key', async () => {
    const routed = createRoutedFetch([
      apiRoute(API_HOST, '/api/v2/flows/datatables/:id', () =>
        jsonResponse({ id: 't1', name: 'Empty' }),
      ),
      apiRoute(API_HOST, '/api/v2/flows/datatables/:id/rows', () =>
        jsonResponse({ entities: [], pageCount: 1 }),
      ),
    ]);
    const readers = createResourceReaders(makeClient(routed.fetch));
    const result = await readers.get('dataTable')!('t1');
    expect('dataTableRows' in result.safeMetadata).toBe(false);
  });
});

describe('createResourceReaders: userPrompt audio', () => {
  it('downloads audio and reports it as a single asset plus every available language', async () => {
    const routed = createRoutedFetch([
      apiRoute(API_HOST, '/api/v2/architect/prompts/:id', () =>
        jsonResponse({
          id: 'p1',
          name: 'Welcome',
          resources: [
            {
              language: 'en-us',
              mediaUri: 'https://media.example.mypurecloud.ie/p1/en-us.wav',
              fileName: 'en-us.wav',
            },
            {
              language: 'fr-fr',
              mediaUri: 'https://media.example.mypurecloud.ie/p1/fr-fr.wav',
              fileName: 'fr-fr.wav',
            },
          ],
        }),
      ),
      {
        match: (url, method) => url.host === 'media.example.mypurecloud.ie' && method === 'GET',
        respond: () =>
          new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
            headers: { 'content-type': 'audio/x-wav' },
          }),
      },
    ]);
    const readers = createResourceReaders(makeClient(routed.fetch));
    const result = await readers.get('userPrompt')!('p1');
    expect(result.status).toBe('resolved');
    const asset = result.safeMetadata['asset'] as {
      bytes: Uint8Array;
      originalName: string;
      mimeType: string;
    };
    expect(asset.bytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(asset.bytes)).toEqual([1, 2, 3]);
    expect(asset.mimeType).toBe('audio/x-wav');
    expect(result.safeMetadata['availableLanguages']).toEqual(['en-us', 'fr-fr']);
    // The media host never receives this client's own bearer token.
    const mediaCall = routed.calls.find((c) => c.url.includes('media.example.mypurecloud.ie'));
    expect(mediaCall?.headers['authorization']).toBeUndefined();
  });

  it('retries exactly once, by re-resolving the prompt, when the media URL has expired', async () => {
    let mediaAttempts = 0;
    const routed = createRoutedFetch([
      apiRoute(API_HOST, '/api/v2/architect/prompts/:id', () =>
        jsonResponse({
          id: 'p1',
          name: 'Welcome',
          resources: [
            {
              language: 'en-us',
              mediaUri: `https://media.example.mypurecloud.ie/p1/en-us.wav?attempt=${String(mediaAttempts)}`,
              fileName: 'en-us.wav',
            },
          ],
        }),
      ),
      {
        match: (url, method) => url.host === 'media.example.mypurecloud.ie' && method === 'GET',
        respond: () => {
          mediaAttempts += 1;
          if (mediaAttempts === 1) return new Response('', { status: 403 });
          return new Response(new Uint8Array([9]), {
            status: 200,
            headers: { 'content-type': 'audio/x-wav' },
          });
        },
      },
    ]);
    const readers = createResourceReaders(makeClient(routed.fetch));
    const result = await readers.get('userPrompt')!('p1');
    expect(result.status).toBe('resolved');
    const asset = result.safeMetadata['asset'] as { bytes: Uint8Array };
    expect(Array.from(asset.bytes)).toEqual([9]);
    expect(mediaAttempts).toBe(2);
  });

  it('reports availableLanguages with no asset when no resource carries a media URI', async () => {
    const routed = createRoutedFetch([
      apiRoute(API_HOST, '/api/v2/architect/prompts/:id', () =>
        jsonResponse({ id: 'p1', name: 'Silent', resources: [{ language: 'en-us' }] }),
      ),
    ]);
    const readers = createResourceReaders(makeClient(routed.fetch));
    const result = await readers.get('userPrompt')!('p1');
    expect(result.status).toBe('resolved');
    expect('asset' in result.safeMetadata).toBe(false);
    expect(result.safeMetadata['availableLanguages']).toEqual(['en-us']);
  });
});
