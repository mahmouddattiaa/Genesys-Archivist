# Genesys Archivist — Design

| Field      | Value                                                            |
| ---------- | ---------------------------------------------------------------- |
| Product    | **Genesys Archivist**                                            |
| Status     | Approved for implementation planning                             |
| Date       | 2026-08-20                                                       |
| Owner      | Abdurrahman (IST)                                                |
| Supersedes | Parts of `docs/00`, `docs/02`, `docs/05`, `docs/12` — see §2     |
| Unchanged  | `AGENTS.md` constraints and `docs/06` / `docs/08` remain binding |

## 1. Purpose

Connect to an authorized Genesys Cloud CX organization, capture **every Architect flow and every resource those flows depend on** — including binary audio assets — and turn that capture into enterprise-grade documentation for business and technical readers.

The capture must be complete enough that a **separate, independently built MCP server** can later read it and reproduce those flows on another platform or in another Genesys organization. Archivist does not build that migration server. It guarantees the data contract that server will consume.

Two consumers with different requirements:

| Consumer                               | Needs                                                      | Artifact                                     |
| -------------------------------------- | ---------------------------------------------------------- | -------------------------------------------- |
| Humans — engineers, PMs, customers     | Readable, accurate, evidence-linked explanation            | Documentation set: Markdown + PDF + diagrams |
| Machines — the future migration server | Complete, schema-stable, lossless configuration and assets | Capture bundle                               |

## 2. Delta from the repository blueprint

The 16 documents under `docs/` remain the governing reference. This design changes four things and adds three.

| #   | Blueprint position                                                                                                    | Archivist                                                                                 | Why                                                                                                                         |
| --- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| D1  | Single-pass pipeline: extract → document → promote (`docs/01`)                                                        | **Two stages** separated by an immutable bundle                                           | Genesys is the scarce resource. Every reason to re-render docs is offline. Migration needs a contract, not a cache.         |
| D2  | Architect Scripting SDK is primary; manual YAML the only fallback (`docs/02`)                                         | **Four candidate source paths**, chosen empirically in Phase 0                            | Two officially-documented paths are absent from the blueprint. See §5.1.                                                    |
| D3  | Snapshots live in `.genesys-docs/cache/` — "private machine state, disposable, ignored" (`examples/output-layout.md`) | Capture bundle is a **first-class, schema-versioned, retained output**                    | You cannot build a migration product on a disposable cache.                                                                 |
| D4  | Output is `business.md` + `technical.md` (`docs/05`)                                                                  | Adds `operations.md`, an org-level resource inventory, rendered SVG diagrams, and **PDF** | "Enterprise-grade, serving developers and business" — decided 2026-08-20.                                                   |
| A1  | —                                                                                                                     | **Org-level resource inventory and usage graph**                                          | Blueprint resolves dependencies per flow only. "Which flows use this queue / what breaks if we retire it" was unanswerable. |
| A2  | —                                                                                                                     | **Binary asset capture** — prompt audio, response assets                                  | Required for migration. The blueprint never downloads binaries.                                                             |
| A3  | —                                                                                                                     | **Narrative work-queue tools** for agent-driven narration at org scale                    | The blueprint's `genesys_docs_review_submit` assumes one flow at a time, interactively.                                     |

## 3. Confirmed decisions

Recorded 2026-08-20. Closes questions 1, 6, 7, 13, 17, 19, 20, 21 from `docs/14`.

| Question                             | Decision                                                                                      |
| ------------------------------------ | --------------------------------------------------------------------------------------------- |
| Target platform                      | **Genesys Cloud CX (Architect)** — confirmed                                                  |
| Development environment              | **Sandbox / test organization available now** — Phase 0 unblocked                             |
| Flow types in release 1              | **All Architect flow types**                                                                  |
| Capture depth                        | **Everything**, including binary assets and data-table rows                                   |
| Output destination                   | **Local filesystem, not git-tracked**                                                         |
| Output formats                       | **Markdown + PDF**; SVG diagrams rendered as a prerequisite of PDF                            |
| Credentials                          | **OS credential store** by default; environment variables only under an explicit CI flag      |
| AI processing                        | **Approved and expected.** Default `interactive-client`; `approved-provider` by configuration |
| Query / Q&A tools over captured data | **Out of scope.** Capture and hand off only                                                   |
| Organization scale                   | **Unknown / varies.** Design for hundreds of flows; measure in Phase 0                        |

Still open, tracked in §12.

## 4. Architecture

### 4.1 Two stages, one seam

```text
STAGE 1 · CAPTURE                              network-bound, slow, run rarely
  authenticate -> discover flows (all types, all divisions, all pages)
               -> fetch each flow definition
               -> walk the resource reference graph to closure
               -> download binary assets
               -> seal an immutable, content-hashed bundle

           ============ THE SEAM: capture bundle ============
           schema-versioned - immutable - self-describing
           consumed by Stage 2 AND by the future migration server

STAGE 2 · DOCUMENT                             offline, fast, run repeatedly
  read bundle -> normalize to FlowSnapshot -> analyze graph
              -> render deterministic Markdown
              -> AI narrative (evidence pack -> validated claims)
              -> render diagrams (SVG) -> render PDF
              -> validate -> atomically promote
```

**Stage 2 opens no sockets**, except an optional model endpoint under `approved-provider`. That single property delivers:

- Re-rendering costs zero Genesys API calls. Template changes, prompt improvements, PDF restyles, and new output formats never touch the customer tenant.
- Most of the codebase is testable with bundle fixtures and no network.
- Rate limiting, token expiry, and tenant risk are confined to one stage.
- The two stages resume independently, per flow.

`archivist sync` runs both back to back, so the seam is invisible in daily use.

### 4.2 Package structure

Extends `docs/01`. Three packages are new: `capture`, `rendering`, `narrative`.

```text
apps/
  cli/                  archivist
  mcp-server/           genesys-archivist (MCP server id)
packages/
  domain/               contracts and DTOs. No I/O, no SDK types, no filesystem.
  application/          use cases, run state machines, policy enforcement
  genesys-platform/     Platform API: discovery, resources, assets, pagination
  genesys-source/       flow-definition providers behind one interface (4 impls)
  capture/              STAGE 1: reference walker, asset dedup, bundle writer/sealer
  normalization/        raw source -> FlowSnapshot
  analysis/             traversal, caller journeys, completeness, semantic diff
  documentation/        deterministic Markdown, evidence packs, Mermaid source
  rendering/            Mermaid->SVG, HTML->PDF. Isolates the browser dependency.
  narrative/            evidence-pack builder, narration queue, claim validator
  storage/              bundles, docs, manifests, locks, atomic promotion
  security/             secret resolution, redaction, path safety, classification
  observability/        structured logging, audit records, metrics
  testing/              fakes, fixtures, secret canaries, adversarial corpus
schemas/
fixtures/
```

Dependency rule, enforced by lint: `domain` imports nothing from this repo. `application` imports `domain` only. Adapters import `domain`. `apps/*` import `application` and must not import `genesys-*`, `rendering`, or `narrative` directly.

### 4.3 Deliberately not built

No flow editing, publishing, or import. No caller data, recordings, transcripts, or analytics. No query/Q&A tools. No remote HTTP MCP. No git or PR automation. No scheduling daemon. No migration capability of any kind.

## 5. Stage 1 — Capture

### 5.1 Source path selection

`GenesysSourceProvider` is one interface with four implementations. Phase 0 spike S1 scores them and picks the default; the others remain as the degraded modes `docs/08` already requires.

| Implementation                     | Mechanism                                                                                                         | Verified during design                                         | Notes                                                                                                                                                                                                   |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PlatformApiSourceProvider`        | `GET /api/v2/flows/{flowId}/versions/{versionId}/configuration`; `GET /api/v2/flows/{flowId}/latestconfiguration` | Endpoints confirmed present in Genesys developer documentation | Lightest dependency. Response shape unverified — may be inline JSON or a signed download URL.                                                                                                           |
| `ArchySourceProvider`              | `archy export --flowName <n> --flowType <t> --exportType yaml`; `archy setup`; `authTokenIsClientCredentials`     | CLI, flags, and client-credentials support confirmed           | **Genesys documents YAML export as being for "version control and cross-organization migration"** — exactly our migration case. Costs a subprocess dependency; keys on name+type rather than stable ID. |
| `ArchitectScriptingSourceProvider` | `getFlowInfoAsync`, `loadAsync`, `traverse`, `exportToObjectAsync`                                                | Not verified beyond `docs/15`                                  | The blueprint's assumed path. Heaviest dependency.                                                                                                                                                      |
| `ManualYamlSourceProvider`         | Operator-supplied YAML                                                                                            | n/a                                                            | Fallback. Sets `sourceMode: manual-yaml`; disables freshness claims.                                                                                                                                    |

> **Endpoint discipline.** Every path and signature in this document other than the four endpoints and Archy flags named above is **indicative and unverified**. Per `docs/02` and `docs/15`, the implementation must verify them against the installed SDK and current API Explorer and must never hand-code a stale endpoint from a design document.

Selection criteria in priority order: structural fidelity against a manual UI YAML export with tracking IDs; minimum permission footprint; produces Archy-importable YAML; stability across SDK versions; packaging cost.

### 5.2 Discovery

1. Authenticate with client credentials. Resolve organization identity and compare against the profile's expected organization ID. **Mismatch aborts before any read.**
2. Enumerate divisions; record visibility boundaries.
3. Enumerate flows with an **unfiltered** paginated walk, following pagination to server-reported completion, and let the server report each flow's type. **Never enumerate by a local list of flow types** — spike S2 measured 491 flows that way against 511 from an unfiltered walk, silently missing five types the list did not know existed. A local type list may only cross-check and log drift. Deduplicate by stable ID only. Same-name flows in different divisions stay distinct.
4. Record every version observed per flow, plus published / latest-checked-in / working-copy state.
5. Write `inventory.json`, recording partial visibility explicitly where permissions blocked a division or type.

Default version policy is `published`; configurable per `docs/02`.

### 5.3 Resource reference graph

The core of "pull all the resources." A worklist walk to closure:

```text
seed    <- every flow version in the inventory
repeat
  pop reference R
  if seen(R.type, R.id): record edge only; continue
  fetch R's definition from its resource endpoint
  record node R with resolutionStatus
  extract R's own outward references; enqueue them
  record edge (fromType, fromId, toType, toId, viaNodeId, viaField)
until worklist empty or request budget exhausted
```

The walk follows second-order references, so a flow reaches an integration through a data action, and a language variant's audio through a prompt.

| Category       | Types                                                                                                                                                     |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Routing        | queues, skills, wrap-up codes, languages, utilization labels                                                                                              |
| Architect      | user prompts, system prompt overrides, schedules, schedule groups, emergency groups, IVR configs / DID mappings, grammars, flow outcomes, flow milestones |
| Integration    | data actions (contract, URL template, header template), integrations (name, type, status — never credentials)                                             |
| Data           | data tables (schema **and rows**), response management responses and assets                                                                               |
| Conversational | bot flows, digital bot flows, intents, utterances, slots, knowledge bases                                                                                 |
| Cross-flow     | other Architect flows, common modules, reusable tasks, scripts                                                                                            |
| Directory      | users, groups — identity and display name only, only when referenced                                                                                      |

Every node carries one of the six resolution states from `docs/04`: `resolved`, `partially_resolved`, `not_found`, `forbidden`, `unsupported`, `redacted`. A `forbidden` node keeps its stable ID and type and lowers completeness; it is never silently dropped.

Bounded by a visited set, a per-run request budget, and bounded concurrency. Progress persists after every resolved node, so a cancelled or rate-limited capture resumes without refetching.

### 5.4 Binary asset capture

Prompt audio is the difference between a bundle that documents an IVR and one that can rebuild it.

1. For each prompt, enumerate per-language resources. Capture recorded-audio URIs **and** TTS text — a prompt may use either, and migration must know which.
2. Media URIs are typically signed and short-lived. Download immediately after resolving metadata; on expiry, re-resolve and retry rather than failing the flow.
3. SHA-256 each file. Store as `assets/<sha256>.<ext>`. Identical content is stored once regardless of reference count.
4. `assets/index.json` records `sha256 -> { originalName, mimeType, byteLength, durationMs?, usedBy: [{type, id, language}] }`.
5. **A tenant-supplied filename never influences a path on disk.** It survives only as a string inside the index. This eliminates filename-driven path traversal structurally rather than by validation.
6. A failed asset download is a warning against its prompt, degrades completeness, and does not fail the flow or the run.

Response management assets and any other referenced binary get the same treatment.

### 5.5 Bundle layout

```text
bundles/<orgId>/<captureId>/
  bundle-manifest.json       the contract: schema version, content hash, policy,
                             coverage, counts, tool versions, classification
  organization.json          org identity, region, divisions, visibility notes
  inventory.json             every flow discovered: id, type, division, versions
  resource-graph.json        org-wide nodes and edges, both directions
  capture-report.json        coverage, warnings, unresolved refs, timings, budgets

  resources/                 org-level, stored ONCE, referenced by stable id
    queues/<id>.json                 skills/<id>.json
    prompts/<id>.json                system-prompts/<id>.json
    schedules/<id>.json              schedule-groups/<id>.json
    emergency-groups/<id>.json       ivr-configs/<id>.json
    data-actions/<id>.json           integrations/<id>.json
    data-tables/<id>.json            scripts/<id>.json
    response-assets/<id>.json        grammars/<id>.json
    wrapup-codes/<id>.json           languages/<id>.json
    flow-outcomes/<id>.json          flow-milestones/<id>.json
    knowledge-bases/<id>.json        users/<id>.json
    groups/<id>.json                 call-routes/<id>.json

  assets/
    index.json               sha256 -> { originalName, mime, bytes, usedBy[] }
    <sha256>.wav  <sha256>.mp3  <sha256>.<ext>

  flows/<flowId>/
    flow.json                metadata, every version observed
    versions/<versionId>/
      definition.yaml        Archy-compatible YAML - the migration payload
      definition.raw.json    verbatim provider response - fidelity and debugging
      references.json        this flow's outward edges into resources/
```

Normalized snapshots and evidence are **not** in the bundle. The bundle is sealed at the end of Stage 1 and never written to again; normalization is Stage 2 work and its output would break the seal. Derived artifacts live beside the bundle, keyed by the capture they came from:

```text
derived/<orgId>/<captureId>/
  flows/<flowId>/versions/<versionId>/
    snapshot.json            normalized FlowSnapshot, schema 1.1
    evidence.json
```

`FlowSnapshot.source.captureId` points back at the bundle it was derived from, so a snapshot can always be re-derived and checked against a sealed, verifiable original. Deleting `derived/` is safe — it rebuilds from the bundle with no network access.

Contractual properties, not incidental ones:

- **Immutable.** Each capture writes a new `<captureId>` directory and moves a `latest.json` pointer. Nothing is edited in place, so a partial capture can never be mistaken for a complete one, and two captures diff directly.
- **Resources stored once.** A queue referenced by 80 flows appears once; `resource-graph.json` holds the 80 edges. Otherwise "which flows use this queue" degrades to a text search and the bundle bloats.
- **Both YAML and raw JSON retained per version.** YAML is what migration imports. Raw is what proves the exporter lost nothing. Keeping only one costs either portability or provability.
- **Sealed with a content hash** over canonicalized content, excluding volatile fields (signed URLs, extraction timestamps), recorded in `bundle-manifest.json`. `archivist bundle verify` recomputes it.
- **Classified `restricted`** — see §9.1.

### 5.6 Capture run state machine

```text
planned -> queued -> discovering -> fetching_definitions -> walking_resources
        -> downloading_assets -> sealing
        -> completed | completed_with_warnings | failed | cancelled
```

Progress persists after every flow and every resolved resource. Resume requires the same plan hash, policy, organization identity, and tool version. Cancellation leaves a resumable manifest and removes only disposable staging.

## 6. Stage 2 — Documentation

### 6.1 Normalize and analyze

Bundle -> `FlowSnapshot` (schema **1.1**, §8) -> analysis.

Normalization per `docs/04`: stable node identity preferring Genesys tracking ID, then source ID, then a deterministic derived ID from canonical container path and type — never array index. Unsupported constructs are preserved as nodes with `supportLevel: unsupported` and an evidence pointer.

Analysis produces reachability, strongly connected components with cycle annotations, bounded caller journeys, a variable read/write index, dependency resolution summary, complexity metrics, a completeness report, and — where a prior manifest exists — a semantic diff classified by the categories in `docs/07`.

### 6.2 Output layout

```text
documentation/<orgSlug>/
  README.md
  index.md                          org overview, inventory, freshness
  Organization-Overview.pdf
  changes/<date>-<runId>.md
  resources/
    inventory.md                    every resource, type, and where used
    orphans.md                      captured but referenced by no flow
    dids.md                         DID -> flow routing table
    Resource-Inventory.pdf
  flows/<flowId>--<slug>/
    business.md
    technical.md
    operations.md
    change-log.md
    review.md
    evidence-index.md
    analysis.json
    manifest.json
    diagrams/
      01-overview.mmd  01-overview.svg
      02-menu-<name>.mmd  .svg
      03-task-<name>.mmd  .svg
      04-error-paths.mmd  .svg
      05-dependencies.mmd  .svg
    <Flow-Name>.pdf                 cover + TOC + all sections + diagrams
```

Directory identity is the stable flow ID with a slug appended for navigation. Renames change the slug, never the ID.

### 6.3 The three per-flow documents

**`business.md`** — product, operations, customer stakeholders. Sections per `docs/05`: status header, purpose, languages and entry behaviour, caller journeys by intent, business rules, external services at a non-secret level, failure and customer-experience behaviour, risks and open questions, changes since last version, evidence and review notes.

**`technical.md`** — contact-centre engineers and developers. Sections per `docs/05`: source identity and hashes, structure and entry points, action inventory, control-flow diagrams and branch table, variables with scope and read/write locations, prompt and language inventory, dependencies, external calls with success and failure branches, error and retry handling, graph findings, semantic change report, evidence index and limitations.

**`operations.md`** — _new._ Whoever is on call. This is where org-wide capture pays off:

- Inbound DIDs and call routes that reach this flow
- Every resource this flow depends on, with resolution status
- Every flow that depends on **this** flow
- Blast radius: what breaks if a named queue, data action, schedule, or prompt is retired
- Failure-path summary: no-input, no-match, timeout, data-action failure, disconnect
- Schedule and emergency-group behaviour, with the calendar effect stated plainly
- Known coverage gaps and unresolved references

### 6.4 Diagrams

Mermaid source generated deterministically, rendered to SVG. Node cap defaults to 30 per diagram with automatic splitting by menu, task, or container. Stable short labels with a legend mapping label to node ID. All tenant-controlled text is escaped; Mermaid directives and raw HTML originating in tenant content are stripped.

Diagram rendering failure must not block tabular documentation — Markdown and `.mmd` source still ship, and the manifest records `renderingDegraded: true`.

### 6.5 Rendering and PDF

`packages/rendering` exposes `MermaidRenderer` and `PdfRenderer`, with a `NullRenderer` for tests and for when the browser is unavailable.

Recommended implementation: **Playwright Chromium** serving both — Mermaid to SVG, then Markdown -> themed HTML -> PDF. One browser dependency covers both needs; a separate typesetting toolchain would still require a renderer for Mermaid. Packaging cost (~150–300 MB) is a Phase 0 decision recorded in the ADR log.

PDF composition: cover page carrying organization, flow identity, documented version, source-observed and generated timestamps, completeness, review state, and a classification banner; table of contents; business -> technical -> operations; embedded diagrams; evidence index; change log. Every page footer carries `RESTRICTED — <Customer> Genesys configuration`.

### 6.6 AI narrative

Default mode `interactive-client`: the connected MCP agent narrates. `approved-provider` uses a configured enterprise endpoint. Both share the same evidence-pack builder and validator. `deterministic-only` remains available and is what runs if narration is disabled or fails.

The narration loop is a **work queue**, which is what makes agent-driven narration viable at hundreds of flows:

```text
agent -> genesys_narrative_next({ runId })
      <- { flowId, evidencePack, narrationToken, remaining: 147 }
agent -> genesys_narrative_submit({ runId, flowId, narrationToken, sections, unknowns })
      <- { ok: true } | { ok: false, error: { failedClaims: [...] } }
   ... repeat until next returns { done: true }
```

The agent holds one flow at a time. Context cost is bounded per flow and does not accumulate. A crashed or abandoned session leaves the queue resumable.

**Evidence pack** — what the model receives. Never raw definitions: safe flow metadata, bounded caller-journey facts, a business-rule table, sanitized dependency summaries, a failure-path summary, a semantic change summary, evidence IDs with safe excerpts, and an explicit list of unknowns and prohibited claims. Size-capped per field and in total; oversized packs are exposed as an MCP resource rather than inlined.

**Validation on submit.** Rejection is structured; the agent may retry a bounded number of times before the flow falls back to deterministic-only with a recorded warning.

- JSON Schema conformance of the narrative contract
- Every cited `evidenceId` exists in that flow's snapshot evidence set
- `fact` and `derived` claims must cite at least one evidence ID; `inference` claims must carry a confidence level; `unknown` claims assert nothing
- Forbidden-pattern scan: secret-shaped strings, absolute filesystem paths, URLs absent from the evidence pack, tool-call syntax, instruction-like directives
- Per-section and total size caps
- Snapshot freshness — the pack must have been built from the current snapshot hash
- Unsupported certainty language on `inference` claims is rejected

Narrative output is always staged as a **draft requiring human review**. `docs/05`'s lifecycle applies: `generated -> automated_validated -> human_review_required -> approved`.

### 6.7 Documentation run state machine

```text
planned -> queued -> normalizing -> analyzing -> rendering_markdown -> narrating
        -> rendering_diagrams -> rendering_pdf -> validating -> promoting
        -> completed | completed_with_warnings | failed | cancelled
```

Staged under a run-specific directory, validated, then promoted by atomic rename with a recovery journal for platforms where directory replacement is not atomic. **A failed run leaves the previous documentation set untouched** — a release gate, not a best effort.

## 7. Interfaces

### 7.1 MCP contract

STDIO only, official MCP SDK. Protocol messages on stdout through the SDK alone; logs to stderr or files. No network listener.

Twelve tools. **No tool accepts a credential in any field.** Every tool returns the envelope defined in `docs/03`.

| Tool                       | Stage | Effect         | Purpose                                                                      |
| -------------------------- | ----- | -------------- | ---------------------------------------------------------------------------- |
| `genesys_profiles_list`    | —     | read-only      | Safe profile metadata. Never client IDs, secrets, or tokens                  |
| `genesys_connection_check` | —     | read-only      | Validate profile, resolve org identity, report missing permission categories |
| `genesys_flows_list`       | 1     | read-only      | Paginated flow descriptors with continuation token                           |
| `genesys_capture_plan`     | 1     | read-only      | Immutable, expiring, content-addressed plan with hash                        |
| `genesys_capture_start`    | 1     | writes locally | Start a capture run from plan ID + exact plan hash                           |
| `genesys_bundles_list`     | 2     | read-only      | Available bundles with coverage and freshness summary                        |
| `genesys_docs_plan`        | 2     | read-only      | Plan a documentation run from a bundle                                       |
| `genesys_docs_start`       | 2     | writes locally | Start a documentation run                                                    |
| `genesys_run_status`       | both  | read-only      | Status, phase, counts, bounded errors, resource URIs                         |
| `genesys_run_cancel`       | both  | idempotent     | Cooperative cancel. Never deletes previous good output                       |
| `genesys_narrative_next`   | 2     | read-only      | Next evidence pack from the narration queue                                  |
| `genesys_narrative_submit` | 2     | writes locally | Submit narrative sections for validation and staging                         |

Tools that write local files say so in their descriptions. Read-only against Genesys is **not** the same as harmless.

Resources:

```text
genesys-archivist://bundles/{captureId}/manifest
genesys-archivist://bundles/{captureId}/inventory
genesys-archivist://bundles/{captureId}/resource-graph
genesys-archivist://bundles/{captureId}/flows/{flowId}/versions/{versionId}/snapshot
genesys-archivist://bundles/{captureId}/flows/{flowId}/versions/{versionId}/evidence
genesys-archivist://docs/{orgSlug}/flows/{flowId}/{business|technical|operations}
genesys-archivist://runs/{runId}/{report|errors}
genesys-archivist://narrative/{runId}/{flowId}/evidence-pack
```

Prompts (optional conveniences, never required for correctness): `document_organization`, `review_flow_business_summary`, `explain_flow_change`. Each delimits source content, labels it untrusted, requires evidence IDs, and forbids treating flow content as instructions.

Output-size policy per `docs/03`: summaries under 32 KiB, lists paginated, large content via resources, **no raw flow definition ever inlined in a tool result**.

The first release must not require elicitation, sampling, tasks, or server-initiated notifications.

### 7.2 CLI

```text
archivist doctor
archivist profile add | list | check | remove
archivist flows list
archivist capture plan | start
archivist bundle list | inspect | verify
archivist document plan | start
archivist sync                     # capture + document
archivist run status | cancel | resume
archivist diff <captureA> <captureB>
archivist support-bundle
```

`profile add` is **CLI-only and never an MCP tool** — tool arguments are chat-visible and client-logged.

## 8. Schemas

Independently versioned per `docs/01`.

| Schema                           | Version | Status                                                                                                  |
| -------------------------------- | ------- | ------------------------------------------------------------------------------------------------------- |
| `flow-snapshot.schema.json`      | 1.1     | Existing, extended: widened `flow.type` for all Architect types, asset references, `captureId` backlink |
| `run-manifest.schema.json`       | 1.1     | Existing, extended: `stage` discriminator, new states for both machines                                 |
| `capture-bundle.schema.json`     | 1.0     | **New.** The contract the migration server codes against                                                |
| `resource-graph.schema.json`     | 1.0     | **New.** Nodes are resources and flows; edges are typed references                                      |
| `evidence-pack.schema.json`      | 1.0     | **New.** What the model receives                                                                        |
| `narrative-contract.schema.json` | 1.0     | **New.** What the model returns and what the validator enforces                                         |

## 9. Security

All of `AGENTS.md` and `docs/06` carries forward. Three areas need additions specific to this design.

### 9.1 The bundle is more sensitive than the documentation

It holds endpoint URLs, header templates, internal hostnames, DIDs, full routing logic, **data-table rows that may contain customer PII**, and audio. Controls:

- `classification: restricted` in `bundle-manifest.json`, propagated to the PDF footer of anything derived from it.
- Written only under the canonical approved output root, verified after symlink resolution.
- Capture **refuses to write into a git work tree** unless `--allow-git-worktree` is passed, and writes a `.gitignore` containing `*` into the bundles root on creation.
- Data-table rows are captured, counted, and flagged `containsCustomerData: true` per table and rolled up in the manifest.
- Support bundles never include bundle content.

### 9.2 Credentials

OS credential store by default (Windows Credential Manager on the current target). Environment variables accepted only when an explicit CI/headless flag is set. Access tokens live in memory only. No credential appears in any tool argument, log, manifest, snapshot, document, exception, or telemetry field.

Integration credentials are **never requested**. Header templates containing literal secret-shaped values are redacted deterministically to `[REDACTED:header-value]`; `${...}` placeholders are preserved because migration needs them.

### 9.3 Path safety and injection

Resource files are named by stable ID sanitized to `[A-Za-z0-9._-]`. Assets are named by SHA-256. Flow directories are named by ID plus a derived slug where the ID is authoritative. Tenant-controlled text never determines a path.

Every extracted string is untrusted data. Typed evidence packs, delimiting, stripped control characters, size caps, and output validation — prompt wording alone is not a control.

## 10. Phase 0

Ten spikes. Throwaway code in a sandbox, not production architecture.

| ID  | Question                                                               | Pass condition                                                                                                                                 |
| --- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| S0  | Which Node LTS and package versions work together?                     | Install, authenticate, initialize MCP, render a PDF, and package on Windows/macOS/Linux. Versions pinned.                                      |
| S1  | Which of the four source paths gives best fidelity at least privilege? | Scored comparison against manual UI YAML with tracking IDs across 6–10 flows spanning types. Differences explained. Winner recorded as an ADR. |
| S2  | Can every flow and version be discovered?                              | Counts match an administrator-approved sandbox inventory across types, divisions, and pages. Duplicate names stay separate.                    |
| S3  | Does the resource walk reach closure read-only?                        | Every referenced type either resolves or returns an explicit `forbidden`/`unsupported` state. No silent drops.                                 |
| S4  | Can prompt audio be downloaded read-only?                              | Assets download and hash. Signed-URL TTL measured. Total bytes for the sandbox org recorded.                                                   |
| S5  | What is the true minimum permission set?                               | Start from zero roles, add one capability at a time. Reviewed read-only role with no mutation, secret, or caller-data permission.              |
| S6  | What are realistic scale budgets?                                      | Per-flow latency, memory, request counts, and bundle size measured; extrapolated to 100/300/500 flows.                                         |
| S7  | What happens on republish mid-capture?                                 | Stale version detected and not promoted as current.                                                                                            |
| S8  | Does one conservative STDIO server work across clients?                | Core smoke matrix from `docs/09` passes in pinned Claude Code, Cursor, Codex, and Kimi.                                                        |
| S9  | Can hostile source content escape?                                     | Canary corpus and adversarial fixtures contained; workflow completes or fails safely.                                                          |
| S10 | Can the renderer be packaged?                                          | Playwright Chromium works from the distributed package on all three OSes, or an alternative is chosen.                                         |

**Kill criteria** — the ten in `docs/08`, plus two:

11. Prompt audio cannot be downloaded with read-only permissions. The bundle is then documentation-grade, not migration-grade. Say so plainly; do not claim migration readiness.
12. No source path produces Archy-importable YAML. The migration story degrades to "structured export, importer unknown." Record it; do not imply a migration path exists.

## 11. Testing

Everything in `docs/09` applies. Additions specific to this design:

- **Bundle schema conformance** for every fixture bundle.
- **Seal / verify round trip**, including deliberate tamper detection.
- **Asset dedup:** N prompts sharing one recording produce one file and N index entries.
- **Resource graph closure:** every reference either resolves or carries an explicit non-resolved state. Silent drops fail the suite.
- **Stage 2 determinism:** the same bundle and versions produce byte-identical Markdown, with timestamps normalized in test mode.
- **Bundle-as-fixture:** the entire Stage 2 suite runs with no network available.
- **Narrative validator adversarial corpus:** fabricated evidence IDs, injected instructions, oversized sections, certainty language on inferences, URLs absent from the pack.
- **PDF:** renders, carries TOC, embeds diagrams, shows the classification footer. `NullRenderer` path degrades cleanly to Markdown.
- **Canary corpus extended** to bundle files, asset index, resource JSON, the PDF text layer, and SVG content.

## 12. Release scope

The split that reconciles "all flow types" with a shippable first release:

- **Capture handles all Architect flow types from day one.** Capture is largely type-agnostic — enumerate, fetch definition, walk references, download assets. Bundles are migration-complete immediately.
- **Documentation depth is progressive.** Full depth for `inboundcall`, `inqueuecall`, and `commonmodule`. Structural depth for the rest: nodes preserved and typed, marked `partial`/`opaque`, generic templates, no hand-tuned journey extraction. Release 2 widens.

Release 1 milestones, mapped onto `docs/12`:

| M   | Deliverable                                                                               |
| --- | ----------------------------------------------------------------------------------------- |
| M0  | Decisions — largely closed by §3                                                          |
| M1  | Phase 0 spikes S0–S10, ADRs recorded                                                      |
| M2  | Monorepo, domain contracts, six schemas, fakes                                            |
| M3  | Secure profiles, `doctor`, redaction, structured logging                                  |
| M4  | Genesys adapters: discovery, chosen source path, resource walker, asset downloader        |
| M5  | Capture stage: bundle writer, sealer, verifier, change detection against the prior bundle |
| M6  | Normalization and analysis, semantic diff                                                 |
| M7  | Deterministic documentation, diagrams, rendering, PDF                                     |
| M8  | Narrative queue and claim validator                                                       |
| M9  | CLI                                                                                       |
| M10 | MCP adapter and cross-client matrix                                                       |
| M11 | Security and chaos hardening, pilot                                                       |

Release 2: full documentation depth for remaining flow types, `approved-provider` narration, packaging and signing, retention and deletion runbooks.

## 13. Open items

Carried from `docs/14`, not blocking the first milestones. Each must be answered before the pilot.

| #   | Question                                                                                         | Working assumption                                                                                        |
| --- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Q2  | Which Genesys regions must be supported?                                                         | Region is a validated enum; sandbox region added first, others by configuration                           |
| Q9  | Which language should documents use?                                                             | English                                                                                                   |
| Q10 | Who approves business interpretation?                                                            | A named IST Genesys engineer plus a business reviewer; narrative stays `human_review_required` until then |
| Q11 | Update cadence?                                                                                  | Manual runs during pilot; no scheduler in release 1                                                       |
| Q12 | Retention for bundles, manifests, logs?                                                          | Retain until the engagement defines otherwise; `restricted` classification applies meanwhile              |
| Q15 | May prompt text, data-action endpoints, queue names, and flow IDs appear in generated documents? | Yes for internal IST use; the redactor removes secrets, not business identifiers                          |
| Q16 | Which secret manager is available on employee machines?                                          | Windows Credential Manager                                                                                |
| Q22 | Which pilot customer or test org is safe?                                                        | The confirmed sandbox org for all development                                                             |

## 14. Decision log

| ID      | Decision                                                                               | Rationale                                                                               |
| ------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| ADR-001 | Two-stage pipeline separated by an immutable bundle                                    | Genesys is the scarce resource; migration needs a contract, not a cache                 |
| ADR-002 | Capture bundle is a first-class, schema-versioned, retained artifact                   | It is a product consumed by a second system                                             |
| ADR-003 | Four source-path implementations behind one interface; default chosen in Phase 0       | Two officially-documented paths were absent from the blueprint; the choice is empirical |
| ADR-004 | Prefer a source path that yields Archy-importable YAML                                 | Genesys documents YAML export as the cross-organization migration format                |
| ADR-005 | Assets content-addressed by SHA-256                                                    | Deduplication plus structural elimination of filename-driven path traversal             |
| ADR-006 | Resources stored once at org level with an explicit reference graph                    | Makes org-wide usage and blast-radius questions a lookup rather than a search           |
| ADR-007 | Narration is a resumable work queue, one flow per turn                                 | The only shape that scales to hundreds of flows in an agent session                     |
| ADR-008 | Playwright Chromium for both Mermaid and PDF, behind swappable interfaces              | One dependency serves both; degradation path preserved                                  |
| ADR-009 | Capture all flow types; documentation depth progressive                                | Migration completeness immediately, documentation depth incrementally                   |
| ADR-010 | Product named Genesys Archivist; CLI `archivist`; MCP tools keep the `genesys_` prefix | Tool names are read by models for routing; product names are read by people             |
