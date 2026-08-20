# Business Documentation: Fixture Flow

47 configured steps, 55 connections between them.

## 1. Document status

| Field             | Value                                   |
| ----------------- | --------------------------------------- |
| Flow name         | Fixture Flow                            |
| Flow type         | inboundcall                             |
| Published version | 4.0 (published)                         |
| Snapshot ID       | f1@4.0                                  |
| Source            | platform-api (eu_west_1)                |
| Generated         | 2026-08-20T00:00:00Z                    |
| Review state      | generated — not yet reviewed by a human |

This document is the deterministic layer: every statement below is drawn directly from the captured configuration and the analysis run over it. It contains no inferred business intent — where the configuration does not record why something exists, this document says so plainly rather than guessing.

## 2. Purpose

No description, business justification, or ownership metadata was captured for this flow. **The business purpose of this flow is not recorded** in the source configuration, and it cannot be determined from this snapshot alone. Establishing why this flow exists — which product, regulatory obligation, or customer segment it serves — is the job of the narrative layer, which has not run against this capture.

## 3. Supported languages and entry behaviour

No language was declared at flow level.

The capture separately records 1 language resource in use:

- en-US[e1]

Every call into this flow begins at a single starting point, "India juliet"[e2][e3].

## 4. Caller journeys by intent

Walking the flow from its entry point produced 23 representative caller journeys. Each journey runs from 5 to 13 steps before the caller reaches an outcome. This walk is bounded and representative rather than exhaustive: a highly interconnected menu structure like this one has far more possible paths than are useful to enumerate individually.

- 8 journeys end with the caller being transferred.
- 1 journey ends with the call disconnecting.
- 14 journeys return the caller to a point already visited in the menu structure rather than reaching a transfer or disconnect.

**There are exactly four ways out of this IVR**: 3 distinct transfer points and 1 disconnect point. Every other point in the flow either leads to one of these, or leads a caller back into the menu structure.

All 3 transfer points hand the caller to the same destination: the "Delta" queue[e4].

Beyond these outcomes, this flow's menu structure is deeply interconnected: 35 of its 47 configured steps can each reach one another. A caller who takes a wrong turn can typically find a way to nearly any other point in the menu rather than being stuck in a dead end.

The menu choices available to a caller, by menu, are:

- "India echo": 1: November charlie, 2: Delta india, 3: Alpha echo, 4: Papa echo charlie
- "Lima oscar": 1: Alpha alpha bravo bravo, 2: Delta india juliet
- "November papa papa": 1: Delta juliet, 2: Alpha foxtrot, 3: Lima, 4: Delta alpha, 5: Lima hotel hotel golf, 6: Kilo india kilo

## 5. Business rules

This flow contains 3 decision points that branch the caller down different paths, and 14 of the caller journeys extracted above return to an earlier menu rather than proceeding — the structural shape of a retry or "let me try again" pattern. Architect captures that these branches and returns exist; it does not capture the business criteria (eligibility rules, VIP handling, promotional offers) that a decision is meant to enforce, and this document does not guess at them.

No schedule, business-hours, or emergency-group dependency was found in this capture. If time-of-day or holiday behaviour governs this flow at the platform level, it is not recorded in this snapshot.

## 6. External services and dependencies

This flow relies on the following external services and shared resources. Only their type, name, and whether they resolved during capture are shown here — no connection details or credentials.

| Type         | Name                                   | Status   | Evidence |
| ------------ | -------------------------------------- | -------- | -------- |
| dataAction   | Bravo golf delta lima november charlie | resolved | [e5]     |
| language     | en-US                                  | resolved | [e1]     |
| queue        | Delta                                  | resolved | [e4]     |
| systemPrompt | Hotel                                  | resolved | [e6]     |
| ttsEngine    | Bravo alpha                            | resolved | [e7]     |
| ttsVoice     | Echo                                   | resolved | [e8]     |

## 7. Failure and customer-experience behaviour

1 of the caller journeys extracted above ends in a disconnect. Beyond that outcome, this capture does not distinguish separate no-input, no-match, timeout, or external-service-failure branches from the flow's ordinary next-step edges — Architect's platform-level error handling settings are not represented in this graph, so this document cannot describe how a silent, mistaken, or slow caller is treated differently from one who responds correctly.

This flow calls an external data action. The captured graph records only a single next step after that call; it does not record a distinct success path from a failure path, so what a caller experiences if that call fails is not recorded here.

## 8. Business risks and open questions

2 findings are severe enough to affect caller behaviour:

- Variable "Lima" \(flow scope\) is read but never written anywhere in this flow. Any branch or prompt depending on its value cannot behave as intended.
- Variable "Alpha" \(flow scope\) is read but never written anywhere in this flow. Any branch or prompt depending on its value cannot behave as intended.

Other observations, none of which change caller-facing behaviour on their own:

- 35 node\(s\) form a cycle: the flow can revisit this state, which is normal for a menu or retry.
- Variable "Foxtrot" \(flow scope\) is declared but never read or written.
- Variable "November" \(flow scope\) is declared but never read or written.

This document does not attempt to rank these by business importance, assign an owner, or estimate customer impact — none of that is recorded in the source configuration.

## 9. Changes since the previous documented version

No previous documented version of this flow was supplied for comparison. This is the first documentation generated from this capture.

## 10. Evidence and review notes

This capture recorded 109 evidence records in total. Every factual claim above that cites a mark below resolves to one of them; the full snapshot carries the rest, including facts this document did not need to state.

| Mark | Evidence ID                                                             |
| ---- | ----------------------------------------------------------------------- |
| [e1] | sha256:1a103e54a89c3ea552cfe6e07c8807fb85675219dff1b66c5c490752d8d03a8f |
| [e2] | sha256:c66688380fbbfbdc94d97fc1618568f286a4fed2816f298ad8f1b67ff4b7280d |
| [e3] | sha256:f79426995a93a623914ee950995570b04325f402c68148a01e462528c0e9a1f1 |
| [e4] | sha256:28baef4f9419dd816d451303568a353b0d3b06ef0db7a48e19c91c624849a9ff |
| [e5] | sha256:04fab4a6f9019e08988a62b8647de81d2953da6b95c5092ee16a54bf5109ecd2 |
| [e6] | sha256:301106b9a9978dcd05df0a3584be3ce128dc4a6fc0d3d0ac3b9a53aa1a9c7bed |
| [e7] | sha256:90940efb1f638080bb22fb20435fcabdac057cccc762a2c9655533ad030ded29 |
| [e8] | sha256:846f034f1ad96f267558c5015d30cdd1fd3751d86ff9913be4fcf7ac1de23d48 |

This document has not yet been reviewed by a human. Review status: `generated`.
