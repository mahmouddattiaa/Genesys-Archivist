# Technical Documentation: Fixture Flow

_Generated 2026-08-20T00:00:00Z for audience: contact-center engineers and developers._

## 1. Source Identity, Version, and Completeness

- **Flow name:** Fixture Flow[e1]
- **Flow id:** `f1`
- **Flow type:** inboundcall[e2]
- **Secure flow:** no
- **Version:** 4.0 (published)
- **Snapshot id:** `f1@4.0`
- **Snapshot schema version:** 1.1

### Capture source

- **Provider:** platform-api
- **Adapter version:** 0.1.0
- **Extracted at:** 2026-08-20T00:00:00Z
- **Region:** eu\_west\_1
- **Organization id:** `org_1`
- **Tracking ids available:** yes
- **Redaction applied at capture:** yes

### Generation and normalization

- **Generator (this technical.md renderer):** 1.0.0
- **Normalizer canonicalizer version:** 1.0.0
- **Normalized graph hash (sha256):** `4c86b7e52ec332da9f66d2d270761bc1a45fca40e421029d6fcda99d665b238b`
- **Document generated at:** 2026-08-20T00:00:00Z

### Completeness

| Metric                  | Count |
| ----------------------- | ----- |
| Source objects          | 47    |
| Represented objects     | 47    |
| Unsupported nodes       | 0     |
| Opaque nodes            | 0     |
| Dangling edges          | 0     |
| Unresolved dependencies | 0     |

## 2. Flow Structure and Entry Points

- **Total nodes:** 47
- **Total edges:** 55
- **Entry points:** 1
- **Terminal nodes (no outgoing edge):** 4
- **Reachable nodes:** 47
- **Unreachable nodes:** 0

### Edge roles

| Role          | Count |
| ------------- | ----- |
| entry         | 7     |
| menu-choice   | 12    |
| next          | 12    |
| no            | 3     |
| transfer-menu | 12    |
| transfer-task | 6     |
| yes           | 3     |

### Entry nodes

| Node id  | Name         | Type | Evidence |
| -------- | ------------ | ---- | -------- |
| `trk_10` | India juliet | Task | [e3][e4] |

### Terminal nodes

| Node id  | Name                    | Type                    |
| -------- | ----------------------- | ----------------------- |
| `trk_23` | November juliet charlie | TransferPureMatchAction |
| `trk_24` | Bravo hotel             | TransferPureMatchAction |
| `trk_31` | Kilo india alpha        | TransferPureMatchAction |
| `trk_34` | India india india       | DisconnectAction        |

## 3. Action Inventory

Node counts by type:

| Type                    | Count |
| ----------------------- | ----- |
| DataAction              | 1     |
| DecisionAction          | 3     |
| DisconnectAction        | 1     |
| Menu                    | 3     |
| MenuAction              | 2     |
| PlayAudioAction         | 10    |
| Task                    | 7     |
| TransferMenuAction      | 10    |
| TransferPureMatchAction | 4     |
| TransferTaskAction      | 6     |

Every captured node, in node-id order. Evidence marks resolve to a full id in §10.

| Node id  | Name                                    | Type                    | Kind      | Container                   | Support | Evidence   |
| -------- | --------------------------------------- | ----------------------- | --------- | --------------------------- | ------- | ---------- |
| `trk_10` | India juliet                            | Task                    | container | —                           | full    | [e3][e4]   |
| `trk_11` | Papa juliet                             | Task                    | container | —                           | full    | [e5][e6]   |
| `trk_12` | Lima alpha november india               | Task                    | container | —                           | full    | [e7][e8]   |
| `trk_13` | Golf mike lima hotel                    | Task                    | container | —                           | full    | [e9][e10]  |
| `trk_14` | Lima echo echo india                    | Task                    | container | —                           | full    | [e11][e12] |
| `trk_15` | Foxtrot foxtrot alpha lima              | Task                    | container | —                           | full    | [e13][e14] |
| `trk_16` | November kilo echo november             | Task                    | container | —                           | full    | [e15][e16] |
| `trk_17` | November papa papa                      | Menu                    | container | —                           | full    | [e17][e18] |
| `trk_18` | Juliet papa                             | MenuAction              | action    | November papa papa          | full    | [e19][e20] |
| `trk_19` | India echo                              | Menu                    | container | —                           | full    | [e21][e22] |
| `trk_20` | India lima                              | TransferTaskAction      | action    | India echo                  | full    | [e23][e24] |
| `trk_21` | Charlie charlie                         | TransferTaskAction      | action    | India echo                  | full    | [e25][e26] |
| `trk_22` | Juliet charlie                          | TransferTaskAction      | action    | India echo                  | full    | [e27][e28] |
| `trk_23` | November juliet charlie                 | TransferPureMatchAction | action    | India echo                  | full    | [e29][e30] |
| `trk_24` | Bravo hotel                             | TransferPureMatchAction | action    | November papa papa          | full    | [e31][e32] |
| `trk_25` | Foxtrot                                 | TransferTaskAction      | action    | November papa papa          | full    | [e33][e34] |
| `trk_26` | Hotel lima                              | MenuAction              | action    | November papa papa          | full    | [e35][e36] |
| `trk_27` | Lima oscar                              | Menu                    | container | —                           | full    | [e37][e38] |
| `trk_28` | Charlie bravo foxtrot charlie           | TransferTaskAction      | action    | Lima oscar                  | full    | [e39][e40] |
| `trk_29` | Charlie charlie india                   | TransferMenuAction      | action    | Lima oscar                  | full    | [e41][e42] |
| `trk_30` | Golf lima foxtrot lima                  | TransferTaskAction      | action    | November papa papa          | full    | [e43][e44] |
| `trk_31` | Kilo india alpha                        | TransferPureMatchAction | action    | November papa papa          | full    | [e45][e46] |
| `trk_32` | Echo kilo hotel charlie                 | DecisionAction          | action    | India juliet                | full    | [e47][e48] |
| `trk_33` | Bravo delta                             | PlayAudioAction         | action    | India juliet                | full    | [e49][e50] |
| `trk_34` | India india india                       | DisconnectAction        | action    | India juliet                | full    | [e51][e52] |
| `trk_35` | Hotel echo echo                         | DecisionAction          | action    | India juliet                | full    | [e53][e54] |
| `trk_36` | Foxtrot golf                            | PlayAudioAction         | action    | India juliet                | full    | [e55][e56] |
| `trk_37` | Foxtrot oscar november charlie          | TransferMenuAction      | action    | India juliet                | full    | [e57][e58] |
| `trk_38` | Juliet echo bravo                       | TransferMenuAction      | action    | India juliet                | full    | [e59][e60] |
| `trk_39` | Juliet mike hotel                       | DecisionAction          | action    | Papa juliet                 | full    | [e61][e62] |
| `trk_40` | Juliet kilo echo                        | PlayAudioAction         | action    | Papa juliet                 | full    | [e63][e64] |
| `trk_41` | Mike alpha delta golf                   | TransferMenuAction      | action    | Papa juliet                 | full    | [e65][e66] |
| `trk_42` | Juliet kilo alpha                       | PlayAudioAction         | action    | Papa juliet                 | full    | [e67][e68] |
| `trk_43` | Alpha oscar november                    | TransferPureMatchAction | action    | Papa juliet                 | full    | [e69][e70] |
| `trk_44` | Echo delta november charlie hotel india | TransferMenuAction      | action    | Papa juliet                 | full    | [e71][e72] |
| `trk_45` | Hotel foxtrot papa                      | PlayAudioAction         | action    | Lima alpha november india   | full    | [e73][e74] |
| `trk_46` | Mike foxtrot                            | PlayAudioAction         | action    | Lima alpha november india   | full    | [e75][e76] |
| `trk_47` | Lima hotel india oscar                  | TransferMenuAction      | action    | Lima alpha november india   | full    | [e77][e78] |
| `trk_48` | Lima golf juliet                        | PlayAudioAction         | action    | Golf mike lima hotel        | full    | [e79][e80] |
| `trk_49` | Bravo papa kilo lima                    | TransferMenuAction      | action    | Golf mike lima hotel        | full    | [e81][e82] |
| `trk_50` | Juliet mike papa                        | PlayAudioAction         | action    | Lima echo echo india        | full    | [e83][e84] |
| `trk_51` | Charlie foxtrot alpha mike              | TransferMenuAction      | action    | Lima echo echo india        | full    | [e85][e86] |
| `trk_52` | Alpha india lima                        | PlayAudioAction         | action    | Foxtrot foxtrot alpha lima  | full    | [e87][e88] |
| `trk_53` | November lima mike oscar                | TransferMenuAction      | action    | Foxtrot foxtrot alpha lima  | full    | [e89][e90] |
| `trk_54` | Golf golf lima                          | PlayAudioAction         | action    | November kilo echo november | full    | [e91][e92] |
| `trk_55` | Bravo hotel alpha india                 | TransferMenuAction      | action    | November kilo echo november | full    | [e93][e94] |
| `trk_56` | India mike india                        | DataAction              | action    | India juliet                | full    | [e95][e96] |

## 4. Branch Table

Every edge in the flow graph, in edge-id order. A diagram covering the same graph — split by menu/task where a single diagram would be unreadable — accompanies this document. Edges do not carry their own evidence records in this normalizer version (see §10); an edge's evidence is its endpoint nodes' evidence in §3.

| Edge id                                                                  | From                                    | Role          | Label                      | To                                      |
| ------------------------------------------------------------------------ | --------------------------------------- | ------------- | -------------------------- | --------------------------------------- |
| `trk_10->trk_56#entry@startAction`                                       | India juliet                            | entry         | —                          | India mike india                        |
| `trk_11->trk_39#entry@startAction`                                       | Papa juliet                             | entry         | —                          | Juliet mike hotel                       |
| `trk_12->trk_45#entry@startAction`                                       | Lima alpha november india               | entry         | —                          | Hotel foxtrot papa                      |
| `trk_13->trk_48#entry@startAction`                                       | Golf mike lima hotel                    | entry         | —                          | Lima golf juliet                        |
| `trk_14->trk_50#entry@startAction`                                       | Lima echo echo india                    | entry         | —                          | Juliet mike papa                        |
| `trk_15->trk_52#entry@startAction`                                       | Foxtrot foxtrot alpha lima              | entry         | —                          | Alpha india lima                        |
| `trk_16->trk_54#entry@startAction`                                       | November kilo echo november             | entry         | —                          | Golf golf lima                          |
| `trk_17->trk_18#menu-choice@choice:efbc4ea0-65f7-4453-a079-9ec46bd715ca` | November papa papa                      | menu-choice   | 1: Delta juliet            | Juliet papa                             |
| `trk_17->trk_24#menu-choice@choice:690bb192-4c39-4843-a703-2e85fcb7b1a8` | November papa papa                      | menu-choice   | 2: Alpha foxtrot           | Bravo hotel                             |
| `trk_17->trk_25#menu-choice@choice:77c802ce-2081-4321-ac42-4b49a4548967` | November papa papa                      | menu-choice   | 3: Lima                    | Foxtrot                                 |
| `trk_17->trk_26#menu-choice@choice:b8bfb414-ec0d-4d4a-a0d1-fe3654feb998` | November papa papa                      | menu-choice   | 4: Delta alpha             | Hotel lima                              |
| `trk_17->trk_30#menu-choice@choice:fbfce03c-bead-4f6e-a589-7f681106955c` | November papa papa                      | menu-choice   | 5: Lima hotel hotel golf   | Golf lima foxtrot lima                  |
| `trk_17->trk_31#menu-choice@choice:21be3e48-d7e5-45e4-a3d1-8b7835c1df1b` | November papa papa                      | menu-choice   | 6: Kilo india kilo         | Kilo india alpha                        |
| `trk_18->trk_19#transfer-menu@menuReference`                             | Juliet papa                             | transfer-menu | —                          | India echo                              |
| `trk_19->trk_20#menu-choice@choice:5403071d-d3c9-4a5c-a8c1-288e39414772` | India echo                              | menu-choice   | 1: November charlie        | India lima                              |
| `trk_19->trk_21#menu-choice@choice:a6ef8833-e517-4c1b-a0df-1f36765439f1` | India echo                              | menu-choice   | 2: Delta india             | Charlie charlie                         |
| `trk_19->trk_22#menu-choice@choice:2672f9fd-0ab9-42a4-ab61-226372ff6756` | India echo                              | menu-choice   | 3: Alpha echo              | Juliet charlie                          |
| `trk_19->trk_23#menu-choice@choice:5d6169f2-5f35-4a52-aade-6d7473c44f8c` | India echo                              | menu-choice   | 4: Papa echo charlie       | November juliet charlie                 |
| `trk_20->trk_13#transfer-task@taskReference`                             | India lima                              | transfer-task | Hotel delta echo mike      | Golf mike lima hotel                    |
| `trk_21->trk_14#transfer-task@taskReference`                             | Charlie charlie                         | transfer-task | Kilo echo alpha papa       | Lima echo echo india                    |
| `trk_22->trk_15#transfer-task@taskReference`                             | Juliet charlie                          | transfer-task | Lima hotel alpha alpha     | Foxtrot foxtrot alpha lima              |
| `trk_25->trk_11#transfer-task@taskReference`                             | Foxtrot                                 | transfer-task | Papa alpha                 | Papa juliet                             |
| `trk_26->trk_27#transfer-menu@menuReference`                             | Hotel lima                              | transfer-menu | —                          | Lima oscar                              |
| `trk_27->trk_28#menu-choice@choice:f0a0ca89-a5a3-4b8d-afcc-e38009c2b12d` | Lima oscar                              | menu-choice   | 1: Alpha alpha bravo bravo | Charlie bravo foxtrot charlie           |
| `trk_27->trk_29#menu-choice@choice:5d7ae2f4-4779-481b-a629-e5e8497e310c` | Lima oscar                              | menu-choice   | 2: Delta india juliet      | Charlie charlie india                   |
| `trk_28->trk_16#transfer-task@taskReference`                             | Charlie bravo foxtrot charlie           | transfer-task | Juliet november oscar mike | November kilo echo november             |
| `trk_29->trk_17#transfer-menu@menuReference`                             | Charlie charlie india                   | transfer-menu | Alpha delta foxtrot        | November papa papa                      |
| `trk_30->trk_12#transfer-task@taskReference`                             | Golf lima foxtrot lima                  | transfer-task | Charlie mike bravo alpha   | Lima alpha november india               |
| `trk_32->trk_33#yes@path:__YES__`                                        | Echo kilo hotel charlie                 | yes           | Juliet                     | Bravo delta                             |
| `trk_32->trk_35#no@path:__NO__`                                          | Echo kilo hotel charlie                 | no            | Golf                       | Hotel echo echo                         |
| `trk_33->trk_34#next@nextAction`                                         | Bravo delta                             | next          | —                          | India india india                       |
| `trk_35->trk_36#yes@path:__YES__`                                        | Hotel echo echo                         | yes           | Echo                       | Foxtrot golf                            |
| `trk_35->trk_38#no@path:__NO__`                                          | Hotel echo echo                         | no            | Juliet                     | Juliet echo bravo                       |
| `trk_36->trk_37#next@nextAction`                                         | Foxtrot golf                            | next          | —                          | Foxtrot oscar november charlie          |
| `trk_37->trk_17#transfer-menu@menuReference`                             | Foxtrot oscar november charlie          | transfer-menu | Alpha echo november        | November papa papa                      |
| `trk_38->trk_17#transfer-menu@menuReference`                             | Juliet echo bravo                       | transfer-menu | Alpha papa kilo            | November papa papa                      |
| `trk_39->trk_40#yes@path:__YES__`                                        | Juliet mike hotel                       | yes           | Juliet                     | Juliet kilo echo                        |
| `trk_39->trk_42#no@path:__NO__`                                          | Juliet mike hotel                       | no            | November                   | Juliet kilo alpha                       |
| `trk_40->trk_41#next@nextAction`                                         | Juliet kilo echo                        | next          | —                          | Mike alpha delta golf                   |
| `trk_41->trk_17#transfer-menu@menuReference`                             | Mike alpha delta golf                   | transfer-menu | Lima hotel kilo            | November papa papa                      |
| `trk_42->trk_43#next@nextAction`                                         | Juliet kilo alpha                       | next          | —                          | Alpha oscar november                    |
| `trk_43->trk_44#next@nextAction`                                         | Alpha oscar november                    | next          | —                          | Echo delta november charlie hotel india |
| `trk_44->trk_17#transfer-menu@menuReference`                             | Echo delta november charlie hotel india | transfer-menu | Oscar foxtrot delta        | November papa papa                      |
| `trk_45->trk_46#next@nextAction`                                         | Hotel foxtrot papa                      | next          | —                          | Mike foxtrot                            |
| `trk_46->trk_47#next@nextAction`                                         | Mike foxtrot                            | next          | —                          | Lima hotel india oscar                  |
| `trk_47->trk_17#transfer-menu@menuReference`                             | Lima hotel india oscar                  | transfer-menu | Alpha foxtrot juliet       | November papa papa                      |
| `trk_48->trk_49#next@nextAction`                                         | Lima golf juliet                        | next          | —                          | Bravo papa kilo lima                    |
| `trk_49->trk_17#transfer-menu@menuReference`                             | Bravo papa kilo lima                    | transfer-menu | Kilo november juliet       | November papa papa                      |
| `trk_50->trk_51#next@nextAction`                                         | Juliet mike papa                        | next          | —                          | Charlie foxtrot alpha mike              |
| `trk_51->trk_17#transfer-menu@menuReference`                             | Charlie foxtrot alpha mike              | transfer-menu | Delta mike charlie         | November papa papa                      |
| `trk_52->trk_53#next@nextAction`                                         | Alpha india lima                        | next          | —                          | November lima mike oscar                |
| `trk_53->trk_17#transfer-menu@menuReference`                             | November lima mike oscar                | transfer-menu | Alpha november alpha       | November papa papa                      |
| `trk_54->trk_55#next@nextAction`                                         | Golf golf lima                          | next          | —                          | Bravo hotel alpha india                 |
| `trk_55->trk_17#transfer-menu@menuReference`                             | Bravo hotel alpha india                 | transfer-menu | Papa charlie charlie       | November papa papa                      |
| `trk_56->trk_32#next@nextAction`                                         | India mike india                        | next          | —                          | Echo kilo hotel charlie                 |

## 5. Variables

| Name     | Scope | Type   | Direction | Secure | Read by | Written by | Evidence |
| -------- | ----- | ------ | --------- | ------ | ------- | ---------- | -------- |
| Lima     | flow  | string | local     | no     | 1       | 0          | [e97]    |
| Bravo    | task  | string | local     | no     | 3       | 1          | [e98]    |
| Foxtrot  | flow  | bool   | local     | no     | 0       | 0          | [e99]    |
| Kilo     | task  | string | local     | no     | 1       | 1          | [e100]   |
| November | flow  | bool   | local     | no     | 0       | 0          | [e101]   |
| Alpha    | flow  | bool   | local     | no     | 1       | 0          | [e102]   |
| Foxtrot  | task  | string | local     | no     | 1       | 1          | [e103]   |

### Variables read but never written

- **Lima (flow, string)** is read but never written anywhere in this flow (1 read site). Any branch or prompt depending on its value cannot behave as the flow author intended — it always observes the platform default, never a value this flow set. Evidence: [e97].
- **Alpha (flow, bool)** is read but never written anywhere in this flow (1 read site). Any branch or prompt depending on its value cannot behave as the flow author intended — it always observes the platform default, never a value this flow set. Evidence: [e102].

### Variables declared but unused

- **Foxtrot (flow, bool)** is declared but never read or written. Evidence: [e99].
- **November (flow, bool)** is declared but never read or written. Evidence: [e101].

## 6. Prompt and Language Inventory

### Declared languages

No language was declared at the flow level. The capture records 1 language-related dependency resolved for this flow:

- en-US[e107]

### Prompt-playing nodes

| Node id  | Name               | Container                   | Evidence   |
| -------- | ------------------ | --------------------------- | ---------- |
| `trk_33` | Bravo delta        | India juliet                | [e49][e50] |
| `trk_36` | Foxtrot golf       | India juliet                | [e55][e56] |
| `trk_40` | Juliet kilo echo   | Papa juliet                 | [e63][e64] |
| `trk_42` | Juliet kilo alpha  | Papa juliet                 | [e67][e68] |
| `trk_45` | Hotel foxtrot papa | Lima alpha november india   | [e73][e74] |
| `trk_46` | Mike foxtrot       | Lima alpha november india   | [e75][e76] |
| `trk_48` | Lima golf juliet   | Golf mike lima hotel        | [e79][e80] |
| `trk_50` | Juliet mike papa   | Lima echo echo india        | [e83][e84] |
| `trk_52` | Alpha india lima   | Foxtrot foxtrot alpha lima  | [e87][e88] |
| `trk_54` | Golf golf lima     | November kilo echo november | [e91][e92] |

### Text-to-speech and prompt-related dependencies

| Type         | Display name | Resolution status | Evidence |
| ------------ | ------------ | ----------------- | -------- |
| ttsEngine    | Bravo alpha  | resolved          | [e104]   |
| systemPrompt | Hotel        | resolved          | [e105]   |
| ttsVoice     | Echo         | resolved          | [e106]   |

## 7. Dependencies

Every external resource this flow references — queues, data actions, text-to-speech configuration, and similar. No credential, secret, or endpoint URL is reproduced here; see docs/05 §"External calls" for what this document deliberately omits.

| Type         | Display name                           | Resolution status | Referenced by | Evidence |
| ------------ | -------------------------------------- | ----------------- | ------------- | -------- |
| queue        | Delta                                  | resolved          | 4             | [e108]   |
| ttsEngine    | Bravo alpha                            | resolved          | 0             | [e104]   |
| systemPrompt | Hotel                                  | resolved          | 0             | [e105]   |
| ttsVoice     | Echo                                   | resolved          | 0             | [e106]   |
| dataAction   | Bravo golf delta lima november charlie | resolved          | 1             | [e109]   |
| language     | en-US                                  | resolved          | 0             | [e107]   |

### External calls (data actions)

This flow calls out to 1 data-action dependency from 1 `DataAction` node. Its success/failure branching is recorded in the branch table (§4) by role and label; no request or response payload is captured here.

| Node id  | Name             | Container    | Evidence   |
| -------- | ---------------- | ------------ | ---------- |
| `trk_56` | India mike india | India juliet | [e95][e96] |

## 8. Error, Retry, and Loop Handling

This section records what the graph itself proves about branching and retry structure. It does not infer _why_ a branch exists — only that it does, and where.

### Decision points

3 `DecisionAction` nodes implement this flow's yes/no branching; see the branch table (§4) for each one's outgoing edges.

| Node id  | Name                    | Container    | Evidence   |
| -------- | ----------------------- | ------------ | ---------- |
| `trk_32` | Echo kilo hotel charlie | India juliet | [e47][e48] |
| `trk_35` | Hotel echo echo         | India juliet | [e53][e54] |
| `trk_39` | Juliet mike hotel       | Papa juliet  | [e61][e62] |

### Loops and retries

This flow's graph contains 1 non-trivial strongly connected component — a caller can loop back to a node already visited on the same path, which is normal for a menu or retry loop and is not itself a defect.

| Component size | Node ids (sample)                       |
| -------------- | --------------------------------------- |
| 35             | `trk_11`, `trk_12`, `trk_13` (+32 more) |

## 9. Graph Findings

- **Unreachable nodes:** 0
- **Dangling edges:** 0
- **Strongly connected components:** 1 (largest: 35 nodes)
- **Findings below:** 5 (2 error, 0 warning, 3 info)

Only `fact` and `derived` findings are reported here. `technical.md` never presents an `inference` as a fact.

| Code                        | Severity | Kind    | Message                                                                                                                                                 | Subject                         | Evidence                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------- | -------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CYCLE_PRESENT               | info     | fact    | 35 node\(s\) form a cycle: the flow can revisit this state, which is normal for a menu or retry.                                                        | 35 nodes                        | [e21][e19][e13][e71][e85][e39][e11][e20][e7][e8][e12][e93][e79][e15][e77][e14][e41][e80][e23][e65][e89][e35][e69][e33][e17][e36][e37][e43][e44][e38][e25][e67][e5][e66][e26][e24][e94][e75][e83][e87][e16][e91][e40][e22][e70][e92][e90][e86][e61][e88][e9][e6][e10][e78][e18][e84][e81][e34][e27][e73][e63][e68][e72][e64][e62][e28][e42][e74][e82][e76] |
| VARIABLE_DECLARED_UNUSED    | info     | derived | Variable "Foxtrot" \(flow scope\) is declared but never read or written.                                                                                | variable: Foxtrot (flow, bool)  | [e99]                                                                                                                                                                                                                                                                                                                                                     |
| VARIABLE_DECLARED_UNUSED    | info     | derived | Variable "November" \(flow scope\) is declared but never read or written.                                                                               | variable: November (flow, bool) | [e101]                                                                                                                                                                                                                                                                                                                                                    |
| VARIABLE_READ_NEVER_WRITTEN | error    | derived | Variable "Alpha" \(flow scope\) is read but never written anywhere in this flow. Any branch or prompt depending on its value cannot behave as intended. | variable: Alpha (flow, bool)    | [e102]                                                                                                                                                                                                                                                                                                                                                    |
| VARIABLE_READ_NEVER_WRITTEN | error    | derived | Variable "Lima" \(flow scope\) is read but never written anywhere in this flow. Any branch or prompt depending on its value cannot behave as intended.  | variable: Lima (flow, string)   | [e97]                                                                                                                                                                                                                                                                                                                                                     |

## 10. Evidence Index and Known Limitations

This snapshot carries 109 evidence records in total. Every technical claim above that cites a mark resolves to one of them below; the full snapshot carries the rest, including facts this document did not need to state.

### Evidence by classification

| Classification | Count |
| -------------- | ----- |
| confidential   | 3     |
| internal       | 106   |

### Evidence marks

| Mark   | Evidence ID                                                             |
| ------ | ----------------------------------------------------------------------- |
| [e1]   | sha256:0a7780f3f0d3af9feaccede306e57a23d8729d457f55884a81f9b57a1813ccbf |
| [e2]   | sha256:681e1db977a7b29086ef9e6cf2f67d729b44241809757c8b9f5b7add186fb8a0 |
| [e3]   | sha256:c66688380fbbfbdc94d97fc1618568f286a4fed2816f298ad8f1b67ff4b7280d |
| [e4]   | sha256:f79426995a93a623914ee950995570b04325f402c68148a01e462528c0e9a1f1 |
| [e5]   | sha256:7706f5c2dd94031cc2aabe61e28853fb676a277b50e9a1b9dfa3736a9ba40c0d |
| [e6]   | sha256:c220aca3515ff87f92b93db7e777381e4ca95736a6d16f91c150e4d07a38bec4 |
| [e7]   | sha256:16bc54c9446b5a1e912daf8ff6f0336549f0de65ef9d7fe3b1c94225457ad913 |
| [e8]   | sha256:1cadb8045091213ed13987c97658ebba0baeae57732c33ef4e3b4346d56dd832 |
| [e9]   | sha256:bdbe8c0a5b6c44aa62ad13870077e434fca95d862791f9d50e2fda4ce45289eb |
| [e10]  | sha256:c32ce4b351199f1ffc70cc0a5f84d1a2268d8aa4b81e00a6e66fbdb902a20869 |
| [e11]  | sha256:14d95df1735e6778c807fbfb98cadb6c714b7fa37781c5f65eaee3f06a552ff1 |
| [e12]  | sha256:22f796dcae9c2931f8c83b50780bf9dc538165b338e498b241af96203e5388e3 |
| [e13]  | sha256:0a4223a690ab813d8df3f23ce6c047b1263851c81be574b92234de756c7b3982 |
| [e14]  | sha256:2b1f86d6389d33fbd0c0e4e743595b45f6c34f244f72f6df28146019c77c07c3 |
| [e15]  | sha256:26d851c7b4c29d36ed471c31c5a25554afb0e6cc32bff6e2b814e1d3ec623df0 |
| [e16]  | sha256:957bff41dff6fefdf87c80955d29b06ebeb2af1a2ed42ff899eddd3c97a9d6f2 |
| [e17]  | sha256:512dc2ec0f1cc3ec86d8274d316501033ff8cc3997da7ac1798009878428794e |
| [e18]  | sha256:c45171af68f815ce1995bdf8e6220b6d03b3c56929e30e5800b18bc3c751378c |
| [e19]  | sha256:087321cddcb5fd7629f1ba911b615d8b743463e5373f540f6873a1cfc87c22c1 |
| [e20]  | sha256:14fb598dfd29be068b1304ca99f5166a45b54ddb9bfbd8d9b85f1e0b454f1bea |
| [e21]  | sha256:05f2b15975a3637a1102013d160bee9dd7ce57b5b59f322e6b4b5c708845aba4 |
| [e22]  | sha256:a6dd3804190760e642f1f346e42a0b8fc795989a6fcfb2bd6008371e2a32bd1a |
| [e23]  | sha256:321c279542415fa130f1694ba89188d1dd0e208eef54de2cc33e21d931fbc405 |
| [e24]  | sha256:8181a97defe703542738b02e530c72ab3f395bb245c1a3561575a4fae503d5cf |
| [e25]  | sha256:6198df425cb1d20e19c2e41c2ce0947d062e6ae8f6d09abf9fcb1fc7b55d45fd |
| [e26]  | sha256:80a61d4d2cb183fa6653185c4ab45a074300756478f51f2a999d03b84929dfa7 |
| [e27]  | sha256:cfeaff13b48234281a9dd5144e4af5e686f2d3c469ccc793eeff0ca48be04fd7 |
| [e28]  | sha256:e975e5bf02cbc30eada9c9e06f9482ca8474e8995cdb8f263505024ac8dd8006 |
| [e29]  | sha256:3b250fa14cd11e1014fad7be08a7d38d292e2c3629617ecb0e1a1bfb4780551a |
| [e30]  | sha256:7af5d0a021fb5896998324de232efdaccc6a9ff0715cd545061dcaaa2a543565 |
| [e31]  | sha256:aaacf016b264129990cc4fa55be0f920a43e74a37087fa2f5f2f6fa7de6cf52c |
| [e32]  | sha256:f0d2439a1ccb1c3abfa93ca1330e049d9c23409083c2821a15644a9f0ef4125d |
| [e33]  | sha256:50aae0372917733a6d7a12301547ca0b88f4792bd3c1b0e6c719eddb81bfc2c4 |
| [e34]  | sha256:ced4b4d43e87f4765abd26ac012be556fcdb576b1ff5e65ae23d9414001b2c49 |
| [e35]  | sha256:4c1ec18ed5be0503ffc006747675aece0518b15a4d553a95f6c626f775e7f964 |
| [e36]  | sha256:529ac7504148373a4514eae6f666de80e9f5d0e164d09002f82cc7f845eb8d4c |
| [e37]  | sha256:554afd76c79065415ce3a8da4d563418f9a33afe1a3861efb51f96a23b1f7b95 |
| [e38]  | sha256:60130b77f0193db153cbe4469c0f6a943e314610ea0ea67a6f5bcb03018bb212 |
| [e39]  | sha256:143c61c84f6a49a119cdc82c148064327ab4ee352d1e883756f8373964ca288b |
| [e40]  | sha256:a28e9a0029bc432f3734fb74ff126d5fdb9f4ba45cfd239282547e670fb8a49a |
| [e41]  | sha256:2d366964821d9c5bad47b7980a8faf51808fa61e54ce172afbad382acce29a90 |
| [e42]  | sha256:ece3e0162e2e3d862dfb6c3bee57c81cd67833e4b9f1af9dffcda5e05db5345e |
| [e43]  | sha256:587e3ed61b4c997b35b027262598be639231ec07bdd9ca7fa05b2a0c72ba4092 |
| [e44]  | sha256:5dbe1e1ca1ec117fb8d00c92279971acce08a1e66184f2faf4d4f89a32776824 |
| [e45]  | sha256:ab9b0b355c88e15892acd9d05d3dd2b1cff0ee4b1454007eca79039f5d5c1588 |
| [e46]  | sha256:ca4a33cff0acf7eb91699a0c64d09b38a435ba14d9810052ebd6576bb63695e7 |
| [e47]  | sha256:0265b9873b04933907dc564237792235c1768beb38500d943e179638d0af32a7 |
| [e48]  | sha256:7941cbe8663f94a76745dc3e055ab6553d78aabdb71bf8f17a076e12f288b290 |
| [e49]  | sha256:325f5f47720e89e9928071456b755f75e0fb88118c4af9124d80ee495b324df3 |
| [e50]  | sha256:da7e4ff65f3b6097c550fba1774924ccae519f942093c40768e47a54e704bbff |
| [e51]  | sha256:2232c7f791e691968155290c64447590525e7d41e294f460e0463e94e581d90b |
| [e52]  | sha256:f8eeeacebb6657e7a165ed2049994350d0433f37b1cf7ea32bfb28adefefa8c1 |
| [e53]  | sha256:c1774fa4b6e9105c65c3e28d40eb0462ebaf969baaf86b2f33e611c9816be96d |
| [e54]  | sha256:fe0a036e59b95ad6f7080bb6e6adf316d14285401e817f8ab5a67680e90ec994 |
| [e55]  | sha256:0eea8f3cad9c68938ebcaead329e09f5407b1feaa10352f1423352bbc22bd608 |
| [e56]  | sha256:4289235a2892110d3a2e7d3beb8ca71ffc00d27f144237dd774634711fe15ba7 |
| [e57]  | sha256:70ff092daa438ee8629a15e42bfa207bd2afa6e38100b0bbaa7bbfd4f49c5b4a |
| [e58]  | sha256:84440d60379417d4cfe57f296bd01302300b001f863cb844e384128562c73aba |
| [e59]  | sha256:ab281a9d80e563ecf3ef6783e359528ae611408fe7b6ea6e745437c468616be4 |
| [e60]  | sha256:ab616fa2d590fa48d761c4e2740e34f713c0247e52ff400b331448159790c351 |
| [e61]  | sha256:b2ad17ada1f1734316aad44d698aa929e5f8745dd71b90ef3305e0e55703c869 |
| [e62]  | sha256:e767e6f6a2483751fb1e420845888d53d90ccdf3e36e0b8f0a419d106e4eba1d |
| [e63]  | sha256:d1192351b33181e854ee64feade14cc8b83dfd9dea871aa5d0750944bd968f84 |
| [e64]  | sha256:e0f97013302d2206e6f1fb5f81e8dc27977c7fbc32b2c567aaa9bbd2d5f6eed3 |
| [e65]  | sha256:37fd602feb57ac6d2da528ac9f8a57e262b277506d64ac1e9eca1fbe12a99bf6 |
| [e66]  | sha256:7f6f208b76cfaa17bdacf434f0e7cd9b79e8ff1ac633dc6a0ed3a48cb425a466 |
| [e67]  | sha256:69d358fbe7c0f705a359705d962ea338a193c760b13c8eb30d8c1f16d30a69a1 |
| [e68]  | sha256:d6e526e8764924c78cb3fa2dfd4ba56e7b0cbf810ecb76dcd3119d0f4393c48a |
| [e69]  | sha256:4e2776a05f6b1e44f469a531071cb1d9153e34acde1e68effec7c58f7c0b4743 |
| [e70]  | sha256:a7e3118e61e215207bbe249d6c351d58eb71f597069b3813901c76f5d8c31f11 |
| [e71]  | sha256:0b87f19db85716692b2e48a4e0b58f24e905f89d509db6c6595c9800ad05ffc9 |
| [e72]  | sha256:dc6e892cd0c0f3213e755e91f6bb996c7edc7e71f9fc9b6854b37d71f3424d17 |
| [e73]  | sha256:d0e8e1b2707c1c80682f2c917c20dbffc94a41b7fcea6c07e0faf585f53b6f08 |
| [e74]  | sha256:ed0681ec32adc292db3c042b50a30948899ea5def1967ababb385211cb03d620 |
| [e75]  | sha256:8a4fc10c0b309722c90324f839b055afc3570bf8a359808da780a6303e5001fc |
| [e76]  | sha256:f7eb248cffae59cdee45fa1a331ea5196bbff344fa54f1e6a46490b837c5640f |
| [e77]  | sha256:27b0156c0d4619b51d4ca60d97cdf5bd282f628b2856e0ee2451d04c8bd63926 |
| [e78]  | sha256:c3ae9d7f2692e5630a3b28a7c525a5488dbd7da4be01cc592ef1ffadb54810e3 |
| [e79]  | sha256:237cce33e5b6f038dc61883fe911b71d12a21c8bcad9f6faec80f7cbb1d02824 |
| [e80]  | sha256:2fd6ba0a2c2fd46e8734624779a04ee59f8a9376f5200a9f90f166b361ac4995 |
| [e81]  | sha256:c6453ab9682bd825b551d465ef06b9442d23a12c02e615fc55975124c334f984 |
| [e82]  | sha256:f77b29d0738cb496993149552bb0779edf31be8c6b43d9df1d5880941269fbd0 |
| [e83]  | sha256:8d748819cc72e945a78822d6cbe75b06632efdac3bc30aac7152e1dbdfdfb033 |
| [e84]  | sha256:c626e65ff801dcd0a78806c5fc187dff9bfdc5dc5658f042165468b364d8074b |
| [e85]  | sha256:0dd9b4e33b1b5b678b0f01cc95d0b6999e6357640d5268c85b54f50b3613cdef |
| [e86]  | sha256:b0fd73bcc57b443ea6cef51cb5a6395c9810aacf6c92b027e614f4dc3457cc08 |
| [e87]  | sha256:91e422bbca93d4f9fc310285e1bbb732021fb4f248afd5813baf5ddeeff5837a |
| [e88]  | sha256:b9fee45d0e4601926fa817b8fd400bb7ffbcfa48bf0bbcac17d8b3b6b80398a7 |
| [e89]  | sha256:3c27df4294039e785a5893e4065745b3afd1dc75228adac90af335bf7ad78227 |
| [e90]  | sha256:abc6e7a7a76211387eb26be539414dcef1922f8ebe4e81b6f00beda57246cdee |
| [e91]  | sha256:9740d1b19116a45c951e2d2482e76f63d77208e19d495909d3f4473430aa60d2 |
| [e92]  | sha256:a81c38a5bd3b3fbd5fc57cfc9ac72b06d424e32640a7cbecd2d2b0cd10dda3c9 |
| [e93]  | sha256:2326021f7d9b61dc86070f5ea192b4145ebe84d83ad80af322fcfc3823fa0843 |
| [e94]  | sha256:852c2af288aafd9ea43475b16d7bd74291a24285fc456ae8fc594dbcc5a12f9a |
| [e95]  | sha256:37d751dd599e23e9e9d0645190a17293092859ef6979be4338646d0637d8f5ce |
| [e96]  | sha256:be473eb378ddf7f3555404d0cbaa2cc024bd3174a126127fef7bbe61fa6137ea |
| [e97]  | sha256:eb9d831f8a1bb69b80095d532350a3dc7c585e12842c36b00335b9985ea1ec2e |
| [e98]  | sha256:afa350a464be3767f938b31b19ec29c1a8176dc2e35c3e22202cc5391e5c845e |
| [e99]  | sha256:4de6b206cfbeba4d08b1b926c11b6c92bf8d2e6dce1a1e4de20b0fd7e429a25d |
| [e100] | sha256:d9f40a22d0b94b44f9067927c419f6b236ac16893b7aa83af818e01b9af7a46b |
| [e101] | sha256:89af57ec1ec5126ef5490248e8fbcb004d315db292b18d5d0bdcddc021954470 |
| [e102] | sha256:e22863881a0778e5926f6b7faa4feeff37a411ecf7db851ac054a8e39b20463d |
| [e103] | sha256:02fd71cd8d7874cde0d53903082b01e51d113d0f74db2a614ca0f37bdd5b4008 |
| [e104] | sha256:90940efb1f638080bb22fb20435fcabdac057cccc762a2c9655533ad030ded29 |
| [e105] | sha256:301106b9a9978dcd05df0a3584be3ce128dc4a6fc0d3d0ac3b9a53aa1a9c7bed |
| [e106] | sha256:846f034f1ad96f267558c5015d30cdd1fd3751d86ff9913be4fcf7ac1de23d48 |
| [e107] | sha256:1a103e54a89c3ea552cfe6e07c8807fb85675219dff1b66c5c490752d8d03a8f |
| [e108] | sha256:28baef4f9419dd816d451303568a353b0d3b06ef0db7a48e19c91c624849a9ff |
| [e109] | sha256:04fab4a6f9019e08988a62b8647de81d2953da6b95c5092ee16a54bf5109ecd2 |

### Known limitations

- Edges do not yet carry their own evidence records in this normalizer version; a branch's evidence is its endpoints' evidence in the action inventory (§3).
