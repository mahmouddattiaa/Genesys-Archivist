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

### What callers hear, step by step

- "Alpha india lima" plays "Alpha mike lima juliet november lima" -- recorded inline in this step's own configuration, not a prompt-library asset[e5][e6].
- "Bravo delta" plays "Bravo mike foxtrot mike bravo golf" -- recorded inline in this step's own configuration, not a prompt-library asset[e7][e8].
- "Foxtrot golf" plays "Echo echo lima juliet november hotel" -- recorded inline in this step's own configuration, not a prompt-library asset[e9][e10].
- "Golf golf lima" plays "Lima oscar foxtrot india mike papa" -- recorded inline in this step's own configuration, not a prompt-library asset[e11][e12].
- "Hotel foxtrot papa" plays "Papa alpha golf kilo india india" -- recorded inline in this step's own configuration, not a prompt-library asset[e13][e14].
- "India echo" plays "Lima india oscar india hotel kilo" -- recorded inline in this step's own configuration, not a prompt-library asset[e15][e16].
- "Juliet kilo alpha" plays "Hotel kilo lima juliet foxtrot golf" -- recorded inline in this step's own configuration, not a prompt-library asset[e17][e18].
- "Juliet kilo echo" plays "Alpha oscar india alpha golf oscar" "India lima india papa mike charlie" (part of what plays here is filled in from a variable at runtime and is not shown) -- recorded inline in this step's own configuration, not a prompt-library asset[e19][e20].
- "Juliet mike papa" plays "Bravo alpha alpha kilo juliet mike" -- recorded inline in this step's own configuration, not a prompt-library asset[e21][e22].
- "Lima golf juliet" plays "Golf juliet kilo hotel bravo alpha" -- recorded inline in this step's own configuration, not a prompt-library asset[e23][e24].
- "Lima oscar" plays "Oscar kilo delta kilo echo echo" -- recorded inline in this step's own configuration, not a prompt-library asset[e25][e26].
- "Mike foxtrot" plays "India delta delta delta echo charlie" -- recorded inline in this step's own configuration, not a prompt-library asset[e27][e28].
- "November papa papa" plays "Juliet juliet bravo bravo mike mike" -- recorded inline in this step's own configuration, not a prompt-library asset[e29][e30].

## 5. Business rules

This flow contains 3 decision points that branch the caller down different paths, and 14 of the caller journeys extracted above return to an earlier menu rather than proceeding — the structural shape of a retry or "let me try again" pattern. Architect captures that these branches and returns exist; it does not capture the business criteria (eligibility rules, VIP handling, promotional offers) that a decision is meant to enforce, and this document does not guess at them.

No schedule, business-hours, or emergency-group dependency was found in this capture. If time-of-day or holiday behaviour governs this flow at the platform level, it is not recorded in this snapshot.

## 6. External services and dependencies

This flow relies on the following external services and shared resources. Only their type, name, and whether they resolved during capture are shown here — no connection details or credentials.

| Type         | Name                                   | Status   | Evidence |
| ------------ | -------------------------------------- | -------- | -------- |
| dataAction   | Bravo golf delta lima november charlie | resolved | [e31]    |
| language     | en-US                                  | resolved | [e1]     |
| queue        | Delta                                  | resolved | [e4]     |
| systemPrompt | Hotel                                  | resolved | [e32]    |
| ttsEngine    | Bravo alpha                            | resolved | [e33]    |
| ttsVoice     | Echo                                   | resolved | [e34]    |

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

| Mark  | Evidence ID                                                             |
| ----- | ----------------------------------------------------------------------- |
| [e1]  | sha256:1a103e54a89c3ea552cfe6e07c8807fb85675219dff1b66c5c490752d8d03a8f |
| [e2]  | sha256:c66688380fbbfbdc94d97fc1618568f286a4fed2816f298ad8f1b67ff4b7280d |
| [e3]  | sha256:f79426995a93a623914ee950995570b04325f402c68148a01e462528c0e9a1f1 |
| [e4]  | sha256:28baef4f9419dd816d451303568a353b0d3b06ef0db7a48e19c91c624849a9ff |
| [e5]  | sha256:91e422bbca93d4f9fc310285e1bbb732021fb4f248afd5813baf5ddeeff5837a |
| [e6]  | sha256:b9fee45d0e4601926fa817b8fd400bb7ffbcfa48bf0bbcac17d8b3b6b80398a7 |
| [e7]  | sha256:325f5f47720e89e9928071456b755f75e0fb88118c4af9124d80ee495b324df3 |
| [e8]  | sha256:da7e4ff65f3b6097c550fba1774924ccae519f942093c40768e47a54e704bbff |
| [e9]  | sha256:0eea8f3cad9c68938ebcaead329e09f5407b1feaa10352f1423352bbc22bd608 |
| [e10] | sha256:4289235a2892110d3a2e7d3beb8ca71ffc00d27f144237dd774634711fe15ba7 |
| [e11] | sha256:9740d1b19116a45c951e2d2482e76f63d77208e19d495909d3f4473430aa60d2 |
| [e12] | sha256:a81c38a5bd3b3fbd5fc57cfc9ac72b06d424e32640a7cbecd2d2b0cd10dda3c9 |
| [e13] | sha256:d0e8e1b2707c1c80682f2c917c20dbffc94a41b7fcea6c07e0faf585f53b6f08 |
| [e14] | sha256:ed0681ec32adc292db3c042b50a30948899ea5def1967ababb385211cb03d620 |
| [e15] | sha256:05f2b15975a3637a1102013d160bee9dd7ce57b5b59f322e6b4b5c708845aba4 |
| [e16] | sha256:a6dd3804190760e642f1f346e42a0b8fc795989a6fcfb2bd6008371e2a32bd1a |
| [e17] | sha256:69d358fbe7c0f705a359705d962ea338a193c760b13c8eb30d8c1f16d30a69a1 |
| [e18] | sha256:d6e526e8764924c78cb3fa2dfd4ba56e7b0cbf810ecb76dcd3119d0f4393c48a |
| [e19] | sha256:d1192351b33181e854ee64feade14cc8b83dfd9dea871aa5d0750944bd968f84 |
| [e20] | sha256:e0f97013302d2206e6f1fb5f81e8dc27977c7fbc32b2c567aaa9bbd2d5f6eed3 |
| [e21] | sha256:8d748819cc72e945a78822d6cbe75b06632efdac3bc30aac7152e1dbdfdfb033 |
| [e22] | sha256:c626e65ff801dcd0a78806c5fc187dff9bfdc5dc5658f042165468b364d8074b |
| [e23] | sha256:237cce33e5b6f038dc61883fe911b71d12a21c8bcad9f6faec80f7cbb1d02824 |
| [e24] | sha256:2fd6ba0a2c2fd46e8734624779a04ee59f8a9376f5200a9f90f166b361ac4995 |
| [e25] | sha256:554afd76c79065415ce3a8da4d563418f9a33afe1a3861efb51f96a23b1f7b95 |
| [e26] | sha256:60130b77f0193db153cbe4469c0f6a943e314610ea0ea67a6f5bcb03018bb212 |
| [e27] | sha256:8a4fc10c0b309722c90324f839b055afc3570bf8a359808da780a6303e5001fc |
| [e28] | sha256:f7eb248cffae59cdee45fa1a331ea5196bbff344fa54f1e6a46490b837c5640f |
| [e29] | sha256:512dc2ec0f1cc3ec86d8274d316501033ff8cc3997da7ac1798009878428794e |
| [e30] | sha256:c45171af68f815ce1995bdf8e6220b6d03b3c56929e30e5800b18bc3c751378c |
| [e31] | sha256:04fab4a6f9019e08988a62b8647de81d2953da6b95c5092ee16a54bf5109ecd2 |
| [e32] | sha256:301106b9a9978dcd05df0a3584be3ce128dc4a6fc0d3d0ac3b9a53aa1a9c7bed |
| [e33] | sha256:90940efb1f638080bb22fb20435fcabdac057cccc762a2c9655533ad030ded29 |
| [e34] | sha256:846f034f1ad96f267558c5015d30cdd1fd3751d86ff9913be4fcf7ac1de23d48 |

This document has not yet been reviewed by a human. Review status: `generated`.
