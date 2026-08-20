// packages/genesys-platform/src/errors.ts
//
// The one error type every call in this package throws.
//
// AGENTS.md forbids leaking an upstream response body or header value into a
// log, error, or exception. `PlatformApiError` enforces that structurally,
// not by convention: its constructor accepts only a fixed, pre-written
// message per category (never the caller's raw text), and its fields do not
// include a slot for a request body, a response body, or any header other
// than the one correlation id Genesys documents for support cases. There is
// no field to accidentally populate with something sensitive because the
// field does not exist on the type.

export type PlatformApiErrorCategory =
  | 'auth'
  | 'permission'
  | 'not_found'
  | 'rate_limit'
  | 'transport'
  | 'server'
  | 'validation'
  | 'unsupported_region'
  /**
   * A 403 from a media/asset host (a pre-signed prompt-audio URL), not the
   * configured API host. Same status code as `permission`, opposite
   * remediation: `docs/spikes/S5-prompt-audio.md` measured these URLs
   * expiring in roughly an hour, so a 403 here almost always means the URL
   * lapsed, not that a role is missing. Retryable exactly once, and only by
   * re-resolving the owning resource for a fresh URL -- retrying the same
   * expired URL again cannot succeed.
   */
  | 'expired_asset_url';

export interface PlatformApiErrorInit {
  /** HTTP status, or 0 when no response was ever received (region resolution,
   * a network failure, a request-budget refusal). */
  readonly status: number;
  readonly category: PlatformApiErrorCategory;
  readonly retryable: boolean;
  /** `ININ-Correlation-Id` from the response, if one was received. The one
   * header value this type is permitted to carry -- Genesys documents it as
   * the identifier support uses to look up a request, and it identifies a
   * request, not tenant content. */
  readonly correlationId: string | null;
  /** The request path (no query string, no host, no credentials) or a short
   * logical name such as `oauth/token`. Never the full URL: query strings on
   * this adapter's endpoints never carry secrets, but treating the path as
   * the only safe fragment is a rule simpler to keep than to re-justify per
   * endpoint. */
  readonly endpoint: string;
  /** A fixed, human-written string. Never derived from a response body,
   * request body, or header. */
  readonly message: string;
}

/**
 * Fixed, content-free messages, keyed by category. Used when a call site
 * does not need a more specific message than "what kind of failure was
 * this" -- most call sites should still pass their own `message` describing
 * *which operation* failed, since that alone is not sensitive.
 */
export const DEFAULT_MESSAGES: Readonly<Record<PlatformApiErrorCategory, string>> = {
  auth: 'Authentication against Genesys Cloud failed.',
  permission: 'The connected OAuth client lacks a permission this operation requires.',
  not_found: 'The requested resource does not exist or is not visible to this client.',
  rate_limit: 'Genesys Cloud rate-limited this client.',
  transport: 'Failed to reach the Genesys Cloud API.',
  server: 'Genesys Cloud returned a server error.',
  validation: 'The response from Genesys Cloud did not match the expected shape.',
  unsupported_region: 'The configured Genesys Cloud region is not recognized.',
  expired_asset_url: 'The signed media URL for this asset was rejected; it has likely expired.',
};

export class PlatformApiError extends Error {
  readonly status: number;
  readonly category: PlatformApiErrorCategory;
  readonly retryable: boolean;
  readonly correlationId: string | null;
  readonly endpoint: string;

  constructor(init: PlatformApiErrorInit) {
    super(init.message);
    this.name = 'PlatformApiError';
    this.status = init.status;
    this.category = init.category;
    this.retryable = init.retryable;
    this.correlationId = init.correlationId;
    this.endpoint = init.endpoint;
  }

  /**
   * Explicit allow-list for serialization. The default `Error` JSON
   * representation already carries nothing sensitive, but naming exactly
   * what crosses this boundary makes the guarantee something a test can
   * check field-by-field rather than trust by omission.
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      status: this.status,
      category: this.category,
      retryable: this.retryable,
      correlationId: this.correlationId,
      endpoint: this.endpoint,
    };
  }
}
