# S1 — Source fidelity and the source-path decision

```text
Spike:        S1 — can a source path load and represent a full published flow
              with read-only permissions, at acceptable structural fidelity?
Decision:     PASS at 100% structural fidelity. The Platform API configuration
              endpoint is the source. The Architect Scripting SDK is not needed.
Date:         2026-08-20
Environment:  purecloud-platform-client-v2, Node v22.15.0, region eu_west_1
Target:       flow b97e0e67… "Customer Care IVR By Claude" v4.0 (INBOUNDCALL)
Baseline:     manual Architect UI YAML export of the same version
Result:       GO
```

## Result

`getFlowVersionConfiguration(flowId, '4.0')` was compared against a manual Architect UI YAML export of the same flow version.

| JSON `__type`             |   YAML |   JSON |                 |
| ------------------------- | -----: | -----: | --------------- |
| `PlayAudioAction`         |     10 |     10 | match           |
| `TransferMenuAction`      |     10 |     10 | match           |
| `Task`                    |      7 |      7 | match           |
| `TransferTaskAction`      |      6 |      6 | match           |
| `TransferPureMatchAction` |      4 |      4 | match           |
| `DecisionAction`          |      3 |      3 | match           |
| `Menu`                    |      3 |      3 | match           |
| `MenuAction`              |      2 |      2 | match           |
| `DataAction`              |      1 |      1 | match           |
| `DisconnectAction`        |      1 |      1 | match           |
| **TOTAL**                 | **47** | **47** | **10/10 types** |

**Zero unexplained differences.** `docs/13` requires that "every unsupported or opaque object is visible" and that coverage meets an approved threshold. Coverage here is complete.

### The construct mapping, derived empirically

| YAML construct                       | JSON `__type`               |
| ------------------------------------ | --------------------------- |
| `playAudio`                          | `PlayAudioAction`           |
| `jumpToMenu`, `menuJumpToMenu`       | `TransferMenuAction`        |
| `task`                               | `Task`                      |
| `menuJumpToTask`                     | `TransferTaskAction`        |
| `menuTransferToAcd`, `transferToAcd` | `TransferPureMatchAction`   |
| `decision`                           | `DecisionAction`            |
| `menu`                               | `Menu`                      |
| `menuSubMenu`                        | `Menu` **and** `MenuAction` |
| `disconnect`                         | `DisconnectAction`          |
| `callData`                           | `DataAction`                |

`menuSubMenu` producing two JSON objects is the only non-trivial correspondence: a sub-menu is both a container and an entry point. This table is evidence from one flow, not a specification — it must be re-derived as more flow types are added.

## Finding 1 — every node carries a stable ID, and S3's open question is answered

```text
nodes with trackingId   47
trackingId range        10 .. 56
nextTrackingNumber      57
duplicates              0

by container path
   25  flowSequenceItemList[].actionList[]
   12  flowSequenceItemList[].menuChoiceList[].action
   10  flowSequenceItemList[]
```

Every node in the flow carries a `trackingId`. They are unique, and `nextTrackingNumber` exceeds every assigned value, so the allocator is monotonic — an ID is not reused when a node is deleted.

**This reverses the earlier finding in `S1-yaml-structure-findings.md`.** That document observed only ten `refId` values in the YAML, concluded identity fell through to `deriveNodeId` for the large majority of nodes, and called derived identity "load-bearing."

That conclusion was an artefact of the export, not of Architect. The YAML carries **10** identifiers against the JSON's **47** because it was taken **without "include tracking IDs" enabled**. Sourcing from the configuration endpoint, every node has a stable identifier.

Consequence for the domain model: `deriveNodeId` moves from primary identity path to **fallback**, used only where a `trackingId` is genuinely absent. `docs/04`'s preference chain — tracking ID, then stable source ID, then derived — was correct as written; only the expected frequency of the third case was wrong. `deriveNodeId` stays, with its property tests, because a fallback that is never exercised in one flow may be exercised in another.

## Finding 2 — the Architect Scripting SDK is not required

`docs/02` and the README both assume the Architect Scripting SDK is the preferred full-source path, with `loadAsync`, `traverse`, and `exportToObjectAsync`. It was the least-verified assumption in the entire design: never confirmed to exist in a usable Node form, and the heaviest dependency of the four candidates.

It is unnecessary. The Platform API configuration endpoint delivers:

- 100% structural fidelity against the UI export baseline
- a stable `trackingId` on every node
- a `manifest` of every referenced resource with stable IDs and node-level provenance (spike S3)
- exact version pinning
- all of it read-only, through the official Platform SDK that is already a dependency

Adding a second SDK to obtain a strict subset of that would be cost with no benefit. The four-candidate comparison resolves to:

| Path                                           | Verdict                                                                                                  |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **Platform API `getFlowVersionConfiguration`** | **Primary source.** Complete, identified, versioned, read-only                                           |
| Architect YAML export                          | **Migration payload only.** Retained in the bundle because a migration tool needs an importable artifact |
| Architect Scripting SDK                        | **Dropped.** Supplies nothing the Platform API does not, at a much higher dependency cost                |
| Manual YAML ingestion                          | **Degraded-mode fallback** for organizations that do not permit OAuth automation                         |

Recorded as ADR-015.

## Finding 3 — the comparison method needed care, which is itself the lesson

The first run of this comparison reported every type as differing by exactly 2×, with `DataAction` and `DisconnectAction` at 3×. That was a defect in the comparison harness, not a fidelity gap: it counted each action once as a YAML list item and again as an object property, and additionally counted `settingsActionDefaults.callData` and `settingsErrorHandling…disconnect`, which are default-settings blocks rather than actions in the flow.

Worth recording because the production normalizer faces exactly the same trap. Architect YAML reuses action names as settings keys, so a normalizer that walks by key name rather than by structural position will invent nodes that do not exist. Actions appear **only** as single-key list items. A test fixture covering `settingsActionDefaults` belongs in the normalizer's suite.

## Permissions observed

Read-only throughout, using the existing OAuth client. No mutation method was called. Calls exercised: `getFlow`, `getFlowVersionConfiguration`, `getFlowLatestconfiguration`.

## Kill criteria

| #   | Criterion                                                   | Status                                                                        |
| --- | ----------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 1   | Representative flows cannot be loaded or exported read-only | **not met** — they can                                                        |
| 2   | Coverage below the approved structural threshold            | **not met** — 100%                                                            |
| 3   | Essential path requires undocumented internal endpoints     | **not met** — documented Platform API only                                    |
| 12  | No source path produces Archy-importable YAML               | still open; the UI/Archy export path exists but round-trip import is untested |

## Changes required

| Change                                                                  | Where                                                             |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Drop the Architect Scripting SDK from the design and dependency set     | `docs/02`, README, design spec §5.1, ADR-015                      |
| `deriveNodeId` is a fallback, not the primary identity path             | Design spec §6.1, `packages/normalization`                        |
| Normalizer must count actions by structural position, never by key name | `packages/normalization`, with a `settingsActionDefaults` fixture |
| Construct mapping table re-derived per flow type as coverage widens     | `packages/normalization`                                          |

## What S1 does not settle

One flow, of one type. `INBOUNDCALL` is the most common type but not the most complex; bot, digital bot, in-queue, and workflow types are unexamined, and this flow contains no reusable-task invocation, no schedule, no data table, and no recorded prompt. The construct mapping above will grow, and the 100% figure is a result for this corpus rather than a guarantee.
