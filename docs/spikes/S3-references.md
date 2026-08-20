# S3 — Resource reference closure

```text
Spike:        S3 — does the resource reference walk reach closure read-only?
Decision:     PASS, and it removes the largest known risk in the capture design.
Date:         2026-08-20
Environment:  purecloud-platform-client-v2, Node v22.15.0, region eu_west_1
Target:       IVR 5ffacb01… → flow b97e0e67… "Customer Care IVR By Claude" v4.0
Result:       GO
```

The walk from the original brief — route → flow → prompts → data actions → integrations — completes end to end, read-only, entirely by stable ID.

## Finding 1 — the flow configuration carries a manifest with stable IDs

`getFlowVersionConfiguration(flowId, version)` returns the full flow configuration **and a `manifest`** listing every referenced resource with its stable ID, its display name, and the nodes that reference it:

```json
"queue": [{
  "name": "Bazat_Queue",
  "id": "32e05a41-f569-4937-b35e-c57f28cf1c15",
  "context": [
    { "actionName": "Transfer to ACD", "id": "1ed092d7-…", "name": "Transfer To Agent" },
    { "actionName": "Transfer to ACD", "id": "d14ba8bd-…", "name": "Postpaid Services" },
    { "actionName": "Transfer to ACD", "id": "87fa2016-…", "name": "Speak To Agent" },
    { "actionName": "Transfer to ACD", "id": "b8b9e547-…", "name": "Speak To Agent" }
  ]
}]
```

**This resolves the largest risk identified in `S1-yaml-structure-findings.md`.** That document found Architect YAML references every resource by display name only, concluded a name-to-ID join was unavoidable, and flagged that join as the one place capture could silently mis-resolve. It is now unnecessary: the API supplies the IDs directly.

The `context` array is exactly the edge provenance `resource-graph.schema.json` requires — `viaNodeId` and `viaField` come straight from `context[].id` and `context[].actionName`, with no inference.

Measured on the target flow: **6 referenced resources, 8 reference edges, 100% carrying stable IDs.**

Manifest resource types present: `dataAction`, `queue`, `ttsEngine`, `ttsVoice`, `language`, `userPrompt`, `systemPrompt`.

## Finding 2 — this changes the source-path decision a second time

S1's preliminary findings concluded that YAML and the Platform API were complementary, with a name-based join between them. That is now wrong in a better way — no join is needed, and the roles are cleaner:

| Source                        | Role                       | Why                                                                                                         |
| ----------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `getFlowVersionConfiguration` | **Primary capture source** | Full configuration plus a manifest with stable IDs and node-level provenance                                |
| Architect YAML export         | **Migration payload only** | Genesys documents YAML as the cross-organization import format; it is what a migration server feeds back in |

Capture and documentation build on the configuration endpoint. YAML is retained in the bundle because a migration tool needs an importable artifact, not because anything reads it. That is a simpler and more defensible split than a name-based join between two sources.

Version pinning is confirmed working: `getFlowVersionConfiguration(flowId, '4.0')` returns the published version specifically, so a capture can target published behaviour exactly rather than whatever is latest.

## Finding 3 — second-order closure works, and credentials are structurally absent

```text
flow b97e0e67…
  → dataAction  custom_-_bd2b8040…   "Get Caller information - Banner-V1 …"
      contract present, secure=false
  → integrationId 4c60af62…
      → integration "Web Services Data Actions", type=custom-rest-actions
      → credentials in response: ABSENT
```

Every hop is by stable ID, via `getIntegrationsAction` then `getIntegration`.

The credential result is stronger than the design assumed. `docs/06` treats "never retrieve integration credentials" as a rule the redactor enforces. In practice the API **did not return a credentials field at all** under this OAuth client. The read-only property holds structurally, not merely by our own discipline. The redactor stays as defence in depth, but it is no longer the only thing standing between us and a credential.

The action's `contract` is present, which is what the technical document needs to describe inputs and outputs.

## Finding 4 — reverse edges are not available; invert locally

`getArchitectDependencytrackingConsumingresources` returns HTTP 400 for this call shape. The dependency-tracking index itself reports `OPERATIONAL`, and its type taxonomy lists **64 resource types**, so the subsystem is live — but the reverse lookup is not usable as invoked here.

Consequence: _"what breaks if we retire this queue"_ must be computed by **inverting the manifest graph across all captured flows**, not by asking Genesys.

This is a fine outcome. Capture already walks every flow in the organization, so inversion is a local computation over data already in the bundle, with no extra API calls and no dependency on an index we cannot rebuild. It also validates the `resource-graph.json` design, whose whole purpose is to make that inversion a lookup.

Worth noting explicitly: `postArchitectDependencytrackingBuild` **is a mutation** and was never called. If the index were stale we could not refresh it without a permission the design forbids holding, which is a further argument for not depending on it.

## Finding 5 — node IDs differ between JSON and YAML

The manifest's `context[].id` values are GUIDs such as `1ed092d7-7118-4b42-bfef-78dfbc23edb7`. The YAML export of the same flow carries `refId` values of the form `Caller Main Menu_17`, and only on menu and task containers.

So the JSON configuration appears to carry per-node stable identifiers where the YAML does not. If that holds for **all** nodes rather than only those appearing in manifest contexts, then `deriveNodeId` becomes a fallback rather than the primary identity path, reversing S1's Finding 2.

**This is now an S1 question:** does the JSON configuration carry a stable ID on every node, or only on nodes that reference an external resource? The answer determines whether derived identity is load-bearing.

## Permissions observed

Everything succeeded with the existing OAuth client and no mutation permission. Calls exercised: `getArchitectIvr`, `getFlow`, `getFlowLatestconfiguration`, `getFlowVersionConfiguration`, `getIntegrationsAction`, `getIntegration`, `getArchitectDependencytrackingTypes`, `getArchitectDependencytrackingBuild`.

## Changes required

| Change                                                                                      | Where                                             |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Primary capture source is `getFlowVersionConfiguration`; YAML is the migration payload only | Design spec §5.1, ADR-003 and ADR-004             |
| First-order references come from the manifest — no closure walk needed for them             | Plan 2 Task 6 simplifies substantially            |
| Second-order walk is `dataAction → integrationId → integration`                             | Plan 2 Task 6                                     |
| Reverse edges computed by local inversion of the manifest graph                             | `packages/capture`, `operations.md` generation    |
| Never call `postArchitectDependencytrackingBuild`                                           | Mutation allowlist in `packages/genesys-platform` |

## What S3 does not settle

Whether every node in the JSON configuration carries a stable ID (Finding 5), whether the manifest is complete for flows far richer than this one — this flow references only six resources — and whether flows using recorded `userPrompt` resources expose downloadable audio. The last is S4, which is now lower priority: the product's focus is the flows inside each IVR, and IVR audio assets are secondary.
