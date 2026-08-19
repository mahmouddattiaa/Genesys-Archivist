// packages/security/src/paths.ts
import { isAbsolute, resolve, sep } from 'node:path';

export class UntrustedPathError extends Error {
  constructor(reason: string) {
    // Deliberately omits the offending path: it is tenant-controlled and this
    // message reaches logs.
    super(`Refused to resolve path: ${reason}`);
    this.name = 'UntrustedPathError';
  }
}

const MAX_SEGMENT = 120;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function safeSegment(input: string): string {
  const slug = input
    .normalize('NFC')
    // Matching control characters is the point of this slug: attacker-controlled
    // text must never carry a control character into a filesystem path.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, MAX_SEGMENT);

  if (slug.length === 0) return 'unnamed';
  if (WINDOWS_RESERVED.test(slug)) return `${slug}-`;
  return slug;
}

export function resolveWithinRoot(root: string, segments: readonly string[]): string {
  for (const segment of segments) {
    if (segment.includes('\u0000')) throw new UntrustedPathError('segment contains a null byte');
    if (isAbsolute(segment)) throw new UntrustedPathError('segment is absolute');
  }
  const canonicalRoot = resolve(root);
  const candidate = resolve(canonicalRoot, ...segments);
  if (candidate !== canonicalRoot && !candidate.startsWith(canonicalRoot + sep)) {
    throw new UntrustedPathError('resolved outside the approved output root');
  }
  return candidate;
}
