# Genesys Archivist

Captures Genesys Cloud Architect flows and every resource they depend on, then generates business and technical documentation from that capture.

**https://github.com/mahmouddattiaa/Genesys-Archivist**

Two consumers, two guarantees:

| Consumer                                       | Gets                                          | Guarantee                                                                          |
| ---------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------- |
| Humans — engineers, PMs, customers             | Markdown, PDF, and diagrams per flow          | Every technical fact traces to source evidence; inference is labelled as inference |
| Machines — a future, separate migration server | An immutable, schema-versioned capture bundle | Complete enough to rebuild the IVR on another platform, including prompt audio     |

Archivist does not build that migration server. It guarantees the data contract that server will consume.

## Status

**Both stages work end to end against a real Genesys organization.** 1,271 tests, with format, lint, production and test typechecking, and schema validation in `npm run verify`.

Plans 1–5 are built. Every `archivist` command is wired: `profile`, `doctor`, `capture`, `document`, `render`, `verify`, and `update`. The MCP server exposes nine tools, eight of them backed by real implementations. The source path was settled by measurement rather than assumption — the Platform API configuration endpoint ([ADR-015](docs/adr/README.md)) — and the adapter reaches it over a transport that exposes only `GET`, so read-only is a property of the type rather than a matter of reviewer attention ([ADR-019](docs/adr/ADR-019-http-transport.md)).

Measured against the pilot sandbox: **511 flows across 15 types, 401 published**.
A whole-organization `context` capture reached **502 flows in ~361 seconds**; re-running
it with `--since-last` carried 394 unchanged flows forward and finished in **~110 seconds**,
producing a byte-identical content hash. Per-request budgets are in
[S6](docs/spikes/S6-scale-budgets.md).

### The permission gate is closed

S4 passes. A dedicated read-only role took the capture credential from 783
permission policies with 580 mutating grants down to **16 policies with zero
mutation, caller-data, or credential permissions** — while keeping every
endpoint the adapter calls reachable. Details, and the four things the exercise
found that reading could not, are in [S4](docs/spikes/S4-permission-matrix.md).

### Known gaps

- **Migration mode holds every asset in memory at once** — ~110 MB on the sandbox, unbounded in organization size. Do not run it against a large real organization yet; `context` mode is unaffected. Three ranked fixes are in [Plan 5](docs/superpowers/plans/2026-08-20-05-production-adapter-and-server.md).
- `genesys_flow_diff` still returns an explicit rejection rather than a result.
- **An intermittent, unexplained run status.** Roughly once in a dozen full-suite
  runs, a run that promoted its documents correctly is still reported `failed`.
  Two proven causes of exactly this were found and fixed — see the note below —
  but an instrumented hunt over eight further full runs did not reproduce a third,
  so it is recorded as open rather than closed. It has not been observed against a
  real organization; it costs a misleading status, never output.

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
npm run build
```

### Point it at an organization

**First time against a new Genesys organisation?** Follow
**[docs/SETUP-GENESYS.md](docs/SETUP-GENESYS.md)** — it walks through creating the
least-privilege read-only role, the OAuth client, and where the credentials go. It also
documents the one step nothing in the Genesys UI hints at: **a new role does not appear
in the OAuth client's role picker until you have added a member to it** via _Change
Membership_. That single omission costs people an hour.

A profile holds the non-secret metadata and names the credential. **The client
secret is read from stdin or a hidden prompt, never from a flag** — argv is
visible in process listings and shell history, so `--client-secret` is refused
with an explanation rather than accepted.

```bash
archivist profile add \
  --id acme --display-name "Acme Bank" \
  --region euw1 --org <organizationId> \
  --client-id <oauthClientId> \
  --output-root /path/to/output
# then paste the secret at the prompt, or:  echo "$SECRET" | archivist profile add ...

archivist doctor                 # Node version, credential store, profiles
archivist profile validate acme  # profile parses, secret present, root writable
```

### Capture and document

```bash
# Fast, whole-organization. Definitions plus the resource manifest that
# already travels with them. Cannot be migrated — see ADR-018.
archivist capture --profile acme --mode context --org <organizationId>

# Everything needed to rebuild elsewhere: resource bodies, prompt audio,
# data-table rows. See the memory caveat above before running this at scale.
archivist capture --profile acme --mode migration --org <organizationId> --flow <flowId>

archivist verify   --bundle <bundleDir>    # content hashes still match
archivist document --bundle <bundleDir>    # business.md, technical.md, operations.md, diagrams
```

`--profile` is required for `capture`, and not merely for convenience: the
profile supplies the approved output root and the `expectedOrganizationId` that
guards against a mistyped credential capturing the wrong customer's
configuration.

### Pictures, on request

`document` writes Mermaid `.mmd` sources in seconds. Drawing them launches a
headless browser and costs roughly eleven renders per flow, so a 502-flow
organization is ~5,500 renders and tens of minutes. Bundling the two would mean
nobody could have the fast one, and a reader who only wants `business.md` would
pay for pictures they never open. So it is a separate step:

```bash
archivist render --bundle <bundleDir>          # draw every .mmd as .svg
archivist render --bundle <bundleDir> --force  # redraw ones already drawn
```

Diagrams that cannot be drawn are **reported, never omitted** — a documentation
set where three diagrams silently failed looks identical to one where they
succeeded, and the reader has no way to tell.

### Narration, opt-in and grounded

Narration is off by default, and a test asserts that a run without it opens no
socket at all. The API key is a credential, so it follows the same rule as the
Genesys secret: CLI-only, stored under a key derived from the profile so it can
never collide with that profile's client secret.

```bash
archivist profile set-narration-key acme      # paste at the prompt, or pipe stdin
archivist document --bundle <bundleDir> --narrate --profile acme
```

Every claim the model produces is re-validated against the evidence pack before
it can reach a document. A claim citing an evidence id that does not exist is
**rejected outright** — never rendered in a weaker form — and the rejection is
counted by reason code in `narrative.md`, because silently dropping it would be
its own kind of dishonesty. Prompt wording is not the control here; the
validator is.

### Keep it current

```bash
archivist update --check    # report only: current commit, how far behind, what would land
archivist update            # pull, reinstall dependencies, rebuild -- prompts first
archivist update --yes      # same, without the confirmation prompt
```

`update` pulls from **https://github.com/mahmouddattiaa/Genesys-Archivist**, reinstalls
dependencies, and rebuilds. It refuses, with a plain statement of what it found, when:

- the working tree is dirty (it lists the paths, never the diff), or
- `origin` does not point at that repository.

That second check is a supply-chain control rather than a tidiness rule: the command runs
`npm install` and a build against whatever it pulls, so it must never do that from a
fork. Clones created before the repository was renamed from `genesys-architect-docs-mcp`
still work — GitHub redirects the old path to the same repository, and both spellings are
accepted.

### Drive it from an AI client

Register the server with your MCP client. Verified working against a real
client over stdio — `npm run smoke:mcp:live` reproduces it.

```json
{
  "mcpServers": {
    "genesys-archivist": {
      "command": "node",
      "args": ["<repo>/apps/mcp-server/dist/bin.js"]
    }
  }
}
```

Use `node` with an absolute path to the built entry point. The `bin` name
`genesys-archivist-mcp` only resolves once the package is installed globally
or linked; a plain `node` invocation always works and is what the smoke test
exercises.

Run `npm run build` first — the client spawns the compiled output, not the
TypeScript sources, and a stale `dist` is the most likely reason a change you
just made appears to have no effect.

Nine tools, two resource templates, three prompts:

| Tool                       | Does                                                                       |
| -------------------------- | -------------------------------------------------------------------------- |
| `genesys_profiles_list`    | Safe profile metadata. Never a client ID, secret, or token.                |
| `genesys_connection_check` | Validates one profile, resolves the organization, reports permission gaps. |
| `genesys_flows_list`       | Paginated flow descriptors, capped, with a continuation cursor.            |
| `genesys_flow_inspect`     | Bounded summary of one flow. Raw source is never inlined.                  |
| `genesys_docs_plan`        | An immutable, expiring plan with a cryptographic hash.                     |
| `genesys_docs_run_start`   | Starts a durable run from a plan; returns a run id immediately.            |
| `genesys_docs_run_get`     | Run state, counts, warnings, result resource URIs.                         |
| `genesys_docs_run_cancel`  | Cooperative and idempotent. Never deletes previous good output.            |
| `genesys_flow_diff`        | Semantic diff between two versions.                                        |

STDIO only: protocol on stdout, everything else on stderr, no network listener.
**No tool accepts a credential** — a test walks every registered input schema
and fails on a credential-shaped property name at any depth, and the smoke test
re-checks it from the client side, against what a client is actually offered.

Provisioning stays on the CLI, permanently. MCP tool arguments are chat-visible
and client-logged, so `profile add` can never live here.

For a non-engineering audience — what this is, what it produced against a real
organisation, and what is not done yet — see
**[docs/PRODUCT-OVERVIEW.md](docs/PRODUCT-OVERVIEW.md)**.

### If you are an AI agent integrating this tool

Read these four, in this order, before running anything:

1. **[docs/SETUP-GENESYS.md](docs/SETUP-GENESYS.md)** — the once-per-organisation admin
   setup. Do not attempt a capture before this is done; every failure mode at that stage
   traces back to it.
2. **[AGENTS.md](AGENTS.md)** — the boundaries you must not cross. In particular: never
   put a credential in a tool argument, and never widen the Genesys role to make a
   permission error go away.
3. This file's **[Status](#status)** and **[Known gaps](#known-gaps)** — what genuinely
   works today versus what is still open. Do not promise a user the migration mode at
   organisation scale; it is not ready.
4. **[docs/PRODUCT-OVERVIEW.md](docs/PRODUCT-OVERVIEW.md)** — for explaining the tool to
   the human you are working for.

Operational notes that are easy to get wrong:

- **`document` does not draw diagrams.** It writes `.mmd` sources in seconds; `render`
  draws them and takes tens of minutes on a large organisation. Offer the second step,
  do not assume it.
- **Narration is opt-in** (`--narrate`) and needs a key stored by
  `archivist profile set-narration-key`. Without it, everything else still works and
  opens no socket.
- **Re-running is cheap.** `--since-last` carried 394 of 502 flows forward on the
  reference organisation and cut a six-minute run to under two.
- **A `context` bundle is not migration-ready** and says so in its own manifest. Never
  present one as sufficient for a platform migration.

Then read, in order:

1. **[CLAUDE.md](CLAUDE.md)** — orientation for anyone (human or agent) about to write code here.
2. **[AGENTS.md](AGENTS.md)** — non-negotiable boundaries. Violating one is a release blocker.
3. **[The design spec](docs/superpowers/specs/2026-08-20-genesys-archivist-design.md)** — what is being built and why. Section 2 lists where it departs from the numbered blueprint docs below.
4. **[Plan 1: Foundation](docs/superpowers/plans/2026-08-20-01-foundation.md)** — twelve task-by-task TDD tasks that need no Genesys access.
5. **[Phase 0 spikes](docs/spikes/README.md)** — the go/no-go gate that unblocks everything else.

## Phase 0 was a go/no-go gate, and it passed

Four source paths were in contention — Platform API, the Archy CLI, the Architect Scripting SDK, and manual YAML. Which one won was an empirical result, not an assumption.

Spike S1 measured the Platform API configuration endpoint at 100% structural fidelity against a manually exported Architect YAML baseline: 47 nodes, 10 construct types, zero unexplained differences. It additionally supplies a stable `trackingId` on every node and a manifest of referenced resources with ids and per-node provenance. The Architect Scripting SDK was dropped entirely ([ADR-015](docs/adr/README.md)); it would have supplied a strict subset at a much higher dependency cost.

The permission-matrix spike has since run and **passed** — see [S4](docs/spikes/S4-permission-matrix.md) and the Status section above. Prompt audio downloads read-only, clearing kill criterion 11 ([S5](docs/spikes/S5-prompt-audio.md)), and scale budgets are measured ([S6](docs/spikes/S6-scale-budgets.md)). Note that two spike-numbering schemes disagree from S3 onward; cite spikes by filename, not number.

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

## Contributing

This project is open to outside development. Fork it, branch, and open a pull request —
every PR is reviewed before merge. **[CONTRIBUTING.md](CONTRIBUTING.md)** covers the
workflow, the five rules that will get a change rejected, the TDD expectations, and a
list of good first contributions drawn from the current known gaps.

You do not need a Genesys organisation to contribute usefully: the documentation stage
and most of capture are testable offline against fixtures.

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
