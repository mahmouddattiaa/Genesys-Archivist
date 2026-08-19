# @genesys-archivist/domain

## What it does

Contracts, DTOs, and domain types. Pure: no I/O, no SDK types, no filesystem, no network. Everything else depends on this; it depends on nothing.

## Depends on

- None. This package is a leaf.

## Rules

See `AGENTS.md` for non-negotiable boundaries and `docs/superpowers/specs/2026-08-20-genesys-archivist-design.md` section 4.2 for the dependency direction this package must respect. The direction is enforced by ESLint, not by convention.
