import { readFile } from 'node:fs/promises';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { asFlowId } from '@genesys-archivist/domain';
import { PlatformApiClient } from '@genesys-archivist/genesys-platform';
import {
  PlatformSourceProvider,
  createPlatformSourceProvider,
} from '../src/platform-source-provider.js';
import {
  InMemorySecretStore,
  TEST_PROFILE_ID,
  apiRoute,
  createRoutedFetch,
  fixedClock,
  immediateSleep,
  jsonResponse,
  tokenRoute,
} from './helpers.js';

const API_HOST = 'api.mypurecloud.ie';
const LOGIN_HOST = 'login.mypurecloud.ie';

function makeProvider(routed: ReturnType<typeof createRoutedFetch>): PlatformSourceProvider {
  const client = new PlatformApiClient({
    apiHost: API_HOST,
    tokenProvider: { getToken: () => Promise.resolve('t') },
    fetch: routed.fetch,
    sleep: immediateSleep(),
    now: fixedClock('2026-08-20T00:00:00Z'),
  });
  return new PlatformSourceProvider(client, 'eu_west_1');
}

async function makeStoreWithSecret(): Promise<InMemorySecretStore> {
  const store = new InMemorySecretStore();
  await store.set(TEST_PROFILE_ID, 'test-secret');
  return store;
}

describe('validateConnection', () => {
  it('returns organization identity', async () => {
    const routed = createRoutedFetch([
      apiRoute(API_HOST, '/api/v2/organizations/me', () =>
        jsonResponse({ id: 'org-1', name: 'Acme' }),
      ),
    ]);
    const identity = await makeProvider(routed).validateConnection();
    expect(identity).toEqual({
      organizationId: 'org-1',
      organizationName: 'Acme',
      region: 'eu_west_1',
    });
  });
});

describe('createPlatformSourceProvider: full factory wiring', () => {
  it('authenticates and validates the connection end to end', async () => {
    const routed = createRoutedFetch([
      tokenRoute(LOGIN_HOST),
      apiRoute(API_HOST, '/api/v2/organizations/me', () =>
        jsonResponse({ id: 'org-1', name: 'Acme' }),
      ),
    ]);
    const provider = createPlatformSourceProvider({
      region: 'eu_west_1',
      clientId: 'client-1',
      secretStore: await makeStoreWithSecret(),
      profileId: TEST_PROFILE_ID,
      fetch: routed.fetch,
      now: fixedClock('2026-08-20T00:00:00Z'),
      sleep: immediateSleep(),
    });
    const identity = await provider.validateConnection();
    expect(identity.organizationId).toBe('org-1');
    expect(routed.calls.some((c) => c.url === `https://${LOGIN_HOST}/oauth/token`)).toBe(true);
  });
});

describe('listFlows', () => {
  it('pages through to completion, trusting pageCount', async () => {
    const routed = createRoutedFetch([
      apiRoute(API_HOST, '/api/v2/flows', (url) => {
        const pageNumber = Number(url.searchParams.get('pageNumber'));
        if (pageNumber === 1) {
          return jsonResponse({
            entities: [{ id: 'f1', name: 'One', type: 'INBOUNDCALL' }],
            pageCount: 2,
          });
        }
        return jsonResponse({
          entities: [{ id: 'f2', name: 'Two', type: 'WORKFLOW' }],
          pageCount: 2,
        });
      }),
    ]);
    const flows = [];
    for await (const flow of makeProvider(routed).listFlows({})) flows.push(flow);
    expect(flows).toEqual([
      { flowId: 'f1', name: 'One', type: 'inboundcall', divisionId: null, publishedVersion: null },
      { flowId: 'f2', name: 'Two', type: 'workflow', divisionId: null, publishedVersion: null },
    ]);
  });

  it('does not filter by type when the caller supplies no flowTypes (S2: unfiltered walk is authoritative)', async () => {
    const routed = createRoutedFetch([
      apiRoute(API_HOST, '/api/v2/flows', () => jsonResponse({ entities: [], pageCount: 1 })),
    ]);
    const flows = [];
    for await (const flow of makeProvider(routed).listFlows({})) flows.push(flow);
    const url = new URL(routed.calls[0]!.url);
    expect(url.searchParams.has('type')).toBe(false);
  });

  it('passes an explicit flowTypes filter through, and terminates cleanly on a legitimate empty result (S6: speech/survey returned zero)', async () => {
    const routed = createRoutedFetch([
      apiRoute(API_HOST, '/api/v2/flows', () => jsonResponse({ entities: [], pageCount: 0 })),
    ]);
    const flows = [];
    for await (const flow of makeProvider(routed).listFlows({ flowTypes: ['speech'] }))
      flows.push(flow);
    expect(flows).toEqual([]);
    const url = new URL(routed.calls[0]!.url);
    expect(url.searchParams.getAll('type')).toEqual(['speech']);
  });

  it('terminates on an empty page when pageCount is absent', async () => {
    const routed = createRoutedFetch([
      apiRoute(API_HOST, '/api/v2/flows', (url) => {
        const pageNumber = Number(url.searchParams.get('pageNumber'));
        return jsonResponse({
          entities: pageNumber === 1 ? [{ id: 'f1', name: 'One', type: 'inboundcall' }] : [],
        });
      }),
    ]);
    const flows = [];
    for await (const flow of makeProvider(routed).listFlows({})) flows.push(flow);
    expect(flows).toHaveLength(1);
  });

  it('terminates a pagination response that never advances, rather than spinning forever', async () => {
    const routed = createRoutedFetch([
      apiRoute(API_HOST, '/api/v2/flows', () =>
        // Ignores pageNumber entirely and always returns the same page,
        // with no pageCount to signal completion either.
        jsonResponse({ entities: [{ id: 'stuck', name: 'Stuck', type: 'inboundcall' }] }),
      ),
    ]);
    const flows = [];
    for await (const flow of makeProvider(routed).listFlows({})) flows.push(flow);
    // Exactly one copy: the stall detector fires on the second, identical page.
    expect(flows).toEqual([
      {
        flowId: 'stuck',
        name: 'Stuck',
        type: 'inboundcall',
        divisionId: null,
        publishedVersion: null,
      },
    ]);
  });

  it('terminates within a bounded number of pages even if pageCount claims far more than actually exist', async () => {
    let calls = 0;
    const routed = createRoutedFetch([
      apiRoute(API_HOST, '/api/v2/flows', (url) => {
        calls += 1;
        const pageNumber = Number(url.searchParams.get('pageNumber'));
        // pageCount lies (claims 1,000,000 pages), but content changes each
        // time (so the stall detector does not fire) until it goes empty.
        if (pageNumber <= 3) {
          return jsonResponse({
            entities: [
              { id: `f${String(pageNumber)}`, name: `F${String(pageNumber)}`, type: 'inboundcall' },
            ],
            pageCount: 1_000_000,
          });
        }
        return jsonResponse({ entities: [], pageCount: 1_000_000 });
      }),
    ]);
    const flows = [];
    for await (const flow of makeProvider(routed).listFlows({})) flows.push(flow);
    expect(flows).toHaveLength(3);
    expect(calls).toBe(4); // three real pages, one empty terminator
  });
});

describe('listFlows: pagination termination property test', () => {
  it('always terminates for an arbitrary sequence of page sizes and an optionally-wrong pageCount', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: 3 }), { minLength: 0, maxLength: 12 }),
        fc.boolean(),
        async (pageSizes, reportWrongPageCount) => {
          let flowCounter = 0;
          const routed = createRoutedFetch([
            apiRoute(API_HOST, '/api/v2/flows', (url) => {
              const pageNumber = Number(url.searchParams.get('pageNumber'));
              const index = pageNumber - 1;
              const size = index < pageSizes.length ? pageSizes[index]! : 0;
              const entities = Array.from({ length: size }, () => {
                flowCounter += 1;
                return {
                  id: `f${String(flowCounter)}`,
                  name: `F${String(flowCounter)}`,
                  type: 'inboundcall',
                };
              });
              const pageCount = reportWrongPageCount ? pageSizes.length + 50 : undefined;
              return jsonResponse({ entities, ...(pageCount !== undefined ? { pageCount } : {}) });
            }),
          ]);
          const flows = [];
          for await (const flow of makeProvider(routed).listFlows({})) flows.push(flow);
          // The only property that matters here is termination: the loop
          // above completing at all is the assertion. A bounded number of
          // underlying requests confirms it did not degrade into the
          // MAX_PAGES safety valve for a small, well-formed sequence.
          expect(routed.calls.length).toBeLessThan(20);
        },
      ),
      { numRuns: 30 },
    );
  });
});

describe('loadFlowSource', () => {
  it('resolves the published version when versionId is null', async () => {
    const routed = createRoutedFetch([
      apiRoute(API_HOST, '/api/v2/flows/:id', () =>
        jsonResponse({
          id: 'f1',
          name: 'One',
          type: 'inboundcall',
          publishedVersion: { id: '4.0' },
        }),
      ),
      apiRoute(API_HOST, '/api/v2/flows/:id/versions/:versionId/configuration', () =>
        jsonResponse({ name: 'One', manifest: {} }),
      ),
    ]);
    const source = await makeProvider(routed).loadFlowSource({
      flowId: asFlowId('f1'),
      versionId: null,
    });
    expect(source.versionId).toBe('4.0');
    expect(source.format).toBe('json');
    expect(JSON.parse(source.body)).toMatchObject({ name: 'One' });
  });

  it('requests a specific version directly when versionId is given', async () => {
    const routed = createRoutedFetch([
      apiRoute(API_HOST, '/api/v2/flows/:id/versions/:versionId/configuration', () =>
        jsonResponse({ name: 'One', manifest: {} }),
      ),
    ]);
    const source = await makeProvider(routed).loadFlowSource({
      flowId: asFlowId('f1'),
      versionId: '2.0' as never,
    });
    expect(source.versionId).toBe('2.0');
    // getFlow is never called when a version was already given.
    expect(routed.calls.some((c) => /\/api\/v2\/flows\/f1$/.exec(new URL(c.url).pathname))).toBe(
      false,
    );
  });

  it('falls back to a best-effort version id via getFlowVersions when the flow has no published version', async () => {
    const routed = createRoutedFetch([
      apiRoute(API_HOST, '/api/v2/flows/:id', () =>
        jsonResponse({ id: 'f1', name: 'Draft', type: 'inboundcall' }),
      ),
      apiRoute(API_HOST, '/api/v2/flows/:id/latestconfiguration', () =>
        jsonResponse({ name: 'Draft', manifest: {} }),
      ),
      apiRoute(API_HOST, '/api/v2/flows/:id/versions', () =>
        jsonResponse({ entities: [{ id: '1' }, { id: '3' }, { id: '2' }] }),
      ),
    ]);
    const source = await makeProvider(routed).loadFlowSource({
      flowId: asFlowId('f1'),
      versionId: null,
    });
    expect(source.versionId).toBe('3');
  });
});

describe('resolveDependencies: flow self-ref', () => {
  it('turns a manifest into safeMetadata.references', async () => {
    const routed = createRoutedFetch([
      apiRoute(API_HOST, '/api/v2/flows/:id/versions/:versionId/configuration', () =>
        jsonResponse({
          name: 'One',
          manifest: { queue: [{ id: 'q1', name: 'Sales', context: [] }] },
        }),
      ),
    ]);
    const provider = makeProvider(routed);
    await provider.loadFlowSource({ flowId: asFlowId('f1'), versionId: '4.0' as never });
    const requestsBefore = routed.calls.length;
    const [resolution] = await provider.resolveDependencies([{ type: 'flow', id: 'f1' as never }]);
    expect(resolution?.status).toBe('resolved');
    expect(resolution?.safeMetadata['references']).toEqual([{ type: 'queue', id: 'q1' }]);
    // Zero extra requests: the configuration was already cached by loadFlowSource.
    expect(routed.calls.length).toBe(requestsBefore);
  });

  it('fetches and caches a flow ref not previously loaded (e.g. an IVR-discovered or flow-to-flow reference)', async () => {
    const routed = createRoutedFetch([
      apiRoute(API_HOST, '/api/v2/flows/:id', () =>
        jsonResponse({
          id: 'f2',
          name: 'Two',
          type: 'inboundcall',
          publishedVersion: { id: '1.0' },
        }),
      ),
      apiRoute(API_HOST, '/api/v2/flows/:id/versions/:versionId/configuration', () =>
        jsonResponse({ name: 'Two', manifest: {} }),
      ),
    ]);
    const provider = makeProvider(routed);
    const [resolution] = await provider.resolveDependencies([{ type: 'flow', id: 'f2' as never }]);
    expect(resolution?.status).toBe('resolved');
    expect(resolution?.displayName).toBe('Two');
  });

  it("handles the real sanitized fixture end to end, matching S3's observed reference count", async () => {
    const raw = await readFile('fixtures/flow-config/inboundcall-47-nodes.json', 'utf8');
    const fixture: unknown = JSON.parse(raw);
    const routed = createRoutedFetch([
      apiRoute(API_HOST, '/api/v2/flows/:id/versions/:versionId/configuration', () =>
        jsonResponse(fixture),
      ),
    ]);
    const provider = makeProvider(routed);
    await provider.loadFlowSource({ flowId: asFlowId('f1'), versionId: '4.0' as never });
    const [resolution] = await provider.resolveDependencies([{ type: 'flow', id: 'f1' as never }]);
    const references = resolution?.safeMetadata['references'] as { type: string; id: string }[];
    expect(references.length).toBe(6); // S3: "6 referenced resources"
  });
});

describe('resolveDependencies: unsupported types', () => {
  it('reports a type with no reader as unsupported, never silently dropping it', async () => {
    const provider = makeProvider(createRoutedFetch([]));
    const [resolution] = await provider.resolveDependencies([
      { type: 'someNeverBeforeSeenType', id: 'x1' as never },
    ]);
    expect(resolution).toEqual({
      ref: { type: 'someNeverBeforeSeenType', id: 'x1' },
      status: 'unsupported',
      displayName: null,
      safeMetadata: {},
    });
  });

  it('reports ttsEngine and ttsVoice as unsupported (no read endpoint exists in the pinned SDK)', async () => {
    const provider = makeProvider(createRoutedFetch([]));
    const resolutions = await provider.resolveDependencies([
      { type: 'ttsEngine', id: 'Charlie' as never },
      { type: 'ttsVoice', id: 'Lima' as never },
    ]);
    expect(resolutions.every((r) => r.status === 'unsupported')).toBe(true);
  });

  it('reports a user manifest reference as unsupported, never exposing personal data', async () => {
    const provider = makeProvider(createRoutedFetch([]));
    const [resolution] = await provider.resolveDependencies([{ type: 'user', id: 'u1' as never }]);
    expect(resolution?.status).toBe('unsupported');
    expect(resolution?.safeMetadata).toEqual({});
  });
});

describe('checkPermissions', () => {
  it('reports no gaps when every probe succeeds', async () => {
    const routed = createRoutedFetch([
      apiRoute(API_HOST, '/api/v2/flows', () => jsonResponse({ entities: [] })),
      apiRoute(API_HOST, '/api/v2/architect/ivrs', () => jsonResponse({ entities: [] })),
    ]);
    expect(await makeProvider(routed).checkPermissions()).toEqual([]);
  });

  it('reports a named missing permission on a 403, not a raw authorization response', async () => {
    const routed = createRoutedFetch([
      apiRoute(API_HOST, '/api/v2/flows', () => new Response('', { status: 403 })),
      apiRoute(API_HOST, '/api/v2/architect/ivrs', () => jsonResponse({ entities: [] })),
    ]);
    const missing = await makeProvider(routed).checkPermissions();
    expect(missing).toEqual([
      { operation: 'flows.list', permission: 'architect:flow:view', status: 403 },
    ]);
  });

  it('does not report a gap for a non-permission failure such as a transient 500', async () => {
    const routed = createRoutedFetch([
      apiRoute(API_HOST, '/api/v2/flows', () => new Response('', { status: 500 })),
      apiRoute(API_HOST, '/api/v2/architect/ivrs', () => jsonResponse({ entities: [] })),
    ]);
    const client = new PlatformApiClient({
      apiHost: API_HOST,
      tokenProvider: { getToken: () => Promise.resolve('t') },
      fetch: routed.fetch,
      sleep: immediateSleep(),
      now: fixedClock('2026-08-20T00:00:00Z'),
      maxRetries: 0,
    });
    const provider = new PlatformSourceProvider(client, 'eu_west_1');
    expect(await provider.checkPermissions()).toEqual([]);
  });
});
