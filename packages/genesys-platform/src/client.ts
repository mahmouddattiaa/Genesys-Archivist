// packages/genesys-platform/src/client.ts
//
// `PlatformApiClient` is the entire read surface this repository has against
// Genesys Cloud. It exposes exactly two methods -- `get` and `getBinary` --
// and both issue nothing but HTTP GET. That is a structural choice, not a
// style preference: AGENTS.md requires that no mutation method be reachable
// from a production adapter, and the SDK this repo depends on for path
// reference (`purecloud-platform-client-v2`) exposes hundreds of POST/PUT/
// DELETE methods on the same classes as their GET counterparts. Building on
// the global `fetch` instead (ADR-019) makes "read-only" a property of this
// class's public interface rather than a promise about which of the SDK's
// methods a developer remembers never to call.
import { z } from 'zod';
import type { Logger } from '@genesys-archivist/observability';
import { PlatformApiError, type PlatformApiErrorCategory } from './errors.js';
import type { FetchLike, SleepLike } from './fetch-like.js';
import type { TokenProvider } from './token.js';

/** A `Retry-After` this large is refused rather than slept through: sleeping
 * for it would tie up a capture run's worker for longer than any single
 * request budget makes sense to spend waiting, and a caller is better served
 * failing fast and deciding for itself whether to reschedule the whole run. */
const MAX_RETRY_AFTER_MS = 5 * 60_000;

const RETRYABLE_STATUS_BACKOFF_BASE_MS = 250;
const RETRYABLE_STATUS_BACKOFF_CAP_MS = 8_000;

export type QueryValue = string | number | boolean | undefined;
export type QueryParams = Readonly<Record<string, QueryValue | readonly QueryValue[]>>;

export interface GetOptions<T> {
  readonly query?: QueryParams;
  readonly schema: z.ZodType<T>;
}

export interface BinaryResult {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly correlationId: string | null;
}

export interface PlatformApiClientOptions {
  readonly apiHost: string;
  readonly tokenProvider: TokenProvider;
  readonly fetch: FetchLike;
  readonly sleep: SleepLike;
  readonly now: () => Date;
  readonly logger?: Logger;
  /** Bounds total HTTP requests (including retries) this client instance
   * will ever issue, so a run against a pathological or misbehaving tenant
   * cannot loop forever. */
  readonly maxRequests?: number;
  readonly maxRetries?: number;
}

const DEFAULT_MAX_REQUESTS = 20_000;
const DEFAULT_MAX_RETRIES = 5;

function buildUrl(apiHost: string, path: string, query: QueryParams | undefined): URL {
  const url = new URL(path, `https://${apiHost}`);
  if (query === undefined) return url;
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item === undefined) continue;
        url.searchParams.append(key, String(item));
      }
      continue;
    }
    url.searchParams.append(key, String(value));
  }
  return url;
}

/** Full jitter: `random(0, min(cap, base * 2^attempt))`. Spreads retries
 * from many concurrent requests instead of having them all wake up and
 * retry in lockstep. */
function backoffMs(attempt: number): number {
  const bound = Math.min(
    RETRYABLE_STATUS_BACKOFF_CAP_MS,
    RETRYABLE_STATUS_BACKOFF_BASE_MS * 2 ** attempt,
  );
  return Math.random() * bound;
}

/** `Retry-After` is either a whole number of seconds or an HTTP-date.
 * Returns `null` if the header is absent or unparseable -- callers treat
 * that the same as "refused", never as "wait zero seconds". */
function parseRetryAfterMs(header: string | null, now: () => Date): number | null {
  if (header === null) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const asDate = Date.parse(header);
  if (Number.isNaN(asDate)) return null;
  return Math.max(0, asDate - now().getTime());
}

function categoryForStatus(status: number): PlatformApiErrorCategory {
  switch (status) {
    case 400:
      return 'validation';
    case 401:
      return 'auth';
    case 403:
      return 'permission';
    case 404:
      return 'not_found';
    default:
      return 'transport';
  }
}

const NON_RETRYABLE_MESSAGES: Partial<Record<PlatformApiErrorCategory, string>> = {
  validation: 'Genesys Cloud rejected the request as invalid.',
  auth: 'Authentication against Genesys Cloud failed.',
  permission: 'The connected OAuth client lacks a permission this operation requires.',
  not_found: 'The requested resource does not exist or is not visible to this client.',
};

interface SendResult {
  readonly response: Response;
  readonly correlationId: string | null;
}

export class PlatformApiClient {
  readonly #apiHost: string;
  readonly #tokenProvider: TokenProvider;
  readonly #fetch: FetchLike;
  readonly #sleep: SleepLike;
  readonly #now: () => Date;
  readonly #logger: Logger | undefined;
  readonly #maxRequests: number;
  readonly #maxRetries: number;
  #requestCount = 0;

  constructor(options: PlatformApiClientOptions) {
    this.#apiHost = options.apiHost;
    this.#tokenProvider = options.tokenProvider;
    this.#fetch = options.fetch;
    this.#sleep = options.sleep;
    this.#now = options.now;
    this.#logger = options.logger;
    this.#maxRequests = options.maxRequests ?? DEFAULT_MAX_REQUESTS;
    this.#maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  }

  /** Total requests issued so far, retries included. Exposed so a caller
   * composing many client calls (a whole-organization capture) can decide
   * for itself when to stop starting new work rather than discovering the
   * budget only when the next call throws. */
  get requestCount(): number {
    return this.#requestCount;
  }

  async get<T>(path: string, options: GetOptions<T>): Promise<T> {
    const url = buildUrl(this.#apiHost, path, options.query);
    const { response, correlationId } = await this.#send(url);

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new PlatformApiError({
        status: response.status,
        category: 'validation',
        retryable: false,
        correlationId,
        endpoint: path,
        message: 'The response body was not valid JSON.',
      });
    }

    const parsed = options.schema.safeParse(body);
    if (!parsed.success) {
      throw new PlatformApiError({
        status: response.status,
        category: 'validation',
        retryable: false,
        correlationId,
        endpoint: path,
        message: 'The response body did not match the expected schema.',
      });
    }
    return parsed.data;
  }

  /**
   * Fetches raw bytes -- prompt audio, in practice. `path` may be an
   * absolute URL: Genesys serves recorded prompt audio from a signed,
   * time-limited media URI that is not on the API host and carries its own
   * auth in its query string (`docs/spikes/S5-prompt-audio.md` measured
   * every sampled download succeeding with no `Authorization` header at
   * all, and the signed URL itself expiring in roughly an hour). Bytes are
   * never logged; only their length and content type are observable from
   * the result, and the URL this method was called with is never retained
   * anywhere beyond the single `fetch` call it makes -- not cached, not
   * echoed into a thrown error, not logged. Callers must treat the `path`
   * argument itself as a bearer credential: never persist it, and re-derive
   * a fresh one from the owning resource rather than reusing an old one.
   */
  async getBinary(path: string): Promise<BinaryResult> {
    const url = /^https?:\/\//i.test(path)
      ? new URL(path)
      : buildUrl(this.#apiHost, path, undefined);
    const { response, correlationId } = await this.#send(url);
    const bytes = new Uint8Array(await response.arrayBuffer());
    return {
      bytes,
      contentType: response.headers.get('content-type') ?? 'application/octet-stream',
      correlationId,
    };
  }

  async #send(url: URL, attempt = 0): Promise<SendResult> {
    // A pre-signed media URI is its own credential (S5) and is deliberately
    // never on the configured API host, so the bearer token belongs there
    // and nowhere else -- attaching it to a host chosen by an upstream
    // response rather than by us would send this adapter's credential to
    // wherever that response pointed. This is a positive allow-check
    // (attach only for the known host), not a denylist of hosts to avoid.
    const isApiHost = url.host === this.#apiHost;
    // For the API host, `pathname` is our own endpoint template plus
    // resource ids -- not secret (identity.ts: "flow, queue and client
    // identifiers are not secret API keys") -- so it is safe to log or echo
    // into a thrown error. For any other host, the whole URL is treated as
    // sensitive: a signed media path can encode enough of the credential in
    // segments other than the query string that only the query string would
    // miss, so nothing derived from it -- not even the path -- is used here.
    const endpoint = isApiHost ? url.pathname : '<asset-host>';

    if (this.#requestCount >= this.#maxRequests) {
      throw new PlatformApiError({
        status: 0,
        category: 'transport',
        retryable: false,
        correlationId: null,
        endpoint,
        message: 'This client has exceeded its request budget for the run.',
      });
    }

    const headers: Record<string, string> = {};
    if (isApiHost) {
      headers['authorization'] = `Bearer ${await this.#tokenProvider.getToken()}`;
    }
    this.#requestCount += 1;
    this.#logger?.debug('platform_api_request', { endpoint, attempt, isApiHost });

    let response: Response;
    try {
      response = await this.#fetch(url.toString(), { method: 'GET', headers });
    } catch {
      if (attempt >= this.#maxRetries) {
        throw new PlatformApiError({
          status: 0,
          category: 'transport',
          retryable: true,
          correlationId: null,
          endpoint,
          // The caught error's own `.message` can carry the full request
          // URL (Node's fetch implementation does this) -- never included,
          // even though a fixed string is the only visible cost.
          message: isApiHost
            ? 'Failed to reach the Genesys Cloud API.'
            : 'Failed to reach the asset host for this resource.',
        });
      }
      await this.#sleep(backoffMs(attempt));
      return this.#send(url, attempt + 1);
    }

    const correlationId = response.headers.get('inin-correlation-id');
    this.#logger?.debug('platform_api_response', {
      endpoint,
      attempt,
      status: response.status,
      correlationId,
    });

    if (response.ok) return { response, correlationId };

    // A 403 on a media host is measured (S5) to be near-certainly an
    // expired signed URL, not a missing permission -- the two share a
    // status code but demand opposite remediation. Retryable, but only by
    // the caller re-resolving the owning resource for a fresh URL: retrying
    // the same expired URL again cannot succeed, so this client's own
    // retry loop below must not (and does not) attempt that.
    if (response.status === 403 && !isApiHost) {
      throw new PlatformApiError({
        status: 403,
        category: 'expired_asset_url',
        retryable: true,
        correlationId,
        endpoint,
        message: 'The signed media URL for this asset was rejected; it has likely expired.',
      });
    }

    if (response.status === 429) {
      const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'), this.#now);
      if (retryAfterMs === null || retryAfterMs > MAX_RETRY_AFTER_MS) {
        throw new PlatformApiError({
          status: 429,
          category: 'rate_limit',
          retryable: true,
          correlationId,
          endpoint,
          message:
            retryAfterMs === null
              ? 'Genesys Cloud rate-limited this client and specified no Retry-After.'
              : 'Genesys Cloud rate-limited this client for longer than this adapter will wait.',
        });
      }
      if (attempt >= this.#maxRetries) {
        throw new PlatformApiError({
          status: 429,
          category: 'rate_limit',
          retryable: true,
          correlationId,
          endpoint,
          message: 'Genesys Cloud rate-limited this client and the retry budget is exhausted.',
        });
      }
      await this.#sleep(retryAfterMs);
      return this.#send(url, attempt + 1);
    }

    if (response.status >= 500) {
      if (attempt >= this.#maxRetries) {
        throw new PlatformApiError({
          status: response.status,
          category: 'server',
          retryable: true,
          correlationId,
          endpoint,
          message: 'Genesys Cloud returned a server error and the retry budget is exhausted.',
        });
      }
      await this.#sleep(backoffMs(attempt));
      return this.#send(url, attempt + 1);
    }

    // 400 / 401 / 403 / 404, and anything else unexpected: never retried.
    const category = categoryForStatus(response.status);
    const message =
      NON_RETRYABLE_MESSAGES[category] ??
      `Genesys Cloud returned an unexpected status (${String(response.status)}).`;
    throw new PlatformApiError({
      status: response.status,
      category,
      retryable: false,
      correlationId,
      endpoint,
      message,
    });
  }
}
