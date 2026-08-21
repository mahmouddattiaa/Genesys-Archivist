# Genesys Archivist

**It reads a Genesys Cloud contact-centre configuration and produces documentation a
human can trust and a machine can migrate from — and it is structurally incapable of
changing anything it reads.**

---

## The problem it solves

An organisation's IVR is usually its least-documented, highest-risk asset. The call
flows exist in Architect and nowhere else. The person who built them has moved on. Every
question — _what happens to a caller after hours? which queue does the mortgage option
reach? what breaks if we retire this data action?_ — is answered by somebody clicking
through a flow editor and hoping they remembered every branch.

That costs real money in three places:

- **Change risk.** Nobody can say what a change will affect, so changes get deferred.
- **Migration quotes.** Estimating a platform migration means re-discovering the estate
  by hand, and the estimate is guesswork priced with a large contingency.
- **Onboarding and audit.** Every new engineer, and every compliance request, restarts
  the same archaeology.

Archivist turns that estate into two durable assets: readable documentation, and a
sealed, machine-readable capture of the configuration itself.

---

## What it produces

For **every flow**, per version:

| Output                      | For                                                         |
| --------------------------- | ----------------------------------------------------------- |
| `business.md`               | Non-technical readers — what this IVR does for a caller     |
| `technical.md`              | Engineers — nodes, variables, integrations, routing         |
| `operations.md`             | Support — what to check when it misbehaves                  |
| Mermaid diagrams → SVG      | Call-flow visuals, rendered on request                      |
| `narrative.md` _(optional)_ | AI-written prose, every claim validated against evidence    |
| Capture bundle              | An immutable, content-hashed, schema-versioned machine copy |

Documents are organised per IVR, by name rather than by GUID, so a folder is navigable
by someone who does not already know the estate.

### Every technical claim is traceable

Each statement carries an evidence class — **fact**, **derived**, **inference**, or
**unknown** — with a citation mark back to the source. Inference is never presented as
fact. Where the configuration genuinely does not say, the document says "unknown"
instead of inventing a plausible answer.

---

## Measured on a real organisation

Not projections. These are numbers from live runs against a real Genesys org.

| Measure                                     | Result                                                         |
| ------------------------------------------- | -------------------------------------------------------------- |
| Flows discovered                            | **511** across 15 flow types, 401 published                    |
| Whole-organisation capture                  | **502 flows in ~361 seconds**                                  |
| Re-run with change detection                | **~110 seconds**, 394 flows carried forward                    |
| Re-run output integrity                     | **Byte-identical content hash**                                |
| Broken references found in the customer org | **24** — dangling data actions, queues, data tables, schedules |

That last row is worth pausing on. On its first serious run, the tool surfaced two dozen
references pointing at resources that no longer exist — latent faults nobody had a way
to see before. That is the product finding real defects in a real production estate on
day one.

---

## Security posture — the part that lets it near production

This tool authenticates against a customer's contact-centre platform, so its security
model is the product, not a feature of it.

**It cannot write.** The Genesys adapter reaches the platform over a transport that
exposes only `GET`. Read-only is a property of the type system, not a matter of reviewer
vigilance.

**The credential is minimised and proven.** A dedicated read-only role took the capture
credential from **783 permission policies with 580 mutating grants** down to **16
policies with zero mutating, caller-data, or credential permissions** — while keeping
every endpoint the tool actually calls reachable. A scripted gate re-verifies this on
demand and fails the build if it regresses.

**No credential can reach an AI client.** Secrets are entered on the CLI via stdin or a
hidden prompt — never as a command-line flag, because argv is visible in process
listings and shell history. A test walks every MCP tool's input schema at every depth
and fails on a credential-shaped property name. Secret canaries are planted in upstream
fields and the build fails if one ever appears in output, logs, errors, or caches.

**Extracted content is treated as hostile.** Flow names, prompt text, and expressions
are attacker-controllable and pass through an AI. They are handled as data, never as
instructions, and output is validated structurally rather than trusted because of how a
prompt was worded.

**A failed run never destroys good output.** Every write is staged, validated, then
atomically promoted. If a run fails halfway, yesterday's documentation is still intact
and still correct.

---

## How people use it

**As a CLI**, for scheduled or scripted work:

```bash
archivist profile add --id acme ...        # credentials, CLI-only, forever
archivist doctor                           # environment and credential diagnostics
archivist capture --mode context   ...     # fast, whole-organisation
archivist capture --mode migration ...     # full closure, including prompt audio
archivist document --bundle <dir>          # business + technical + operations + diagrams
archivist render   --bundle <dir>          # draw the diagrams as SVG
archivist verify   --bundle <dir>          # content hashes still match
archivist update                           # pull and rebuild the latest release
```

**As an MCP server**, so an AI assistant can drive it conversationally — "document the
mortgage IVR", "what changed in the main menu", "list every flow that calls this data
action". Nine tools, two resource templates, three prompts, over STDIO with no network
listener.

Provisioning deliberately stays on the CLI and will never be an MCP tool, because tool
arguments are chat-visible and client-logged.

---

## Two capture modes, never confused for each other

- **`context`** — definitions plus the resource manifest that already travels with them.
  Fast enough to run across a whole organisation routinely.
- **`migration`** — everything needed to rebuild the IVRs on another platform: every
  resource body, every byte of prompt audio, data-table rows.

A `context` bundle records its own mode, reports `migrationReadiness: false`, and carries
a caveat in plain words. It can never be mistaken for a migration-ready capture — which
matters, because the migration decision is expensive and irreversible.

---

## Engineering quality

|                          |                                                                                                                                                                        |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Automated tests          | **1,271**, all passing                                                                                                                                                 |
| Gate before any commit   | format + lint + typecheck (production _and_ tests) + full suite + JSON Schema validation                                                                               |
| Architecture enforcement | Dependency direction enforced by lint rules, not convention                                                                                                            |
| Test approach            | TDD; property-based tests for graph traversal, cycles, Unicode and hashing; golden-file tests for generated documents; a negative-path test at every external boundary |
| Offline guarantee        | The entire documentation stage passes with no network available                                                                                                        |

Every architectural decision that could have gone another way is recorded as a numbered
ADR with the evidence behind it. The source path was chosen by measuring four candidates
against a manually exported baseline — **100% structural fidelity, 47 nodes, zero
unexplained differences** — rather than by preference.

---

## What is not done yet

Stated plainly, because a plan built on an overstatement is worse than a shorter plan.

- **Migration mode holds every asset in memory at once.** Fine at pilot scale (~110 MB),
  unbounded in organisation size. It should not be run against a large production org
  until this is fixed. `context` mode is unaffected. Three ranked fixes are designed.
- **One MCP tool** (`genesys_flow_diff`, semantic version comparison) still returns an
  explicit rejection rather than a result.
- **An intermittent status bug.** Roughly one run in a dozen, a run that promoted its
  documents correctly is still _reported_ as failed. Two proven causes were found and
  fixed; a third has not been reproduced under instrumentation. It costs a misleading
  status line, never output — but it is open, not closed.

---

## Where it stands

Both stages work end to end against a real Genesys organisation. Every CLI command and
eight of the nine MCP tools are backed by real implementations — no stubs, no mocked
demo path. The permission gate is closed, the whole-organisation run is measured, and
the capture bundle is a published contract that a future migration server can consume
without renegotiation.

Roughly **sixteen hours** of concentrated development, with the security boundaries
treated as release blockers from the first commit rather than retrofitted.
