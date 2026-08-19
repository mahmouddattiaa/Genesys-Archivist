# @genesys-archivist/rendering

## What it does

Mermaid to SVG and HTML to PDF. Isolates the headless-browser dependency so the rest of the system never sees it; degrades to a NullRenderer.

## Depends on

- `@genesys-archivist/domain`

## Rules

See `AGENTS.md` for non-negotiable boundaries and `docs/superpowers/specs/2026-08-20-genesys-archivist-design.md` section 4.2 for the dependency direction this package must respect. The direction is enforced by ESLint, not by convention.
