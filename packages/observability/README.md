# @genesys-archivist/observability

## What it does

Structured JSON logging with redaction, audit records, and metrics collection. No credential, token, or raw flow source may reach a log line.

## Depends on

- `@genesys-archivist/domain`

## Rules

See `AGENTS.md` for non-negotiable boundaries and `docs/superpowers/specs/2026-08-20-genesys-archivist-design.md` section 4.2 for the dependency direction this package must respect. The direction is enforced by ESLint, not by convention.
