// packages/security/src/paths-real.ts
import { realpath } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { resolveWithinRoot, UntrustedPathError } from './paths.js';

async function deepestExistingRealPath(candidate: string): Promise<string> {
  let current = candidate;
  for (;;) {
    try {
      return await realpath(current);
    } catch {
      const parent = dirname(current);
      // dirname of a filesystem root returns itself; stop rather than loop.
      if (parent === current) return candidate;
      current = parent;
    }
  }
}

/**
 * Lexical containment, then physical containment.
 *
 * resolveWithinRoot alone is not sufficient: a symlink planted inside the
 * output root can point anywhere, and the lexical check will happily approve
 * it. Every real filesystem write must go through this function.
 */
export async function resolveWithinRootReal(
  root: string,
  segments: readonly string[],
): Promise<string> {
  const lexical = resolveWithinRoot(root, segments);
  const realRoot = await realpath(resolve(root));
  const realCandidate = await deepestExistingRealPath(lexical);

  if (realCandidate !== realRoot && !realCandidate.startsWith(realRoot + sep)) {
    throw new UntrustedPathError('resolved outside the approved output root after link resolution');
  }
  return lexical;
}
