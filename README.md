# Genesys Archivist

Captures Genesys Cloud Architect flows and every resource they depend on, then generates business and technical documentation from that capture.

Two consumers, two guarantees:

| Consumer                                       | Gets                                          | Guarantee                                                                          |
| ---------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------- |
| Humans — engineers, PMs, customers             | Markdown, PDF, and diagrams per flow          | Every technical fact traces to source evidence; inference is labelled as inference |
| Machines — a future, separate migration server | An immutable, schema-versioned capture bundle | Complete enough to rebuild the IVR on another platform, including prompt audio     |

Archivist does not build that migration server. It guarantees the data contract that server will consume.

## Status

**Stage 2 works end to end. Stage 1 works against an injected source provider, but no production Genesys adapter exists yet.**

Phase 0 has run. Spikes S0–S3 all passed, and the source path is settled by measurement rather than assumption: the Platform API configuration endpoint (ADR-015). Plans 1–4 are complete — 408 tests across 48 files, with format, lint, production and test typechecking, and schema validation in `npm run verify`.

What that means concretely: given a flow configuration, the tool already produces `business.md`, `technical.md`, `operations.md`, Mermaid diagrams, SVG, and PDF, every technical claim citing resolvable evidence. It can seal, verify, and re-read a capture bundle. What it cannot yet do is fetch anything from a real Genesys organization — `packages/genesys-source` and `packages/genesys-platform` are empty, and `runCapture` takes its provider by injection.

## Two capture modes

Per [ADR-018](docs/adr/ADR-018-capture-modes.md), capture has two jobs and they are named separately:

```text
archivist capture --mode context   --org <id> [--flow <id>...]
archivist capture --mode migration --org <id> [--flow <id>...]
```

**`context`** captures flow definitions and the resource manifest that arrives with them, so a developer returning to an unfamiliar IVR can re-orient quickly. It does not walk resources to closure or download assets, which makes it fast enough to run across a whole organization routinely.

**`migration`** captures everything needed to rebuild the IVRs elsewhere: every resource body, every byte of prompt audio, data-table rows.

Both produce a bundle. A `context` bundle records `policy.mode: "context"`, reports `migrationReadiness.archyImportableYaml: false`, and carries a caveat saying so in words — it can never be mistaken for a migration-ready one.

## The architecture in one paragraph

Two stages separated by a hard seam. **Stage 1 (capture)** is the only code that talks to Genesys: it discovers every flow of every type, fetches definitions, walks the resource reference graph to closure, downloads binary assets, and seals an immutable content-hashed **capture bundle**. **Stage 2 (document)** opens no sockets — it reads a bundle and produces Markdown, SVG diagrams, and PDF, with AI narration in the middle. Re-rendering documentation therefore costs zero Genesys API calls, and the bundle is a published contract rather than a disposable cache.

```mermaid
flowchart TD
    A["AI client"] -->|MCP STDIO| B["MCP adapter"]
    C["archivist CLI"] --> D["Application service"]
    B --> D
    D --> E["Genesys source provider"]
    E --> F["Genesys Cloud"]
    D --> G["Capture bundle (sealed, immutable)"]
    G --> H["Normalize, analyze, document"]
    H --> I["Markdown + diagrams + PDF"]
    G --> J["Future migration server"]
```

## Getting started

```bash
npm install
npm run verify        # format + lint + typecheck + test + schema validation
```

Then read, in order:

1. **[CLAUDE.md](CLAUDE.md)** — orientation for anyone (human or agent) about to write code here.
2. **[AGENTS.md](AGENTS.md)** — non-negotiable boundaries. Violating one is a release blocker.
3. **[The design spec](docs/superpowers/specs/2026-08-20-genesys-archivist-design.md)** — what is being built and why. Section 2 lists where it departs from the numbered blueprint docs below.
4. **[Plan 1: Foundation](docs/superpowers/plans/2026-08-20-01-foundation.md)** — twelve task-by-task TDD tasks that need no Genesys access.
5. **[Phase 0 spikes](docs/spikes/README.md)** — the go/no-go gate that unblocks everything else.

## Phase 0 was a go/no-go gate, and it passed

Four source paths were in contention — Platform API, the Archy CLI, the Architect Scripting SDK, and manual YAML. Which one won was an empirical result, not an assumption.

Spike S1 measured the Platform API configuration endpoint at 100% structural fidelity against a manually exported Architect YAML baseline: 47 nodes, 10 construct types, zero unexplained differences. It additionally supplies a stable `trackingId` on every node and a manifest of referenced resources with ids and per-node provenance. The Architect Scripting SDK was dropped entirely ([ADR-015](docs/adr/README.md)); it would have supplied a strict subset at a much higher dependency cost.

The permission-matrix spike (S4 in [docs/14](docs/14-open-questions-and-spikes.md)) has **not** run, and it is a release gate: no mutation permission may be reachable from a production adapter. See [docs/spikes/](docs/spikes/README.md).

## Repository layout

```text
apps/cli               archivist CLI
apps/mcp-server        genesys-archivist MCP STDIO server
packages/domain        contracts and DTOs. Pure: no I/O, no SDK types
packages/application   use cases, run state machines, policy
packages/composition   the one place adapters are wired to interfaces
packages/...           adapters, capture, analysis, documentation, rendering, narrative
schemas/               versioned JSON Schema contracts
fixtures/              sanitized test fixtures. Never real customer configuration
docs/                  blueprint, design spec, plans, ADRs, spikes
```

Dependency direction is enforced by ESLint, not by convention: `domain` imports nothing, `application` imports `domain` only, and `apps/*` stay thin.

## Never commit

`bundles/`, `derived/`, `documentation/`, `spike-evidence/`, or any `.wav` / `.mp3`. Capture bundles are classified `restricted` — they contain endpoint URLs, DIDs, routing logic, data-table rows that may hold customer PII, and prompt audio. CI fails the build if any of these are tracked.

## Terminology

The target is **Genesys Cloud CX**, and the IVR authoring product is **Architect**.

A flow has identifiers such as `flowId` and a version. Queues, prompts, data actions, schedules, and reusable flows also have identifiers. **These are not secret API keys.** A Genesys OAuth `client_id` and `client_secret` authenticate the integration and are the only secrets involved. The tool never enumerates hidden secrets, recovers OAuth client secrets, scrapes passwords, or bypasses Genesys permissions.

## Non-goals for the first production release

- Editing, publishing, deleting, or importing Genesys flows
- Recovering or listing customer secrets
- Reading live caller data, recordings, transcripts, or historical execution data
- Query or Q&A tools over captured data
- Remote HTTP hosting, git/PR automation, or a scheduling daemon
- Claiming business intent that cannot be inferred from configuration

## Blueprint documents

The original handoff. Still governing wherever the design spec does not override it.

| File                                                                          | Purpose                                            |
| ----------------------------------------------------------------------------- | -------------------------------------------------- |
| [00-product-brief.md](docs/00-product-brief.md)                               | Product goals, users, assumptions, scope           |
| [01-system-architecture.md](docs/01-system-architecture.md)                   | Components, packages, runtime decisions            |
| [02-genesys-integration.md](docs/02-genesys-integration.md)                   | Authentication, discovery, extraction, versions    |
| [03-mcp-contract.md](docs/03-mcp-contract.md)                                 | MCP tools, resources, prompts, errors, jobs        |
| [04-domain-model.md](docs/04-domain-model.md)                                 | Normalized flow graph, evidence, hashes            |
| [05-documentation-generation.md](docs/05-documentation-generation.md)         | Document generation and grounding                  |
| [06-security-and-compliance.md](docs/06-security-and-compliance.md)           | Credentials, threats, authorization, data controls |
| [07-change-detection.md](docs/07-change-detection.md)                         | Incremental updates, manifests, diffs, review      |
| [08-failure-analysis.md](docs/08-failure-analysis.md)                         | Bottlenecks, FMEA, degradation, kill criteria      |
| [09-testing-strategy.md](docs/09-testing-strategy.md)                         | Unit, integration, contract, security, chaos tests |
| [10-deployment-and-clients.md](docs/10-deployment-and-clients.md)             | Distribution and per-client configuration          |
| [11-observability-and-operations.md](docs/11-observability-and-operations.md) | Logs, metrics, audit, recovery, support            |
| [12-implementation-roadmap.md](docs/12-implementation-roadmap.md)             | Ordered implementation plan                        |
| [13-acceptance-criteria.md](docs/13-acceptance-criteria.md)                   | Definition of done and release gates               |
| [14-open-questions-and-spikes.md](docs/14-open-questions-and-spikes.md)       | Questions for IST and required experiments         |
| [15-sources.md](docs/15-sources.md)                                           | Official sources and research notes                |
