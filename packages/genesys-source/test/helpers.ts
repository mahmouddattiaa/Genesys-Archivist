// packages/genesys-source/test/helpers.ts
//
// A routed fake fetch: the provider under test makes many different calls in
// sequence (organizations/me, flows, flow versions, queues, prompts,
// integrations...), so a simple FIFO queue of responses (as
// genesys-platform's own test helper uses for single-endpoint tests) does
// not scale here. Rules are matched in order against the request URL and
// method; the first match responds. No test in this file's suite opens a
// socket -- every response comes from a rule.
import type { ProfileId } from '@genesys-archivist/domain';
import { asProfileId } from '@genesys-archivist/domain';
import type { FetchLike } from '@genesys-archivist/genesys-platform';
import type { SecretStore } from '@genesys-archivist/security';

export interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
}

export interface RouteRule {
  readonly match: (url: URL, method: string) => boolean;
  readonly respond: (url: URL) => Response | Promise<Response>;
}

export interface RoutedFetch {
  readonly fetch: FetchLike;
  readonly calls: RecordedCall[];
  /** Prepends a rule so it is tried before rules already registered --
   * useful for a test that needs to override one specific call (e.g. "the
   * second call to this queue 500s, then succeeds") on top of a shared
   * baseline of routes. */
  addRule(rule: RouteRule): void;
}

function headersToObject(init: RequestInit['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  if (init === undefined) return out;
  if (init instanceof Headers) {
    init.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  if (Array.isArray(init)) {
    for (const pair of init) {
      const [k, v] = pair;
      if (k !== undefined && v !== undefined) out[k] = v;
    }
    return out;
  }
  for (const [k, v] of Object.entries(init))
    out[k] = Array.isArray(v) ? v.join(', ') : (v as string);
  return out;
}

export function createRoutedFetch(initialRules: readonly RouteRule[] = []): RoutedFetch {
  const rules: RouteRule[] = [...initialRules];
  const calls: RecordedCall[] = [];

  const fetchLike: FetchLike = async (input, init) => {
    const method = init?.method ?? 'GET';
    calls.push({ url: input, method, headers: headersToObject(init?.headers) });
    const url = new URL(input);
    for (const rule of rules) {
      if (rule.match(url, method)) return rule.respond(url);
    }
    throw new Error(`test error: no route matched ${method} ${input}`);
  };

  return {
    fetch: fetchLike,
    calls,
    addRule(rule: RouteRule): void {
      rules.unshift(rule);
    },
  };
}

export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

/** A route for the OAuth client-credentials token endpoint, so any test
 * that exercises a real `PlatformSourceProvider` (built through
 * `createPlatformSourceProvider`, which builds its own `TokenProvider`)
 * does not need to special-case authentication in every test. */
export function tokenRoute(loginHost: string, accessToken = 'test-access-token'): RouteRule {
  return {
    match: (url, method) =>
      url.host === loginHost && url.pathname === '/oauth/token' && method === 'POST',
    respond: () => jsonResponse({ access_token: accessToken, expires_in: 3600 }),
  };
}

/** Matches `GET <apiHost><pathPattern>` where `pathPattern` may contain
 * `:param` segments (matched but not captured -- tests assert on `url`
 * directly when they need a captured value). */
export function apiRoute(
  apiHost: string,
  pathPattern: string,
  respond: (url: URL) => Response | Promise<Response>,
): RouteRule {
  const segments = pathPattern.split('/');
  return {
    match: (url, method) => {
      if (method !== 'GET' || url.host !== apiHost) return false;
      const urlSegments = url.pathname.split('/');
      if (urlSegments.length !== segments.length) return false;
      return segments.every((seg, i) => seg.startsWith(':') || seg === urlSegments[i]);
    },
    respond,
  };
}

export class InMemorySecretStore implements SecretStore {
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
    const had = this.#secrets.delete(profileId);
    return Promise.resolve(had);
  }
}

export const TEST_PROFILE_ID: ProfileId = asProfileId('test-profile');

export function immediateSleep(): (ms: number) => Promise<void> {
  return () => Promise.resolve();
}

export function fixedClock(iso: string): () => Date {
  const date = new Date(iso);
  return () => date;
}

export function createRecordingLogger(): {
  readonly logger: {
    debug: (event: string, fields?: Record<string, unknown>) => void;
    info: (event: string, fields?: Record<string, unknown>) => void;
    warn: (event: string, fields?: Record<string, unknown>) => void;
    error: (event: string, fields?: Record<string, unknown>) => void;
  };
  readonly lines: string[];
} {
  const lines: string[] = [];
  const record = (event: string, fields?: Record<string, unknown>): void => {
    lines.push(JSON.stringify({ event, ...fields }));
  };
  return { logger: { debug: record, info: record, warn: record, error: record }, lines };
}
