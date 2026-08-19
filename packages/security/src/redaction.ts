// packages/security/src/redaction.ts
export type RedactionCategory =
  | 'authorization'
  | 'client-secret'
  | 'access-token'
  | 'password'
  | 'private-key'
  | 'header-value'
  | 'secure-variable'
  | 'url-credential'
  | 'control-characters';

export interface RedactionPolicy {
  /** Lowercased key names whose values are replaced wholesale. */
  readonly sensitiveKeys: ReadonlyMap<string, RedactionCategory>;
}

export interface RedactionResult {
  readonly value: unknown;
  readonly counts: ReadonlyMap<RedactionCategory, number>;
}

export const defaultPolicy: RedactionPolicy = {
  sensitiveKeys: new Map<string, RedactionCategory>([
    ['authorization', 'authorization'],
    ['clientsecret', 'client-secret'],
    ['client_secret', 'client-secret'],
    ['accesstoken', 'access-token'],
    ['access_token', 'access-token'],
    ['refreshtoken', 'access-token'],
    ['password', 'password'],
    ['privatekey', 'private-key'],
    ['cookie', 'authorization'],
  ]),
};

const token = (category: RedactionCategory): string => `[REDACTED:${category}]`;
const REDACTED_PATTERN = /^\[REDACTED:[a-z-]+\]$/;
// Matching control characters is the point of this pattern: it strips them
// from tenant-controlled text before it can reach any log or output.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const URL_CREDENTIALS = /^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/i;

export function redact(value: unknown, policy: RedactionPolicy): RedactionResult {
  const counts = new Map<RedactionCategory, number>();
  const bump = (category: RedactionCategory): void => {
    counts.set(category, (counts.get(category) ?? 0) + 1);
  };

  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') {
      if (REDACTED_PATTERN.test(node)) return node; // already redacted: stay idempotent
      let out = node;
      if (URL_CREDENTIALS.test(out)) {
        out = out.replace(URL_CREDENTIALS, '$1');
        bump('url-credential');
      }
      if (CONTROL_CHARS.test(out)) {
        out = out.replace(CONTROL_CHARS, '');
        bump('control-characters');
      }
      return out;
    }
    if (node === null || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(walk);

    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      const category = policy.sensitiveKeys.get(key.toLowerCase().replace(/[^a-z_]/g, ''));
      if (category !== undefined) {
        if (typeof child === 'string' && REDACTED_PATTERN.test(child)) {
          out[key] = child;
        } else {
          out[key] = token(category);
          bump(category);
        }
        continue;
      }
      out[key] = walk(child);
    }
    return out;
  };

  return { value: walk(value), counts };
}
