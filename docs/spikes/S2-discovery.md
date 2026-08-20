# S2 — Discovery completeness

```text
Spike:        S2 — can every flow and version be discovered?
Decision:     PASS. Discovery is complete and read-only, with one design change required.
Date:         2026-08-20
Environment:  purecloud-platform-client-v2, Node v22.15.0, region eu_west_1
Organization: BFSI-MajorelX (sandbox)
Result:       GO
```

Because the probe runs on the official SDK rather than hand-rolled HTTP, this also clears the core of **S0**: the SDK installs, maps regions, authenticates with the client credentials grant, and pages correctly.

## Result

| Check                                       | Outcome                  |
| ------------------------------------------- | ------------------------ |
| Client credentials authentication           | ✓                        |
| Region resolved from `PureCloudRegionHosts` | ✓ `eu_west_1`            |
| Organization identity                       | ✓ `eca30c9c-…`           |
| Tenant binding enforced                     | ✓ armed and verified     |
| Divisions enumerated                        | ✓ 6                      |
| Flows discovered                            | ✓ **511** across 6 pages |
| Same-named flows across divisions           | ✓ **0**                  |
| IVR configurations                          | ✓ 60, mapping 20 DIDs    |
| Target IVR resolved to its flow             | ✓                        |
| Mutation permission required                | none                     |

## Finding 1 — never enumerate by a hardcoded flow-type list

The probe originally iterated a local list of fourteen Architect flow types. Cross-checking against an unfiltered walk:

| Method                                | Flows found |
| ------------------------------------- | ----------: |
| Iterating the local 14-type list      |         491 |
| Unfiltered walk, server reports types |     **511** |

**Twenty flows were silently missed.** Five types exist that the list did not contain:

| Type                  | Flows |
| --------------------- | ----: |
| `inqueueshortmessage` |    14 |
| `inqueueemail`        |     2 |
| `surveyinvite`        |     2 |
| `workitem`            |     1 |
| `voicemail`           |     1 |

Worse, `survey` — which the list _did_ contain — is not a valid filter value at all and returns HTTP 400. A list can be both incomplete and wrong at the same time.

This is the **false completeness** failure mode in the `docs/08` FMEA, arriving from a direction the FMEA did not anticipate. That row assumes division permissions hide flows. Here nothing was hidden: the tool simply never asked for types it did not know existed, and would have reported "491 flows, discovery complete" with total confidence.

**Design rule, now non-negotiable:** discovery walks flows **unfiltered** and treats the server as the authority on which types exist. A local type list may only ever be a cross-check that logs drift — never the enumeration itself. This is exactly the discipline `docs/15` already demands for endpoints, extended to enum values.

The seventeen types actually present:

```text
inboundcall 162   inboundshortmessage 88   digitalbot 83   bot 59
outboundcall 29   workflow 18   inqueuecall 17   inboundemail 16
inqueueshortmessage 14   securecall 11   voicesurvey 3   inboundchat 3
inqueueemail 2   commonmodule 2   surveyinvite 2   workitem 1   voicemail 1
```

`FlowSnapshot.flow.type` is already an open string rather than an enum, so no schema change is needed. That decision now looks correct rather than merely cautious.

## Finding 2 — organization scale is 511 flows, not a small pilot

The open question in `docs/14` recorded organization size as "varies / don't know," and the design was told to assume the large case. It was right to.

511 flows in a **sandbox**. Consequences:

- `docs/01` proposes bounded extraction concurrency "initially two flows until rate behaviour is measured." At two concurrent flows, a full capture is a long-running job measured in tens of minutes at best — and that is before per-flow definition fetches, the resource walk, and asset downloads.
- Resumability is not a nicety at this scale. A run that cannot resume will be restarted from scratch by an impatient operator.
- Per-flow latency is now the single most important number S1 and S6 must measure, because it multiplies by 511.
- The agent-driven narration work queue in the design was sized for "hundreds of flows." That was the right call.

## Finding 3 — the name-to-ID join is unambiguous here, but that is not proof

Zero same-named flows across six divisions and 511 flows.

This is good news for the join that `S1-yaml-structure-findings.md` identified as the riskiest part of the design — Architect YAML references every resource by display name, so a collision is where a name-to-ID join could silently mis-resolve.

But one organization with zero collisions does not establish that collisions cannot occur; `docs/02` explicitly requires same-name flows in different divisions to remain distinct, which implies Genesys permits them. The scoping rule still has to be designed and tested. The check stays in the probe permanently so any organization that does collide is caught before capture, not after.

## Finding 4 — the target route resolves

```text
IVR config 5ffacb01-3ae5-49e9-8e54-58d4f32c76f7
  openHours → flow b97e0e67-65fd-4d9a-a899-da5f24e702ba
```

That flow ID is what S1 needs a manual Architect YAML export of, with tracking IDs enabled.

Also of note: 60 IVR configurations map only 20 DIDs, so two thirds carry no inbound number. Whether those are drafts, decommissioned routes, or configured through another mechanism is a question for `operations.md` to surface rather than something the tool should assume.

## Permissions observed

Everything above succeeded with the existing OAuth client. No mutation permission was required, and no call was made that could alter tenant state. This is a partial input to **S5**; the full minimum-permission matrix still requires starting from zero roles and adding one capability at a time.

One structural caveat carried over from SDK introspection: `ArchitectApi` exposes `getArchitectIvr` alongside `deleteArchitectIvr`, `postArchitectIvrs`, and `putArchitectIvr` on the same class. The SDK does not separate reads from writes, so `AGENTS.md`'s "no mutation method reachable from a production adapter" must be enforced by an allowlist in `packages/genesys-platform`, plus a static check that fails the build if a mutation method name appears there.

## Changes required

| Change                                                                    | Where                                  |
| ------------------------------------------------------------------------- | -------------------------------------- |
| Discovery walks flows unfiltered; a local type list is a cross-check only | Design spec §5.2, Plan 2 capture tasks |
| Concurrency, runtime, and retry budgets sized for ~500 flows              | Design spec §5.6, S6                   |
| Name-collision check retained permanently in discovery                    | `packages/capture`                     |
| Mutation-method allowlist plus a build-failing static check               | `packages/genesys-platform`, new task  |

## What S2 does not settle

Version-level discovery. The probe enumerated flows, not every version of every flow, and `docs/14` asks whether checked-in and working-copy versions must be documented. Nothing here says whether that is possible read-only.
