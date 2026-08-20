// packages/genesys-platform/src/fetch-like.ts
//
// The transport is injected everywhere in this package: no file here calls
// the global `fetch` directly, and no test in this package's suite may open
// a socket. `FetchLike` matches the subset of the global `fetch` signature
// this package actually uses (a URL string and an options bag; a `Response`
// back), so `globalThis.fetch` satisfies it with no wrapper needed in
// production while a test can substitute a hand-written fake with the same
// shape.

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Injected in place of `setTimeout`-based sleeping so retry/backoff tests
 * run instantly and deterministically instead of actually waiting. */
export type SleepLike = (ms: number) => Promise<void>;
