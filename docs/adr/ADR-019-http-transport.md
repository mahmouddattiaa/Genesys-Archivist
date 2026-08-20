# ADR-019: `fetch`-based HTTP transport, not `purecloud-platform-client-v2`

Date: 2026-08-20
Status: accepted
Deciders: Abdurrahman (IST)

## Context

`packages/genesys-platform` and `packages/genesys-source` are the production Genesys Cloud
adapter -- the only code in this repository that talks to Genesys. AGENTS.md's second
non-negotiable boundary is that no mutation method may be _reachable_ from a production adapter,
and Phase 0's spikes gave that boundary a name: `postArchitectDependencytrackingBuild`, the one
mutation AGENTS.md calls out explicitly, sits on `ArchitectApi` next to `getArchitectIvr`,
`deleteArchitectIvr`, and `putArchitectIvr` in the pinned `purecloud-platform-client-v2` SDK (S2
Finding 4). The SDK does not separate reads from writes at the class level; it separates them only
by which method name a developer happens to call.

## Options considered

**Import the SDK and call only its `get*` methods.** The obvious choice, and the one the repo's
own spike scripts (`scripts/spike/*.mjs`) use, because throwaway probe code is exactly where
"discipline, not structure" is an acceptable trade. A production adapter is not throwaway code.
Every class the adapter would import -- `ArchitectApi`, `FlowsApi`, `IntegrationsApi`,
`RoutingApi` -- exposes hundreds of POST/PUT/DELETE methods on the same object as the handful of
GET methods this repository needs. "Read-only" would then be a promise about which methods nobody
calls, enforced by code review and habit, on a surface large enough that a habit is not a control.

**Wrap the SDK behind a read-only facade.** Narrows the _exposed_ surface to GET-shaped methods,
but the mutation methods still exist one property access away on the same client instance, and
every new endpoint this adapter needs means hand-verifying, again, that the facade only ever calls
the SDK's `get*` methods and never accidentally reaches for a same-named sibling.

**Use the global `fetch` (Node 22 ships it) and define exactly one verb.** `PlatformApiClient`
exposes `get<T>` and `getBinary`, and both issue nothing but `GET`. There is no code path in this
package that can construct a `POST`, `PUT`, `PATCH`, or `DELETE` request, because no such code
exists to reach -- not "is not called," but "was never written." A test that asserts the injected
`fetch` is never invoked with a non-GET method across the entire suite is checking a fact about
the type surface, not auditing call-site discipline.

## Decision

Build the transport on the global `fetch`, injected as `FetchLike` so every test in this package's
suite runs with no network. Every REST path, query parameter name, and response shape in
`packages/genesys-platform/src/endpoints.ts` is read out of the pinned SDK's source under
`node_modules/purecloud-platform-client-v2/src` -- per AGENTS.md, "read its source... but do not
import it" -- so this adapter is grounded in the same ground truth the SDK-based option would have
used, without inheriting its reachable mutation surface.

## Consequences

- **The read-only guarantee is structural, and it holds independently of which credential this
  adapter runs under.** `docs/spikes/S4-permission-matrix.md` measured the sandbox OAuth client
  used for Phase 0 spikes holding 580 mutating permission grants -- including
  `architect:flow: publish, delete` and, by name, `architect:dependencyTracking: rebuild`
  (`postArchitectDependencytrackingBuild`). Under an SDK-based transport, that credential would be
  one accidental method call away from publishing or deleting a production IVR, or rebuilding the
  dependency-tracking index ADR-014 exists specifically to avoid depending on. Under this
  transport, none of that is reachable: `PlatformApiClient` has no method that could construct
  anything but a `GET` request, so the credential's actual grants are irrelevant to what this code
  can do. This is precisely the situation S4 found: on an over-privileged tenant, the transport is
  the only read-only guarantee that holds at all.
- Every new endpoint costs a hand-written zod schema instead of an SDK model class. That cost is
  the point: it is also the moment the exact response shape gets checked against ground truth
  (either the SDK source or, better, a real sanitized fixture) rather than assumed.
- `getBinary` follows the same rule for prompt audio: one path, one verb, bytes and content type
  out, nothing else. `docs/spikes/S5-prompt-audio.md`'s finding that signed media URLs need
  _no_ `Authorization` header at all, and must never receive this adapter's own bearer token,
  fits naturally on top of a transport that already treats "which host gets which header" as an
  explicit decision rather than something the SDK's shared `ApiClient` instance handles once for
  every call it makes.
- This repository still depends on `purecloud-platform-client-v2` as a devDependency, purely as a
  documentation source for endpoint shapes (per AGENTS.md) and for the throwaway Phase 0 spike
  scripts. Nothing under `packages/` imports it.

## Rejected

**Wrapping the SDK behind a read-only facade**, for the reason above: the facade narrows what
gets _called_, not what the underlying client _can_ do, and every new endpoint re-opens the
question of whether the facade still only reaches for `get*` methods.
