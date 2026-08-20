// packages/genesys-platform/src/token.ts
//
// OAuth2 client credentials grant against `https://login.<host>/oauth/token`.
//
// The client secret is obtained from the injected `SecretStore` at the
// moment of use, inside `#refresh`, and lives only in a local `const` for
// the span of building the Basic auth header. It is never assigned to a
// field of this module's closures, never passed to a constructor argument
// that a caller might log, and never appears in anything this file returns:
// `getToken()` resolves to the bearer token string, not the client secret.
import { z } from 'zod';
import type { ProfileId } from '@genesys-archivist/domain';
import type { SecretStore } from '@genesys-archivist/security';
import { PlatformApiError } from './errors.js';
import type { FetchLike } from './fetch-like.js';

/** How early to refresh before the token's reported expiry. Refreshing
 * exactly at expiry risks a request landing just after the token has
 * already lapsed server-side; 60s of margin is cheap insurance against
 * clock skew between this process and Genesys. */
const DEFAULT_EARLY_REFRESH_MS = 60_000;

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().optional(),
  expires_in: z.number().int().positive(),
});

export interface TokenProviderOptions {
  readonly loginHost: string;
  readonly clientId: string;
  readonly secretStore: SecretStore;
  readonly profileId: ProfileId;
  readonly fetch: FetchLike;
  readonly now: () => Date;
  readonly earlyRefreshMs?: number;
}

export interface TokenProvider {
  /** Returns a currently-valid bearer token, refreshing if the cached one is
   * absent or within `earlyRefreshMs` of expiry. Concurrent callers during a
   * refresh share the same in-flight request rather than each starting
   * their own. */
  getToken(): Promise<string>;
}

interface CachedToken {
  readonly value: string;
  readonly expiresAt: number;
}

export function createTokenProvider(options: TokenProviderOptions): TokenProvider {
  const earlyRefreshMs = options.earlyRefreshMs ?? DEFAULT_EARLY_REFRESH_MS;
  let cached: CachedToken | null = null;
  let inFlight: Promise<CachedToken> | null = null;

  async function refresh(): Promise<CachedToken> {
    const secret = await options.secretStore.get(options.profileId);
    if (secret === null) {
      throw new PlatformApiError({
        status: 0,
        category: 'auth',
        retryable: false,
        correlationId: null,
        endpoint: 'oauth/token',
        message: 'No client secret is available for this profile in the secret store.',
      });
    }

    // `authHeader` is the only place the secret is used. It goes out of
    // scope with this function; nothing here stores it anywhere that
    // outlives this call.
    const authHeader = `Basic ${Buffer.from(`${options.clientId}:${secret}`).toString('base64')}`;

    let response: Response;
    try {
      response = await options.fetch(`https://${options.loginHost}/oauth/token`, {
        method: 'POST',
        headers: {
          authorization: authHeader,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials',
      });
    } catch {
      throw new PlatformApiError({
        status: 0,
        category: 'transport',
        retryable: true,
        correlationId: null,
        endpoint: 'oauth/token',
        message: 'Failed to reach the Genesys Cloud login host.',
      });
    }

    const correlationId = response.headers.get('inin-correlation-id');
    if (!response.ok) {
      throw new PlatformApiError({
        status: response.status,
        category: response.status === 401 || response.status === 403 ? 'auth' : 'server',
        retryable: response.status >= 500,
        correlationId,
        endpoint: 'oauth/token',
        message: 'The client credentials grant was rejected by Genesys Cloud.',
      });
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new PlatformApiError({
        status: response.status,
        category: 'validation',
        retryable: false,
        correlationId,
        endpoint: 'oauth/token',
        message: 'The token response was not valid JSON.',
      });
    }

    const parsed = tokenResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new PlatformApiError({
        status: response.status,
        category: 'validation',
        retryable: false,
        correlationId,
        endpoint: 'oauth/token',
        message: 'The token response did not match the expected shape.',
      });
    }

    return {
      value: parsed.data.access_token,
      expiresAt: options.now().getTime() + parsed.data.expires_in * 1000,
    };
  }

  return {
    async getToken(): Promise<string> {
      const nowMs = options.now().getTime();
      if (cached !== null && cached.expiresAt - earlyRefreshMs > nowMs) {
        return cached.value;
      }

      // Set `inFlight` synchronously, before any `await`, so every caller
      // that reaches this point in the same tick observes and awaits the
      // same promise rather than each starting its own token request.
      if (inFlight === null) {
        const started = refresh();
        inFlight = started;
        // A second, detached consumer purely to clear `inFlight` once the
        // request settles and to swallow the rejection on *this* chain --
        // every real caller below awaits `started` directly and sees any
        // failure there.
        started
          .catch(() => undefined)
          .finally(() => {
            inFlight = null;
          });
      }

      // Captured into a local before awaiting: `inFlight` itself can already
      // have been reset to `null` by the settle-and-clear chain above by the
      // time this `await` resumes, and `await null` would silently resolve
      // to `null` instead of the token.
      const active = inFlight;
      const token = await active;
      cached = token;
      return token.value;
    },
  };
}
