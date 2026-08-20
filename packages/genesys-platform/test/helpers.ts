// packages/genesys-platform/test/helpers.ts
//
// Shared test scaffolding: a fake fetch that records every call (method,
// url, headers) without opening a socket, an immediate sleep so
// retry/backoff tests run instantly, a fixed clock, and a minimal in-memory
// SecretStore. Every test in this package's suite builds its transport from
// these so the "no test may open a socket" and "fetch is never called with
// a non-GET method" guarantees are checkable by construction.
import type { ProfileId } from '@genesys-archivist/domain';
import { asProfileId } from '@genesys-archivist/domain';
import type { SecretStore } from '@genesys-archivist/security';
import type { FetchLike } from '../src/fetch-like.js';

export interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
}

export interface FakeFetchController {
  readonly fetch: FetchLike;
  readonly calls: RecordedCall[];
  /** Queues the next response(s) to return, in order. */
  queue(response: Response): void;
  queueJson(body: unknown, init?: ResponseInit): void;
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

export function createFakeFetch(): FakeFetchController {
  const calls: RecordedCall[] = [];
  const responses: Response[] = [];

  const fetchLike: FetchLike = (input, init) => {
    calls.push({
      url: input,
      method: init?.method ?? 'GET',
      headers: headersToObject(init?.headers),
    });
    const next = responses.shift();
    if (next === undefined) {
      throw new Error(`test error: no queued response for ${init?.method ?? 'GET'} ${input}`);
    }
    return Promise.resolve(next);
  };

  return {
    fetch: fetchLike,
    calls,
    queue(response: Response): void {
      responses.push(response);
    },
    queueJson(body: unknown, init?: ResponseInit): void {
      responses.push(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
          ...init,
        }),
      );
    },
  };
}

export function immediateSleep(): (ms: number) => Promise<void> {
  return () => Promise.resolve();
}

export function fixedClock(iso: string): () => Date {
  const date = new Date(iso);
  return () => date;
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

/** A `vi.fn`-wrapped logger capturing every field passed to every level, so
 * a canary test can assert none of the recorded calls contain a secret. */
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
  return {
    logger: { debug: record, info: record, warn: record, error: record },
    lines,
  };
}
