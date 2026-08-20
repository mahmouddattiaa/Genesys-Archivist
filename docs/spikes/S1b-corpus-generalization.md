# S1b — Does the structural model generalize?

```text
Spike:        S1b — do the normalizer's structural assumptions hold across
              every Architect flow type, or only for inbound call flows?
Decision:     The two load-bearing assumptions HOLD. The breadth of constructs
              is roughly five times what the reference flow suggested.
Date:         2026-08-20
Environment:  purecloud-platform-client-v2, region eu_west_1
Corpus:       2 published flows sampled per type, 17 types, 511 flows total
Result:       GO, with a revised coverage estimate
```

S1 measured 100% fidelity for **one** inbound call flow of 47 nodes. This asks whether that result generalizes, by sampling every flow type in the organization and checking the assumptions the extractors are built on.

## The two assumptions hold

| Assumption | Verdict |
| --- | --- |
| Every flow uses `flowSequenceItemList` as its container list | ✓ **holds for every sampled flow of every type** |
| Every node carries a `trackingId` | ✓ **holds for every node of every sampled flow** |

This is the important result. The traversal strategy in `extract-nodes` — walk `flowSequenceItemList`, then each container's `actionList` and `menuChoiceList[].action` — and the identity strategy — prefer `trackingId` — are not artefacts of one flow type. They are how Architect represents flows generally.

It also reconfirms **ADR-016** across the whole corpus rather than a single flow: `deriveNodeId` is genuinely a fallback, not the primary path.

## Finding 1 — the construct surface is about five times larger

The reference flow used **10** node types. Across the corpus there are **41 more**:

```text
CommunicateAction 27   UpdateVariableAction 21   State 17   SetAttributesAction 12
AskForSlotAction 11    LoopAction 9              ExitLoopAction 8   EndStateAction 8
EndTaskAction 7        BotState 6                AskSurveyQuestionAction 5
CallTaskAction 5       ExitBotFlowAction 4       SwitchAction 4     SetLocaleAction 3
CallDigitalBotFlowAction 3   CollectInputAction 3   DigitalMenuAction 2
FindQueueAction 2      FindQueueByIdAction 2     SendResponseAction 2
LoopTask 2             HoldMusicAction 2         EvaluateScheduleAction 2
TaskAction 2           GetAttributesAction 2     PreviousMenuAction 2
ProcessVoicemailInputAction 2   ClearVoicemailSnippetAction 2   EndWorkflowAction 2
… and 11 more
```

Three of these matter structurally rather than merely semantically:

- **`State` and `BotState`** are *container* types alongside `Task` and `Menu`, appearing directly in `flowSequenceItemList`. Bot and digital flows are state machines rather than task lists.
- **`LoopAction` / `ExitLoopAction` / `LoopTask`** introduce explicit iteration, which the caller-journey traversal must treat as a bounded cycle rather than a path to enumerate.
- **`CallTaskAction` / `TaskAction` / `CallDigitalBotFlowAction`** are cross-flow and cross-task invocations — more edge sources for `extract-edges`, and reference types the resource graph must follow.

This quantifies **ADR-009**, the decision that capture handles all flow types from day one while documentation depth widens progressively. Full semantic depth for inbound call flows means modelling 10 constructs. Full depth for the organization means roughly 51.

## Finding 2 — `supportLevel` is currently overstated

`extract-nodes` marks any type outside the known ten as `supportLevel: 'unsupported'`. Applied to the wider corpus that would report most nodes in most non-inbound flows as unsupported, and the completeness gate in `docs/13` would read as catastrophic.

That is inaccurate. For an unrecognised action the extractor still captures its identity, its type, its name, its container, and its edges — everything except an interpretation of what it *does*. The snapshot schema already distinguishes these: `full`, `partial`, `opaque`, `unsupported`.

**Correction required:** a structurally captured node whose semantics are not yet modelled is `partial`, not `unsupported`. `unsupported` should mean the construct cannot be represented at all. Without this the completeness score punishes breadth rather than measuring loss, and a release gate driven by a misleading number is worse than no gate.

## Finding 3 — generic manifest handling paid off

Thirteen manifest categories exist beyond the seven in the reference flow:

```text
nluDomain 6   sttEngine 4   grammar 2   user 2   schedule 2   digitalBotFlow 2
contactList 2   acdWrapupCode 2   surveyForm 2   knowledgeBase 1   guide 1
dialogflowAgent 1   acdLanguage 1
```

`extract-dependencies` iterates manifest keys rather than matching a fixed list, so **all thirteen already work with no change**. That was a deliberate choice and it is the second time in this project that treating the server as the authority over a local list has avoided rework — the first being the flow-type enumeration bug in S2.

Note `dialogflowAgent` and `knowledgeBase`: some flows depend on third-party NLU and knowledge sources, which the technical document should surface as an external dependency and the operations document should flag as a failure domain.

## Finding 4 — one genuine gap in the value parser

Value-wrapper discriminators seen beyond `lit`, `emp` and `ref`:

| Discriminator | Occurrences | Assessment |
| --- | ---: | --- |
| `.` | 8 | Member access. Carries `operands`, so it already parses as an expression. |
| `[` | 3 | Index access. Same. |
| `and` | 3 | Logical operator with `operands`. Same. |
| `or` | 2 | Same. |
| **`nul`** | **7** | **A null literal.** Currently falls through to `opaque`. |

The operator cases need no change — `parseValueRef` treats anything carrying `operands` as an expression, which is why `AudioPlaybackOptions` already worked.

`nul` is a real gap. It is a *value*, not an operator, and it belongs alongside `lit` and `emp`. Distinguishing "explicitly null" from "explicitly empty" from "absent" matters to a migration tool for exactly the reason `emp` did.

## Changes required

| Change | Where |
| --- | --- |
| A structurally captured but semantically unmodelled node is `partial`, not `unsupported` | `packages/normalization/src/extract-nodes.ts`, and the completeness calculation |
| Add `nul` to the `ValueRef` union as a null literal | `packages/domain/src/value-ref.ts` |
| `State` and `BotState` join `Task` and `Menu` as container types | `extract-nodes`, `extract-edges` |
| Loop constructs are bounded cycles for journey traversal | `packages/analysis` when it is written |
| `CallTaskAction`, `TaskAction`, `CallDigitalBotFlowAction` are edge sources and cross-flow references | `extract-edges`, resource graph |
| Coverage estimate: ~51 constructs for full organization depth, versus 10 today | ADR-009, Plan 3 successor |

## What S1b does not settle

It samples two published flows per type, not all 511, so a rare construct in a flow it did not sample is still unknown. It also checks structure only: that a `CommunicateAction` can be captured says nothing about whether the documentation layer explains it usefully. And no fidelity baseline exists for any type other than inbound call, because a manual YAML export was only available for that one flow.
