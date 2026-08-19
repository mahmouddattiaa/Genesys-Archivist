// packages/domain/src/canonical.ts
import { createHash } from 'node:crypto';

export interface CanonicalOptions {
  readonly canonicalizerVersion: string;
  readonly volatileKeys: ReadonlySet<string>;
  /** JSON-pointer prefixes whose arrays carry execution semantics in their order. */
  readonly orderSensitivePaths: ReadonlySet<string>;
}

function normalizeString(value: string): string {
  return value.replace(/\r\n/g, '\n').normalize('NFC');
}

function walk(value: unknown, pointer: string, options: CanonicalOptions): unknown {
  if (typeof value === 'string') return normalizeString(value);
  if (value === null || typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    const items = value.map((item, index) => walk(item, `${pointer}/${String(index)}`, options));
    if (options.orderSensitivePaths.has(pointer)) return items;
    return [...items].sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !options.volatileKeys.has(key))
    .map(([key, item]) => [key, walk(item, `${pointer}/${key}`, options)] as const)
    .sort(([a], [b]) => (a < b ? -1 : 1));

  return Object.fromEntries(entries);
}

export function canonicalize(value: unknown, options: CanonicalOptions): string {
  return JSON.stringify({ v: options.canonicalizerVersion, d: walk(value, '', options) });
}

export function contentHash(value: unknown, options: CanonicalOptions): string {
  const digest = createHash('sha256').update(canonicalize(value, options), 'utf8').digest('hex');
  return `sha256:${digest}`;
}
