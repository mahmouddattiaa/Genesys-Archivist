# @genesys-archivist/cli

## What it does

The `archivist` CLI. Secure profile provisioning, diagnostics, capture, documentation, and headless sync. Owns everything that must never be an MCP tool argument.

## Commands

```text
archivist doctor
archivist capture --mode <context|migration> --org <organizationId> [--flow <flowId>...] [--flow-type <flowType>...] [--profile <profileId>]
archivist verify   --bundle <dir>
archivist document --bundle <dir>
```

`--mode` is required and has no default — a mistyped value (`--mode migraton`) is rejected outright rather than silently falling back to `context`. Run `archivist capture --help` for the full explanation of what each mode does and does not capture; the short version, from [ADR-018](../../docs/adr/ADR-018-capture-modes.md):

- **`context`** — fast, safe to run across a whole organization routinely. Captures flow definitions and the resource manifest (names, ids) that already travels with them, at no extra cost. Never fetches resource bodies, prompt audio, or data-table rows. **A context bundle cannot be migrated.**
- **`migration`** — slower and much larger. Walks every referenced resource to full depth and downloads prompt audio and data-table rows, so the sealed bundle is sufficient on its own to rebuild these flows elsewhere.

Omit `--flow` to capture every flow in the organization (optionally narrowed by `--flow-type`). Give one or more `--flow` to capture only those flows. `--flow` and `--flow-type` cannot be combined — the underlying capture scope is one or the other, never both.

No command accepts a credential as a flag. `profile add` is deliberately CLI-only and prompts interactively; it is not part of this command surface, and no flag anywhere in the tree matches `secret`, `password`, `token`, or `credential` (enforced by a test in `test/bin.test.ts`).

### Exit codes

| Code | Meaning                                                                                                                                                                       |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | Success.                                                                                                                                                                      |
| `1`  | Failure — bad arguments, a capture that failed or was cancelled, a bundle that does not verify, or `doctor` reporting a hard failure.                                         |
| `2`  | The capture completed, but with warnings — the bundle may be incomplete. Distinct from `0` so a script can tell "worked" from "worked but incomplete" without parsing output. |

### Status

`doctor` is fully wired to real checks. `capture`, `verify`, and `document` are fully implemented and tested against injected dependencies (see `test/bin.test.ts`), but their production wiring is pending:

- `verify` needs `@genesys-archivist/composition` to re-export `verifyBundle` from `@genesys-archivist/capture` — apps may not import that package directly (see `eslint.config.mjs`).
- `capture` needs the same for `runCapture`/`resumeCapture`, plus a production `GenesysSourceProvider`, which does not exist yet (Phase 0 has not selected a source path — see `CLAUDE.md`).
- `document --bundle <dir>` needs an orchestrator that does not exist anywhere yet: something that reads every flow out of a bundle directory and calls the existing single-flow `runDocument` (composition) once per flow.

Running any of the three today fails loudly with a message naming exactly what is missing, rather than silently doing nothing.

## Depends on

- `@genesys-archivist/domain`
- `@genesys-archivist/application`
- `@genesys-archivist/composition`
- `@genesys-archivist/security`
- `commander`

## Rules

See `AGENTS.md` for non-negotiable boundaries and `docs/superpowers/specs/2026-08-20-genesys-archivist-design.md` section 4.2 for the dependency direction this package must respect. The direction is enforced by ESLint, not by convention.
