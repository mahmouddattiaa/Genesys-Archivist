# Phase 0 Spikes

Phase 0 is a **go/no-go gate**, not a warm-up. Production code for the Genesys adapters does not begin until S1 and S5 have results.

Spike code is throwaway. Write it in a scratch directory, prove the thing, record the evidence, delete the code. Do not let a spike become the production adapter by accident.

## Rules

- Sandbox organization only. Never a production customer tenant.
- Sanitize every artifact before it lands here. Real flow names, queue names, DIDs, endpoint URLs, and audio are customer data.
- `spike-evidence/` is gitignored. What gets committed is the findings summarized in a decision record, never the raw capture.
- A spike that cannot answer its question is a valid result. Record it and escalate rather than guessing.

## The ten spikes

| ID  | Question                                                               | Pass condition                                                                                                                                                          |
| --- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S0  | Which Node LTS and package versions work together?                     | Install, authenticate, initialize MCP, render a PDF, and package on Windows, macOS, and Linux. Versions pinned in a committed lockfile.                                 |
| S1  | Which of the four source paths gives best fidelity at least privilege? | Scored comparison against a manual Architect UI YAML export with tracking IDs, across 6-10 flows spanning types. Every difference explained. Winner recorded as an ADR. |
| S2  | Can every flow and version be discovered?                              | Counts match an administrator-approved sandbox inventory across types, divisions, and pages. Same-name flows in different divisions stay separate.                      |
| S3  | Does the resource reference walk reach closure read-only?              | Every referenced type either resolves or returns an explicit `forbidden` or `unsupported` state. No silent drops.                                                       |
| S4  | Can prompt audio be downloaded read-only?                              | Assets download and hash. Signed-URL lifetime measured. Total asset bytes for the sandbox org recorded.                                                                 |
| S5  | What is the true minimum permission set?                               | Start from zero roles and add one capability at a time. Produces a reviewed read-only role with no mutation, secret, or caller-data permission.                         |
| S6  | What are realistic scale budgets?                                      | Per-flow latency, memory, request count, and bundle size measured, then extrapolated to 100 / 300 / 500 flows.                                                          |
| S7  | What happens when a flow is republished mid-capture?                   | The stale version is detected and never promoted as current.                                                                                                            |
| S8  | Does one conservative STDIO server work across clients?                | The core smoke matrix from `docs/09-testing-strategy.md` passes in pinned Claude Code, Cursor, Codex, and Kimi.                                                         |
| S9  | Can hostile source content escape into logs, paths, or prompts?        | The canary corpus and adversarial fixtures stay contained; the workflow completes or fails safely.                                                                      |
| S10 | Can the renderer be packaged and shipped?                              | Playwright Chromium runs from the distributed package on all three operating systems, or an alternative is chosen and recorded.                                         |

## S1 in detail — the spike everything else waits on

Four candidate source paths. Run each against the **same** 6-10 sandbox flows spanning inbound call, in-queue, common module, bot, and one digital type.

| Path                    | Mechanism                                                                                                                                 |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Platform API            | `GET /api/v2/flows/{flowId}/versions/{versionId}/configuration`, `GET /api/v2/flows/{flowId}/latestconfiguration`                         |
| Archy CLI               | `archy export --flowName <name> --flowType <type> --exportType yaml`, authenticated per `archy setup` with `authTokenIsClientCredentials` |
| Architect Scripting SDK | `getFlowInfoAsync`, `loadAsync`, `traverse`, `exportToObjectAsync`                                                                        |
| Manual YAML             | Operator export from the Architect UI with tracking IDs enabled — also the comparison baseline                                            |

Score each on:

1. **Structural fidelity** against the manual UI YAML baseline. Containers, nodes, edge labels, expressions, variables, dependencies, prompts, error paths, tracking IDs. Every difference must be explained, not tolerated.
2. **Permission footprint** — the minimum role each path needs. A path requiring any mutation permission is disqualified unless a security exception is approved explicitly.
3. **Archy-importable YAML** — does the output round-trip? This determines whether the migration story is real.
4. **Stability** across SDK or CLI versions.
5. **Packaging cost** — can it ship inside a signed internal package?

Only these were verified from Genesys documentation during design: the two Platform API endpoints above, `POST /api/v2/flows/jobs`, `GET /api/v2/flows/jobs/{jobId}`, and the Archy export flags. Response shapes, permission requirements, and whether `/configuration` returns inline JSON or a signed download URL are all unverified. **Verify every signature against the installed SDK and the current API Explorer. Never hand-code an endpoint from a design document.**

## Kill criteria

The ten in `docs/08-failure-analysis.md`, plus two added by this design:

11. **Prompt audio cannot be downloaded with read-only permissions.** The bundle is then documentation-grade, not migration-grade. Say so plainly in the README and in the bundle manifest. Do not claim migration readiness.
12. **No source path produces Archy-importable YAML.** The migration story degrades to "structured export, importer unknown." Record it. Do not imply a migration path exists.

If a kill criterion is met, stop and write a decision report. Do not engineer around it.

## Decision record template

Copy per spike into `docs/spikes/S<N>-<slug>.md`.

```text
Spike:
Decision:
Date / owner:
Environment and versions:
Hypothesis:
Method:
Evidence:                 sanitized; point at spike-evidence/ paths, never paste raw
Result:
Security / permission impact:
Architecture change:
Remaining uncertainty:
Go / conditional go / no-go:
```
