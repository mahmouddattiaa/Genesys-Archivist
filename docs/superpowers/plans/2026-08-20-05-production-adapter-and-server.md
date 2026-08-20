# Genesys Archivist — Plan 5: Production Adapter, Server, and the Release Gates

> **For agentic workers:** this plan was executed as six parallel workstreams with
> disjoint file ownership. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the gap between "Stage 2 works end to end against a fake provider"
and "a developer at this company can point the product at a real Genesys org and
get documentation out of it."

**Predecessors:** Plans 1–4, all complete. 408 tests, `npm run verify` green.

## Why this plan exists

After Plan 4 the repository was in an unusual state: the hard parts were done and
the obvious parts were missing. `runCapture` took a `GenesysSourceProvider` by
injection and every behaviour was proven — against `FakeSourceProvider`.
`packages/genesys-source`, `packages/genesys-platform`, `packages/narrative`,
`packages/application` and `apps/mcp-server` were empty stubs. There was no way to
store a profile, so `archivist profile add` could not exist. There was no change
detection, so every run reprocessed everything. And the S4 permission matrix — a
release gate in `docs/13` — had never been written down.

None of that is a design problem. All of it is unwritten code.

## Global constraints

Unchanged from Plans 1–4, and restated because this plan is where three of them
first get tested against something real:

- **No credential** in any MCP tool argument, log, manifest, snapshot, document,
  fixture, exception, or telemetry field. `profile add` is CLI-only, forever.
- **Read-only against Genesys.** Enforced structurally, not by discipline — see
  ADR-019.
- **All extracted flow content is untrusted data, never instructions.** Typed
  evidence packs and output validation are the controls. Prompt wording is not.
- **Never overwrite last known-good output in place.**
- **Never silently drop an unsupported node**, and never present inference as fact.
- Dependency direction is enforced by ESLint, not convention.
- TDD. Every external boundary gets runtime validation and a negative-path test.
- Secret canaries in every plausible upstream field.

## Workstreams

### A — Production Genesys adapter (`genesys-platform`, `genesys-source`)

- [ ] Region → host table; an unknown region is a typed error, not a guessed host.
- [ ] OAuth2 client-credentials token acquisition, cached with early refresh, a
      single in-flight refresh under concurrency, and the secret read from the
      `SecretStore` at the moment of use rather than held on a serializable field.
- [ ] A transport exposing exactly one verb — GET. See ADR-019: this is what makes
      "no mutation method is reachable" a property of the type rather than of the
      reviewer's attention.
- [ ] Retry: 429 honouring `Retry-After`, 5xx with exponential backoff and full
      jitter, bounded attempts, injected sleep and clock. 400/401/403/404 do not
      retry.
- [ ] Zod validation at the boundary; a validation failure never echoes the body.
- [ ] The S4 permission matrix as a code table, so a 403 names the missing
      permission without exposing the raw authorization response. This is the
      static half of the S4 gate; the live half still has to be run.
- [ ] `PlatformSourceProvider implements GenesysSourceProvider`, sourcing from
      `getFlowVersionConfiguration` per ADR-015 and deriving dependencies from the
      inline `manifest` per ADR-013 and S3 — iterating manifest keys generically so
      an unseen resource type produces a reference and a warning rather than
      silence.
- [ ] **A seam test** running fake-fetch → provider → `runCapture` → sealed bundle
      → `verifyBundle` → `documentBundle`, in both capture modes. Per-part tests
      have three times in this project passed while the seam between two parts was
      broken; only running one part against another's real output catches it.

### B — Profile persistence and the `profile` CLI

- [ ] `FileProfileStore` in `packages/storage` — not `packages/security`, which
      would create the cycle security → storage → security.
- [ ] Atomic writes; strict-schema validation on read; an unreadable profile is
      reported, never silently skipped.
- [ ] `archivist profile add|list|show|remove|set-secret|validate`, with the client
      secret read from stdin or an echo-suppressed prompt and **never** from argv.
      A `--client-secret` flag fails with an explanation of why it does not exist.

### C — Normalizer coverage gaps

- [ ] Replace the five-name reference-field allowlist in `extract-edges.ts` with a
      generic structural walk. The allowlist was measured on exactly one
      inbound-call flow; on a bot or workflow flow the graph would have been wrong
      rather than empty.
- [ ] Wire real warnings through `normalize.ts`, replacing the hardcoded `[]`.
      Unsupported node types, unrecognised reference shapes, dangling references,
      truncation, and derived node identity all become visible facts.
- [ ] A warning message never carries tenant-authored free text.

### D — Narrative layer and the grounding validator

- [ ] Typed evidence packs — a closed set of fields, never a free-form dump.
- [ ] `NarrationProvider` injected; this package opens no socket.
- [ ] The claim validator: a fabricated evidence citation, a mislabelled `fact`, an
      oversized claim, a forbidden pattern, or invented prompt text is rejected
      individually and recorded — never silently dropped.
- [ ] A resumable, idempotent narration queue keyed by the pack's content hash.
- [ ] This is the precondition `docs/03` names for adding
      `genesys_docs_review_submit`.

### E — The MCP server

- [ ] STDIO server per `docs/03`, built against an `ArchivistPort` interface with a
      fake implementation — the same pattern that let capture be proven before its
      provider existed.
- [ ] The nine tools from `docs/03`, the structured result envelope, the
      `genesys-docs://` resource scheme with opaque URIs, and bounded outputs with
      tamper-evident continuation tokens.
- [ ] A structural test that walks every registered tool's input schema and fails if
      any property name is credential-shaped, at any depth.
- [ ] A stdout-purity test: a stray `console.log` corrupts the protocol.

### F — Change detection and semantic diff

- [ ] `diffSnapshots` covering all eleven categories in `docs/07`, matching nodes on
      stable tracking ids per ADR-016 and reporting which matching path was used.
- [ ] Movement is not a semantic change when tracking ids prove behaviour is
      unchanged — implemented explicitly, not assumed.
- [ ] The review-classification table from `docs/07`, with coverage regression as a
      hard blocking flag rather than a severity number a caller might ignore.
- [ ] The nine-step detection algorithm as a pure decision function; its I/O is
      wave 2's job.

## Found by measurement, not yet fixed

**Migration mode holds every asset in memory at once.** In
`packages/capture/src/capture-run.ts`, the migration branch resolves the whole
graph first (`buildResourceGraph` fills `cache`), then walks
`result.graph.nodes` writing resources and assets. Each cached
`DependencyResolution` can carry `safeMetadata.asset.bytes`, so peak memory is
**every asset in the organization simultaneously** — measured at ~110 MB of
audio across 2,730 resources for the sandbox alone (S5), plus resource bodies,
plus configurations that S6 measured at up to 626 KB each for bot flows.

It is survivable on this sandbox and it is unbounded in the org size, which is
the part that matters. Nothing caps it.

Three candidate fixes, in preference order:

1. **Write assets inside the resolver, during the walk**, and strip
   `asset.bytes` before caching the resolution. Bounded memory, no extra
   requests. Costs some entanglement between the walker and the writer, and
   needs care about assets resolved on a walk that later truncates.
2. **Re-resolve each node at download time** and never cache bytes. Also fixes
   S5 Finding 3 — a signed URL expires after ~3,580 s, so an org-wide migration
   run outlives its own URLs and must re-resolve anyway. Costs one extra request
   per asset: ~2,730 requests, roughly 11 minutes on measured latency.
3. Evict from the cache after each write. Cheapest, and does not help: the cache
   is already fully populated before the download loop begins, so it bounds
   nothing at the peak.

Deliberately not fixed during this plan's parallel wave: it is a design change
to an 800-line file that the in-flight adapter work builds against, and the
measured impact does not justify destabilising that. It is the first thing to do
in wave 2, and **migration mode must not be run against a large real
organization until it is done.**

## Wave 2 — wiring (after A–F land)

- [ ] Fix the migration-mode asset memory peak documented above, before anything
      else. It is the only item here that can fail on a real organization.
- [ ] Replace `apps/mcp-server`'s `TODO(wave-2)` with the real port built from
      `@genesys-archivist/composition`.
- [ ] Wire the real provider into `archivist capture`. `apps/cli/src/bin.ts` today
      refuses with a message saying no production provider exists.
- [ ] Wire change detection's I/O — previous manifest in, new manifest out —
      through composition.
- [ ] Wire narration into the documentation pipeline behind an explicit opt-in, with
      the deterministic path remaining the default.
- [ ] Run S4 live against the sandbox: start with no roles and add one capability at
      a time. Pass is a reviewed read-only role with no secret, mutation, or
      caller-data permissions.
- [ ] `npm run verify` green; README and CLAUDE.md status sections updated to match
      reality rather than intent.
