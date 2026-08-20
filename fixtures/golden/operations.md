# Operations Documentation: Fixture Flow

47 configured steps, 55 connections between them.

## 1. Document status

| Field             | Value                    |
| ----------------- | ------------------------ |
| Flow name         | Fixture Flow             |
| Flow type         | inboundcall              |
| Published version | 4.0 (published)          |
| Snapshot ID       | f1@4.0                   |
| Source            | platform-api (eu_west_1) |
| Generated         | 2026-08-20T00:00:00Z     |

This is the on-call reference for this flow: what it depends on, what breaks if a dependency is retired, and where the gaps in this capture are. Node ids are shown throughout so a claim here can be traced straight back to the flow definition.

## 2. Inbound routes

This is a single-flow snapshot. The DIDs, phone routes, or other inbound triggers that reach this flow are **not recorded here** — they are captured, if at all, in the organization-wide resource inventory (`resources/dids.md`), not in a per-flow capture. Consult that inventory, if one exists for this organization, to find what actually routes a caller to this flow.

## 3. Dependencies and resolution status

This flow declares 6 dependencies. Every one of them, its resolution status at capture time, and how many nodes in this flow reference it, are listed below.

| Node ID                                       | Type         | Name                                   | Status   | Referenced by | Evidence |
| --------------------------------------------- | ------------ | -------------------------------------- | -------- | ------------- | -------- |
| custom_-_c7f7325f-22d7-41b1-af5f-e5ded889e829 | dataAction   | Bravo golf delta lima november charlie | resolved | 1 node        | [e1]     |
| en-US                                         | language     | en-US                                  | resolved | 0 nodes       | [e2]     |
| 0bb9f560-3d4c-4d20-a4ac-9e8a1df5e726          | queue        | Delta                                  | resolved | 4 nodes       | [e3]     |
| Echo                                          | systemPrompt | Hotel                                  | resolved | 0 nodes       | [e4]     |
| Charlie                                       | ttsEngine    | Bravo alpha                            | resolved | 0 nodes       | [e5]     |
| Lima                                          | ttsVoice     | Echo                                   | resolved | 0 nodes       | [e6]     |

All dependencies resolved at capture time.

## 4. Flows that depend on this flow

This is a single-flow snapshot, so it has no visibility into other flows in the organization. Whether another flow transfers into this one, or reuses one of its tasks, is **not determined** from this capture alone — that question can only be answered from the organization-wide resource inventory (`resources/inventory.md`), which cross-references every captured flow against every resource.

## 5. Blast radius

If a dependency listed below is retired, disabled, or reconfigured incompatibly, every node that references it stops being able to do what it was configured to do. This section exists to answer exactly that question without having to search the flow definition by hand.

### dataAction: Bravo golf delta lima november charlie (`custom_-_c7f7325f-22d7-41b1-af5f-e5ded889e829`)

Retiring this dependency would directly break 1 node:

- `trk_56` (DataAction "India mike india")

### queue: Delta (`0bb9f560-3d4c-4d20-a4ac-9e8a1df5e726`)

Retiring this dependency would directly break 4 nodes:

- `trk_23` (TransferPureMatchAction "November juliet charlie")
- `trk_24` (TransferPureMatchAction "Bravo hotel")
- `trk_31` (TransferPureMatchAction "Kilo india alpha")
- `trk_43` (TransferPureMatchAction "Alpha oscar november")

## 6. Failure-path summary

Of the caller journeys extracted from this flow, 1 ends in a disconnect, 0 reach a node with no configured next step (a dead end), and 0 were cut off by the analysis's own depth limit rather than a real terminal in the flow.

This capture does **not** distinguish no-input, no-match, or timeout branches from ordinary sequential edges — Architect's platform-level error-handling configuration is not represented in the graph this document was generated from, so those failure paths cannot be enumerated here.

Data-action failure handling:

- `trk_56` ("India mike india") has 1 outgoing edge recorded, with no distinct success/failure branch captured. If this data action fails at runtime, this document cannot say what happens next.

## 7. Schedule and emergency-group behaviour

No schedule, business-hours, or emergency-group dependency was found in this capture. If this flow's routing changes with time of day, holidays, or an emergency override, that behaviour is configured at the platform level and is **not captured** in this snapshot — check the organization schedule groups directly.

## 8. Known coverage gaps and unresolved references

- This is a single-flow snapshot: inbound DIDs, other flows that depend on this one, and schedule/emergency-group behaviour are all out of scope for this document (see sections 2, 4, and 7) even though they are real operational facts about this flow in production.

## 9. Evidence marks

Every `[eN]` mark cited above resolves to exactly one full evidence id below; the full snapshot carries the rest, including facts this document did not need to state.

| Mark | Evidence ID                                                             |
| ---- | ----------------------------------------------------------------------- |
| [e1] | sha256:04fab4a6f9019e08988a62b8647de81d2953da6b95c5092ee16a54bf5109ecd2 |
| [e2] | sha256:1a103e54a89c3ea552cfe6e07c8807fb85675219dff1b66c5c490752d8d03a8f |
| [e3] | sha256:28baef4f9419dd816d451303568a353b0d3b06ef0db7a48e19c91c624849a9ff |
| [e4] | sha256:301106b9a9978dcd05df0a3584be3ce128dc4a6fc0d3d0ac3b9a53aa1a9c7bed |
| [e5] | sha256:90940efb1f638080bb22fb20435fcabdac057cccc762a2c9655533ad030ded29 |
| [e6] | sha256:846f034f1ad96f267558c5015d30cdd1fd3751d86ff9913be4fcf7ac1de23d48 |
