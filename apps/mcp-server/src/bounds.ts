// apps/mcp-server/src/bounds.ts
//
// docs/03's output-size policy in one file: the hard caps a tool result must
// respect, and the continuation-token mechanism that lets a bounded page
// stand in for a result too large to return in one call. A client must never
// be able to hand this process a crafted token and have it read anything --
// tokens carry no path and no filesystem reference, only an opaque, signed
// view of "which page of which query", so `decodeToken` has nothing to read
// even if a caller forges one that passes its signature check.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** docs/03: "Tool result summaries target less than 32 KiB." Applied to the
 * serialized envelope as a whole by callers that build large `data` payloads
 * (flow lists, diffs); small fixed-shape tools do not need to check this. */
export const MAX_SUMMARY_BYTES = 32 * 1024;

/** The default and maximum number of list items (flows, etc.) one tool call
 * returns, regardless of what a caller asks for or what the port would
 * otherwise hand back. */
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

/** docs/03: "Diagnostic errors are capped and aggregated by code." The
 * per-run error list a tool inlines never exceeds this; the rest is only
 * ever reachable through the `runs/{runId}/errors` resource. */
export const MAX_ERROR_ITEMS = 50;

/** A continuation token is opaque to every caller, but it is not free-form:
 * this is the exact information this server needs to resume a specific
 * bounded listing, and nothing else -- no path, no query the caller did not
 * already supply back to the same tool.
 */
export interface ContinuationPayload {
  /** Which tool/operation this token is valid for. A token minted by
   * `genesys_flows_list` must not be replayable against a different tool. */
  readonly scope: string;
  /** The underlying port's own opaque page token, carried through unread. */
  readonly portPageToken: string;
  /** Epoch milliseconds after which this token is refused. */
  readonly expiresAt: number;
}

/**
 * The HMAC key that makes a continuation token tamper-evident. Generated
 * fresh per process and held only in memory: it is not a Genesys credential
 * and never needs to survive a restart (a token minted before a restart
 * simply stops working, which is a page a client re-requests, not a security
 * incident). Overridable only for tests, which need two "processes" to agree
 * on a key to round-trip a token across separate `encodeToken`/`decodeToken`
 * calls.
 */
export function newTokenKey(): Buffer {
  return randomBytes(32);
}

const DEFAULT_TOKEN_KEY = newTokenKey();

const DEFAULT_TOKEN_TTL_MS = 15 * 60 * 1000;

function sign(key: Buffer, body: string): string {
  return createHmac('sha256', key).update(body).digest('base64url');
}

/** Encodes a continuation payload as `base64url(json).base64url(hmac)`. The
 * two segments are joined with `.` so a truncated or concatenated token is
 * rejected by the split, not by a parser that has to guess where one part
 * ends. */
export function encodeToken(
  payload: Omit<ContinuationPayload, 'expiresAt'>,
  options: { readonly key?: Buffer; readonly ttlMs?: number; readonly now?: () => Date } = {},
): string {
  const key = options.key ?? DEFAULT_TOKEN_KEY;
  const now = options.now ?? (() => new Date());
  const full: ContinuationPayload = {
    ...payload,
    expiresAt: now().getTime() + (options.ttlMs ?? DEFAULT_TOKEN_TTL_MS),
  };
  const body = Buffer.from(JSON.stringify(full), 'utf8').toString('base64url');
  return `${body}.${sign(key, body)}`;
}

export type DecodeTokenResult =
  | { readonly ok: true; readonly payload: ContinuationPayload }
  | { readonly ok: false; readonly reason: 'malformed' | 'tampered' | 'expired' };

/**
 * Verifies and decodes a continuation token. Every failure path returns a
 * `reason` instead of throwing: a crafted token is an ordinary (if hostile)
 * input, not a fault, and the caller (`bounds.ts`'s consumers in
 * `tools/flows-list.ts`) turns any non-`ok` result into an `INVALID_ARGUMENT`
 * envelope without ever touching the filesystem or echoing the token back.
 */
export function decodeToken(
  token: string,
  options: { readonly key?: Buffer; readonly now?: () => Date; readonly scope?: string } = {},
): DecodeTokenResult {
  const key = options.key ?? DEFAULT_TOKEN_KEY;
  const now = options.now ?? (() => new Date());

  const parts = token.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'malformed' };
  const [body, signature] = parts;
  if (body === undefined || body === '' || signature === undefined || signature === '') {
    return { ok: false, reason: 'malformed' };
  }

  const expected = sign(key, body);
  const expectedBuf = Buffer.from(expected, 'utf8');
  const actualBuf = Buffer.from(signature, 'utf8');
  // Constant-time comparison requires equal-length buffers; a length
  // mismatch is itself proof of tampering, so it is safe to short-circuit.
  if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
    return { ok: false, reason: 'tampered' };
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!isContinuationPayload(decoded)) return { ok: false, reason: 'malformed' };
  if (options.scope !== undefined && decoded.scope !== options.scope) {
    return { ok: false, reason: 'malformed' };
  }
  if (decoded.expiresAt <= now().getTime()) return { ok: false, reason: 'expired' };

  return { ok: true, payload: decoded };
}

function isContinuationPayload(value: unknown): value is ContinuationPayload {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['scope'] === 'string' &&
    typeof candidate['portPageToken'] === 'string' &&
    typeof candidate['expiresAt'] === 'number'
  );
}

/** Clamps a caller-requested page size into `[1, MAX_PAGE_SIZE]`, defaulting
 * to `DEFAULT_PAGE_SIZE` when omitted. A caller cannot opt out of the cap by
 * asking for a larger number -- that is the entire point of a hard bound. */
export function clampPageSize(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_PAGE_SIZE;
  return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(requested)));
}

/** Truncates text to a byte budget on a UTF-8 boundary, reporting whether it
 * had to. Used for any tenant-derived string a tool inlines directly (short
 * warnings, names) -- large content belongs in a resource instead, per
 * docs/03, not in a truncated tool result. */
export function boundText(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, 'utf8');
  if (buf.byteLength <= maxBytes) return { text, truncated: false };
  // Trim byte-for-byte, then re-decode leniently ('utf8' with a partial
  // multi-byte sequence at the end silently drops it rather than throwing),
  // so the boundary never lands mid-codepoint.
  return { text: buf.subarray(0, maxBytes).toString('utf8'), truncated: true };
}
