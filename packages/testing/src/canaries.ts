// packages/testing/src/canaries.ts
/**
 * Unique, greppable strings planted in every field an upstream system could
 * populate. If one of these ever appears in output, a log, an error, a cache,
 * or a fixture, the release is blocked.
 */
export const CANARIES: readonly string[] = [
  'CANARY-CLIENT-SECRET-9f2b71c4',
  'CANARY-ACCESS-TOKEN-3ad0e58f',
  'CANARY-PASSWORD-77c1be92',
  'CANARY-PRIVATE-KEY-0e4fa613',
  'CANARY-HEADER-VALUE-b82d55af',
];

export function scanForCanaries(text: string): readonly string[] {
  return CANARIES.filter((canary) => text.includes(canary));
}
