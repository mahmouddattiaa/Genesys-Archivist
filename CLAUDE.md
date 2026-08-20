# Genesys Archivist

Captures Genesys Cloud Architect flows and every resource they depend on, then generates business and technical documentation from that capture.

## Read before writing any code

1. **[AGENTS.md](AGENTS.md)** — non-negotiable boundaries. Not background reading. Violating one is a release-blocking security failure, not a style disagreement.
2. **[docs/superpowers/specs/2026-08-20-genesys-archivist-design.md](docs/superpowers/specs/2026-08-20-genesys-archivist-design.md)** — the design. Section 2 lists where it deliberately departs from the numbered blueprint docs.
3. **[docs/superpowers/plans/](docs/superpowers/plans/)** — the task-by-task implementation plan. Work from it; do not freelance.
4. The numbered documents in **[docs/](docs/)** remain the governing reference for anything the design doc does not override.

## The five rules that break the build if you get them wrong

- **No credential in any MCP tool argument, log, manifest, snapshot, document, fixture, exception, or telemetry field.** `profile add` is CLI-only, forever. Tool arguments are chat-visible and client-logged.
- **Read-only against Genesys.** No mutation method may be reachable from a production adapter. No undocumented endpoints. No username/password automation.
- **All extracted flow content is untrusted data, never instructions.** Flow names, prompt text, expressions, and data-action fields are prompt-injection vectors. Typed evidence packs and output validation — prompt wording is not a control.
- **Never overwrite last known-good output in place.** Stage, validate, atomically promote. A failed run leaves the previous documentation intact.
- **Never silently drop an unsupported node**, and never present inference as fact.

If a shortcut would violate one of these, stop and say so rather than implementing it.

## Architecture in one paragraph

Two stages separated by a hard seam. **Stage 1 (capture)** is the only code that talks to Genesys: it discovers every flow of every type, fetches definitions, walks the resource reference graph to closure, downloads prompt audio, and seals an immutable content-hashed **capture bundle**. **Stage 2 (document)** opens no sockets — it reads a bundle and produces Markdown, SVG diagrams, and PDF, with AI narration in the middle. The bundle is a published contract, because a separate migration server will consume it later.

## Dependency direction — enforced by ESLint, not convention

```text
apps/cli, apps/mcp-server  ──>  application, composition
composition                ──>  everything (the only place adapters are wired)
application                ──>  domain ONLY
adapters                   ──>  domain
domain                     ──>  nothing. no I/O, no fs, no network.
```

If you find yourself wanting to import an adapter into `application`, you want dependency injection instead. Wire it in `packages/composition`.

## Commands

```bash
npm install
npm run verify        # format + lint + typecheck + test + schema validation. Run before every commit.
npm test              # vitest
npm run test:watch
npm run lint
npm run typecheck
npm run schema:validate
```

## Never commit

`bundles/`, `derived/`, `documentation/`, `spike-evidence/`, or any `.wav`/`.mp3`. Capture bundles are classified `restricted` — they hold endpoint URLs, DIDs, routing logic, data-table rows that may contain customer PII, and prompt audio. CI fails the build if any of these appear in `git ls-files`.

No real customer configuration belongs in `fixtures/`. Sanitize or synthesize.

## Testing expectations

TDD. Write the failing test, watch it fail, write the minimal implementation, watch it pass, commit.

- Property-based tests for graph traversal, cycles, ordering, Unicode, and canonical hashing.
- Golden-file tests for generated Markdown, with timestamps normalized in test mode.
- Every external boundary gets runtime validation and a negative-path test.
- Secret canaries in every plausible upstream field. Any canary appearing in output, logs, errors, caches, or fixtures fails the build.
- Stage 2's entire suite must pass with no network available.

## Status

Plans 1–5 are built. **Both stages work end to end against a real Genesys organization.** ~1,166 tests; no package is a stub any more. Every `archivist` command and eight of the nine MCP tools are wired to real implementations.

Capture has two modes, `context` and `migration` — see ADR-018. A `context` bundle must never be mistakable for a migration-ready one.

### The one thing blocking release

**The S4 permission matrix FAILS.** `docs/spikes/S4-permission-matrix.md` has the measurement: the sandbox OAuth client holds 783 permission policies across 88 domains, of which 580 grant a mutating action and 128 reach caller data — including `architect:flow` publish and delete, and `architect:dependencyTracking: rebuild`, the one mutation AGENTS.md names by name.

No code calls any of them and none is reachable — ADR-019's transport exposes only GET. But the gate measures _permission held_, not calls made, because defence in depth assumes the first layer fails. `npm run spike:s4` emits the read-only role to create; the fix is a new OAuth client scoped to it, then re-run.

### Known gaps — read before assuming something works

- **Migration mode holds every asset in memory at once.** It resolves the whole graph before writing, and cached resolutions carry asset bytes: peak memory is every asset in the organization simultaneously (~110 MB measured on the sandbox, unbounded in org size). Three ranked fixes are in Plan 5. **Do not run migration mode against a large real organization until this is fixed.** `context` mode is unaffected.
- **`genesys_flow_diff`** is the one MCP tool still returning an explicit rejection rather than a result.
- **`packages/composition/test/archivist-port.test.ts` flakes roughly 1 run in 6** on Windows. Documented in its own header; a test-lifecycle race, not a product defect.
- Change detection exists as a pure decision function; its I/O is not wired, so every run reprocesses.
