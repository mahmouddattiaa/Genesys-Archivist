// packages/genesys-source/src/redact-resource.ts
//
// A second, independent layer of credential stripping on top of
// `@genesys-archivist/genesys-platform`'s `omitCredentials` (endpoints.ts).
// S3 Finding 3 measured `getIntegration`'s response NOT carrying a
// `credentials` field at all under the OAuth client used in the spike --
// the property holds structurally, not merely by discipline -- but AGENTS.md
// treats every field Genesys could ever populate as untrusted, so this file
// exists for the field shapes S3 did not happen to observe. Every resolved
// resource body passes through here before it reaches `safeMetadata`,
// regardless of resource type: this is a floor, not a per-type opt-in.
import {
  redact,
  defaultPolicy,
  type RedactionCategory,
  type RedactionPolicy,
} from '@genesys-archivist/security';

/**
 * `defaultPolicy` (shared with `@genesys-archivist/observability`'s logger)
 * already strips `clientSecret`, `accessToken`, `password`, `privateKey`,
 * `authorization`, and `cookie`-shaped keys. Extended here with key names
 * specific to Genesys integration configuration that are not general-purpose
 * enough to belong in the shared policy this whole repository logs through.
 */
const EXTRA_SENSITIVE_KEYS: ReadonlyMap<string, RedactionCategory> = new Map([
  ['credentials', 'client-secret'],
  ['credential', 'client-secret'],
  ['secret', 'client-secret'],
  ['apikey', 'client-secret'],
  ['api_key', 'client-secret'],
  ['token', 'access-token'],
]);

const platformPolicy: RedactionPolicy = {
  sensitiveKeys: new Map([...defaultPolicy.sensitiveKeys, ...EXTRA_SENSITIVE_KEYS]),
};

/**
 * Applies the redaction policy to a resource body before it is placed in
 * `safeMetadata`. Returns the redacted value; a caller that needs to know
 * *whether* anything was stripped (worth a warning, never worth blocking
 * the capture) can inspect `RedactionResult.counts` directly via `redact`.
 */
export function redactResourceBody(value: unknown): unknown {
  return redact(value, platformPolicy).value;
}

export { platformPolicy };
