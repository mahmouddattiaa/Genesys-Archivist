// packages/composition/test/platform-provider-seam.test.ts
//
// The seam this task's brief calls out by name: three prior tasks each
// passed their own package's tests while the seam between two parts was
// broken. This file wires a fake fetch, serving real sanitized fixture
// response bodies, all the way through the production adapter
// (`createPlatformSourceProvider`), into `runCapture`, through
// `verifyBundle`, and into `documentBundle` -- for real, in both of
// ADR-018's capture modes -- and asserts the documents describe the real
// flows the fixtures encode, with no canary anywhere in the bundle or the
// generated documents.
//
// Two fixtures are exercised, per this task's brief: the 47-node inbound
// call flow this repository already had, and the 187-node bot flow -- the
// structurally least IVR-like flow in the corpus, and therefore the one
// most likely to expose an assumption this seam quietly baked in about what
// a "flow" looks like.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asOrganizationId, asProfileId, type ProfileId } from '@genesys-archivist/domain';
import type { FetchLike } from '@genesys-archivist/genesys-platform';
import { createPlatformSourceProvider } from '@genesys-archivist/genesys-source';
import { runCapture, verifyBundle, type CaptureMode } from '@genesys-archivist/capture';
import type { SecretStore } from '@genesys-archivist/security';
import { documentBundle } from '../src/document-bundle.js';

/** In-memory `SecretStore`, local to this one file this task is allowed to
 * touch: `@genesys-archivist/testing` has no such fake, and adding one
 * there would be an edit outside this task's file ownership. */
class InMemorySecretStore implements SecretStore {
  readonly #secrets = new Map<string, string>();
  set(profileId: ProfileId, secret: string): Promise<void> {
    this.#secrets.set(profileId, secret);
    return Promise.resolve();
  }
  get(profileId: ProfileId): Promise<string | null> {
    return Promise.resolve(this.#secrets.get(profileId) ?? null);
  }
  has(profileId: ProfileId): Promise<boolean> {
    return Promise.resolve(this.#secrets.has(profileId));
  }
  remove(profileId: ProfileId): Promise<boolean> {
    return Promise.resolve(this.#secrets.delete(profileId));
  }
}

const CANARY = 'CANARY-SEAM-TEST-4f9c2e';
const API_HOST = 'api.mypurecloud.ie';
const LOGIN_HOST = 'login.mypurecloud.ie';
const ORG_ID = asOrganizationId('org-seam-1');
const PROFILE_ID = asProfileId('seam-profile');

interface RouteRule {
  readonly match: (url: URL, method: string) => boolean;
  readonly respond: (url: URL) => Response | Promise<Response>;
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** Matches `GET <apiHost><pathPattern>`, where `:seg` in the pattern
 * matches (but does not capture) exactly one path segment. */
function route(
  host: string,
  method: string,
  pathPattern: string,
  respond: (url: URL) => Response,
): RouteRule {
  const segments = pathPattern.split('/');
  return {
    match: (url, m) => {
      if (m !== method || url.host !== host) return false;
      const urlSegments = url.pathname.split('/');
      if (urlSegments.length !== segments.length) return false;
      return segments.every((seg, i) => seg.startsWith(':') || seg === urlSegments[i]);
    },
    respond,
  };
}

function buildFakeFetch(rules: readonly RouteRule[]): FetchLike {
  return async (input, init) => {
    const method = init?.method ?? 'GET';
    const url = new URL(input);
    for (const rule of rules) {
      if (rule.match(url, method)) return rule.respond(url);
    }
    throw new Error(`seam test: no route for ${method} ${input}`);
  };
}

/**
 * Every route this seam needs to complete a capture of two flows in either
 * mode: identity, discovery, both flows' definitions, and generic
 * catch-alls for the manifest resource types those two fixtures reference
 * that this adapter has a reader for (queue, dataAction, language,
 * userPrompt, systemPrompt, dataTable, integration). Every other manifest
 * type present in the fixtures (ttsEngine, ttsVoice, grammar, nluDomain,
 * sttEngine, flowOutcome, flowMilestone) has no reader at all, so it never
 * issues a request and needs no route here -- it resolves `unsupported`
 * directly.
 */
function buildRules(inboundcallFixture: unknown, botFixture: unknown): RouteRule[] {
  return [
    route(LOGIN_HOST, 'POST', '/oauth/token', () =>
      json({ access_token: 'seam-token', expires_in: 3600 }),
    ),
    route(API_HOST, 'GET', '/api/v2/organizations/me', () =>
      json({ id: ORG_ID, name: 'Seam Test Org' }),
    ),
    route(API_HOST, 'GET', '/api/v2/flows', () =>
      json({
        entities: [
          {
            id: 'flow-inboundcall',
            name: 'Customer Care IVR',
            type: 'inboundcall',
            publishedVersion: { id: '4.0' },
          },
          { id: 'flow-bot', name: 'Support Bot', type: 'bot', publishedVersion: { id: '1.0' } },
        ],
        pageCount: 1,
      }),
    ),
    route(API_HOST, 'GET', '/api/v2/flows/:id', (url) => {
      const id = url.pathname.split('/').pop();
      return id === 'flow-inboundcall'
        ? json({
            id,
            name: 'Customer Care IVR',
            type: 'inboundcall',
            publishedVersion: { id: '4.0' },
          })
        : json({ id, name: 'Support Bot', type: 'bot', publishedVersion: { id: '1.0' } });
    }),
    route(API_HOST, 'GET', '/api/v2/flows/:id/versions/:versionId/configuration', (url) => {
      const segments = url.pathname.split('/');
      const flowId = segments[4];
      return json(flowId === 'flow-inboundcall' ? inboundcallFixture : botFixture);
    }),
    route(API_HOST, 'GET', '/api/v2/routing/queues/:id', (url) =>
      json({ id: url.pathname.split('/').pop(), name: 'Sales Queue' }),
    ),
    route(API_HOST, 'GET', '/api/v2/integrations/actions/:id', (url) =>
      json({ id: url.pathname.split('/').pop(), name: 'Lookup Caller' }),
    ),
    route(API_HOST, 'GET', '/api/v2/integrations/:id', (url) =>
      json({ id: url.pathname.split('/').pop(), name: 'Web Services' }),
    ),
    route(API_HOST, 'GET', '/api/v2/languages/:id', (url) =>
      json({ id: url.pathname.split('/').pop(), name: 'English (US)' }),
    ),
    route(API_HOST, 'GET', '/api/v2/architect/prompts/:id', (url) =>
      json({ id: url.pathname.split('/').pop(), name: 'Welcome', resources: [] }),
    ),
    route(API_HOST, 'GET', '/api/v2/architect/systemprompts/:id', (url) =>
      json({ id: url.pathname.split('/').pop(), name: 'System Prompt', resources: [] }),
    ),
    route(API_HOST, 'GET', '/api/v2/flows/datatables/:id', (url) =>
      json({ id: url.pathname.split('/').pop(), name: 'Overrides' }),
    ),
    route(API_HOST, 'GET', '/api/v2/flows/datatables/:id/rows', () =>
      json({ entities: [], pageCount: 1 }),
    ),
  ];
}

const created: string[] = [];

async function freshRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'archivist-platform-seam-'));
  created.push(dir);
  return dir;
}

beforeEach(() => {
  created.length = 0;
});

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function runSeam(mode: CaptureMode): Promise<{
  bundleDir: string;
  documents: Awaited<ReturnType<typeof documentBundle>>;
}> {
  const inboundcallFixture: unknown = JSON.parse(
    await readFile('fixtures/flow-config/inboundcall-47-nodes.json', 'utf8'),
  );
  const botFixture: unknown = JSON.parse(
    await readFile('fixtures/flow-config/bot-187-nodes.json', 'utf8'),
  );

  const secretStore = new InMemorySecretStore();
  await secretStore.set(PROFILE_ID, CANARY);

  const provider = createPlatformSourceProvider({
    region: 'eu_west_1',
    clientId: 'seam-client',
    secretStore,
    profileId: PROFILE_ID,
    fetch: buildFakeFetch(buildRules(inboundcallFixture, botFixture)),
    now: () => new Date('2026-08-20T12:00:00Z'),
    sleep: () => Promise.resolve(),
  });

  const root = await freshRoot();
  const result = await runCapture({
    root,
    runId: `seam-${mode}`,
    planHash: 'seam-plan-hash',
    organizationId: ORG_ID,
    expectedOrganizationId: ORG_ID,
    provider,
    mode,
    now: () => new Date('2026-08-20T12:00:00Z'),
  });

  expect(
    result.state === 'completed' || result.state === 'completed_with_warnings',
    JSON.stringify(result),
  ).toBe(true);
  expect(result.bundleDir).toBeDefined();
  const bundleDir = result.bundleDir!;

  const verification = await verifyBundle(bundleDir);
  expect(verification.ok, JSON.stringify(verification.findings)).toBe(true);

  const documents = await documentBundle({ bundleDir, generatedAt: '2026-08-20T12:05:00Z' });
  return { bundleDir, documents };
}

describe('platform-provider-seam: context mode', () => {
  it('captures both real flows, seals a verifiable bundle, and documents them with no canary anywhere', async () => {
    const { bundleDir, documents } = await runSeam('context');

    expect(documents.skipped, JSON.stringify(documents.skipped)).toHaveLength(0);
    expect(documents.documented.map((d) => d.flowId).sort()).toEqual([
      'flow-bot',
      'flow-inboundcall',
    ]);

    // Derived: the documents directory is a slug of each flow's own display
    // name plus a short id, and these are real sanitized fixtures whose names
    // this test has no business hardcoding.
    const technicalFor = (flowId: string): string | undefined =>
      Object.entries(documents.files).find(
        ([path]) => path.includes(flowId.slice(0, 8)) && path.endsWith('/technical.md'),
      )?.[1];
    const inboundTechnical = technicalFor('flow-inboundcall');
    expect(inboundTechnical).toBeDefined();
    expect(inboundTechnical).toContain('47');

    const botTechnical = technicalFor('flow-bot');
    expect(botTechnical).toBeDefined();
    expect(botTechnical!.length).toBeGreaterThan(0);

    const everything = JSON.stringify(documents.files);
    expect(everything).not.toContain(CANARY);

    const manifestRaw = await readFile(join(bundleDir, 'bundle-manifest.json'), 'utf8');
    expect(manifestRaw).not.toContain(CANARY);
    expect(JSON.parse(manifestRaw).policy.mode).toBe('context');
  });
});

describe('platform-provider-seam: migration mode', () => {
  it('captures both real flows, seals a verifiable bundle, and documents them with no canary anywhere', async () => {
    const { bundleDir, documents } = await runSeam('migration');

    expect(documents.documented.map((d) => d.flowId).sort()).toEqual([
      'flow-bot',
      'flow-inboundcall',
    ]);

    const everything = JSON.stringify(documents.files);
    expect(everything).not.toContain(CANARY);

    const manifestRaw = await readFile(join(bundleDir, 'bundle-manifest.json'), 'utf8');
    expect(manifestRaw).not.toContain(CANARY);
    const manifest = JSON.parse(manifestRaw) as {
      policy: { mode: string };
      counts: { resources: number };
    };
    expect(manifest.policy.mode).toBe('migration');
    // Migration mode actually walked and persisted resource bodies -- this
    // is the concrete difference ADR-018 promises between the two modes.
    expect(manifest.counts.resources).toBeGreaterThan(0);
  });
});
