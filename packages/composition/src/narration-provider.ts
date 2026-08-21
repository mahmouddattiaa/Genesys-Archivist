// packages/composition/src/narration-provider.ts
//
// The real `NarrationProvider` adapter: an Anthropic-API-backed model call.
// `@genesys-archivist/narrative` deliberately opens no socket (see that
// package's own narration-provider.ts header) -- this is the concrete
// implementation composition wires in, per AGENTS.md's "adapters are wired
// in composition" rule and this file's own place in the dependency diagram.
//
// The security posture here mirrors genesys-provider.ts's exactly, for the
// same reason: the API key is a credential, subject to the same rule as the
// Genesys client secret ("never a credential in any MCP tool argument, log,
// manifest, snapshot, document, fixture, exception, or telemetry field").
// `options.secretStore.get(options.profileId)` is called fresh inside
// `narrate()`, at the moment of use, and the resolved key lives only in a
// local variable for the span of one request -- never assigned to a field
// on the object this function returns, never logged, and never woven into
// an error message. A response body is likewise never echoed into an error:
// this package has no way to know whether an error body from Anthropic
// contains an excerpt of the request it was sent (it can, for a 400), and a
// request body carries this flow's untrusted evidence pack.
import type { ProfileId } from '@genesys-archivist/domain';
import type { SecretStore } from '@genesys-archivist/security';
import type { FetchLike, SleepLike } from '@genesys-archivist/genesys-platform';
import type {
  NarrationDraft,
  NarrationProvider,
  NarrationRequest,
} from '@genesys-archivist/narrative';

export type { FetchLike, SleepLike };

export interface CreateAnthropicNarrationProviderOptions {
  /** The `SecretStore` key the narration API key was stored under. Never a
   * capture profile's own id directly -- `SecretStore` holds one secret per
   * key, and a capture profile's key already holds that profile's Genesys
   * client secret. Callers derive a distinct key (see
   * `apps/cli/src/commands/profile.ts`'s `narrationSecretProfileId`) so the
   * two credentials never collide in the same keyring entry. */
  readonly profileId: ProfileId;
  readonly secretStore: SecretStore;
  /** Defaults to `claude-sonnet-5`. */
  readonly model?: string;
  /** Defaults to `globalThis.fetch`. Overridable so every test in this
   * module's own suite runs with no real socket. */
  readonly fetch?: FetchLike;
  readonly sleep?: SleepLike;
  /** Defaults to `Math.random`. Overridable only so a test can make jittered
   * backoff delays deterministic; never used for anything security-relevant. */
  readonly random?: () => number;
  /** Total attempts across the initial request and every retry. Defaults to 4. */
  readonly maxAttempts?: number;
  /** Defaults to Anthropic's public Messages API endpoint. Overridable for
   * a test double or an approved private endpoint. */
  readonly baseUrl?: string;
}

const DEFAULT_MODEL = 'claude-sonnet-5';
const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_BASE_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MAX_TOKENS = 4096;
const BASE_BACKOFF_MS = 400;
const MAX_BACKOFF_MS = 8_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

// Statuses this adapter retries. 429 is Anthropic's rate-limit signal; 5xx is
// the server's own failure, not the caller's. Everything else -- 400
// (malformed request), 401 (bad key), 403 (forbidden), 404, 422, and so on --
// is a request-shape or authorization problem that a retry cannot fix, so
// retrying it would only spend the retry budget for nothing and delay
// surfacing a real, actionable failure.
function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

function backoffDelayMs(attempt: number, random: () => number): number {
  const exponential = BASE_BACKOFF_MS * 2 ** attempt;
  const jitter = random() * exponential * 0.5;
  return Math.min(exponential + jitter, MAX_BACKOFF_MS);
}

interface AnthropicRequestBody {
  readonly model: string;
  readonly max_tokens: number;
  readonly system: string;
  readonly messages: readonly { readonly role: 'user'; readonly content: string }[];
}

function buildRequestBody(model: string, request: NarrationRequest): AnthropicRequestBody {
  const { prompt } = request;
  return {
    model,
    max_tokens: MAX_TOKENS,
    // prompt.instructions (packages/narrative/src/prompt.ts) is this
    // package's own, tenant-content-free framing text -- see that module's
    // header for why it is defence in depth, not the control. The output-
    // contract sentence appended below is composition's own addition, not a
    // change to that module: it exists only to make the wire format
    // unambiguous to the model, and this adapter never trusts the model to
    // have followed it -- validateNarration re-checks every claim
    // regardless.
    system:
      `${prompt.instructions}\n\n` +
      'Respond with a single JSON object of exactly this shape and nothing else -- ' +
      'no prose before or after it, no markdown code fence: ' +
      '{"sections": [{"id": "...", "markdown": "...", "claims": [...]}], "unknowns": ["..."], "reviewRequired": true}. ' +
      `Every section "id" must be one of: ${prompt.allowedSectionIds.join(', ')}.`,
    messages: [{ role: 'user', content: prompt.delimitedData }],
  };
}

/** Loose, non-throwing shape check on the model's JSON reply. Deliberately
 * not a full schema: `validateNarration` (packages/narrative) is the actual
 * re-validator for every claim's content, and duplicating its rules here
 * would be a second copy of the control that can drift from the first. This
 * exists only to tell "the model returned something JSON-shaped enough to
 * hand onward" apart from "the response cannot be interpreted as a draft at
 * all", so this adapter can fail the latter case loudly rather than passing
 * garbage into the validator and calling that success. */
function looksLikeNarrationDraft(
  value: unknown,
): value is { sections: unknown[]; unknowns?: unknown[]; reviewRequired?: unknown } {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as Record<string, unknown>)['sections'])
  );
}

/** Extracts and parses the model's own JSON reply out of an Anthropic
 * Messages API response body. Throws a fixed, content-free error on any
 * failure -- the response body (which can itself contain excerpts the model
 * echoed from this flow's evidence pack) is never included in the thrown
 * message. */
function parseNarrationResponse(rawResponseText: string): NarrationDraft {
  let envelope: unknown;
  try {
    envelope = JSON.parse(rawResponseText);
  } catch {
    throw new Error('Narration provider returned a response this adapter could not parse.');
  }

  const content =
    typeof envelope === 'object' && envelope !== null
      ? (envelope as Record<string, unknown>)['content']
      : undefined;
  const textBlock = Array.isArray(content)
    ? content.find(
        (block): block is { type: 'text'; text: string } =>
          typeof block === 'object' &&
          block !== null &&
          (block as Record<string, unknown>)['type'] === 'text' &&
          typeof (block as Record<string, unknown>)['text'] === 'string',
      )
    : undefined;
  if (textBlock === undefined) {
    throw new Error('Narration provider returned a response this adapter could not parse.');
  }

  let draft: unknown;
  try {
    draft = JSON.parse(textBlock.text);
  } catch {
    throw new Error('Narration provider returned a response this adapter could not parse.');
  }

  if (!looksLikeNarrationDraft(draft)) {
    throw new Error('Narration provider returned a response this adapter could not parse.');
  }

  return {
    // Cast, not re-validated field by field: validateNarration
    // (packages/narrative/src/claim-validator.ts) is the actual re-validator
    // for every claim this draft contains, and it treats this exact input as
    // untrusted model output regardless of how this adapter typed it.
    sections: draft.sections as NarrationDraft['sections'],
    unknowns: Array.isArray(draft.unknowns) ? (draft.unknowns as readonly string[]) : [],
    reviewRequired: true,
  };
}

/**
 * Builds a `NarrationProvider` backed by the Anthropic Messages API.
 *
 * Retries 429 and 5xx responses, and network-level failures, with bounded
 * jittered backoff (`options.maxAttempts`, default 4 total attempts). Never
 * retries 400/401/403 -- those are the request or the credential, and no
 * amount of waiting fixes either. On exhausting retries, or on any
 * non-retryable failure, this rejects; callers such as
 * `runNarrationQueue` (packages/narrative/src/work-queue.ts) already treat a
 * rejected `narrate()` call as "this job failed, journal it, move on" rather
 * than losing the deterministic documentation that does not depend on this
 * provider at all.
 */
export function createAnthropicNarrationProvider(
  options: CreateAnthropicNarrationProviderOptions,
): NarrationProvider {
  const model = options.model ?? DEFAULT_MODEL;
  const fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const sleepImpl = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;

  return {
    async narrate(request: NarrationRequest): Promise<NarrationDraft> {
      // Resolved fresh on every call, held only in this local for the
      // duration of one request -- never on a field of the returned object,
      // never logged, never interpolated into a thrown error below.
      const apiKey = await options.secretStore.get(options.profileId);
      if (apiKey === null) {
        throw new Error(
          'No narration API key is stored for this profile. Run: archivist profile set-narration-key <profileId>',
        );
      }

      const body = buildRequestBody(model, request);
      let lastNetworkError: unknown;

      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        let response: Response;
        try {
          response = await fetchImpl(baseUrl, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-api-key': apiKey,
              'anthropic-version': ANTHROPIC_VERSION,
            },
            body: JSON.stringify(body),
          });
        } catch (error) {
          lastNetworkError = error;
          if (attempt < maxAttempts - 1) {
            await sleepImpl(backoffDelayMs(attempt, random));
            continue;
          }
          throw new Error(
            'Narration provider request failed: the network request did not complete.',
          );
        }

        if (response.ok) {
          const text = await response.text();
          return parseNarrationResponse(text);
        }

        // Drain the body so the connection can be reused, but never read it
        // into anything that leaves this scope -- an error body from
        // Anthropic can itself echo fragments of the request it was sent,
        // and the request body carries this flow's evidence pack.
        await response.text().catch(() => undefined);

        if (!isRetryableStatus(response.status)) {
          throw new Error(
            `Narration provider rejected the request (HTTP ${String(response.status)}).`,
          );
        }

        if (attempt < maxAttempts - 1) {
          await sleepImpl(backoffDelayMs(attempt, random));
          continue;
        }
        throw new Error(
          `Narration provider request failed after ${String(maxAttempts)} attempts ` +
            `(HTTP ${String(response.status)}).`,
        );
      }

      // Unreachable in practice (the loop above always returns or throws),
      // but keeps this function's return type honest without a non-null
      // assertion, and gives lastNetworkError a use if the loop body above
      // is ever restructured to fall through here.
      throw new Error(
        lastNetworkError instanceof Error
          ? 'Narration provider request failed: the network request did not complete.'
          : 'Narration provider request failed for an unknown reason.',
      );
    },
  };
}
