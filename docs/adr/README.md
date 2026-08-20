# Architecture Decision Records

Decisions taken during design, with the reasoning that produced them. A new decision that changes any of these gets its own numbered file in this directory and updates the row below.

Source: `docs/superpowers/specs/2026-08-20-genesys-archivist-design.md`, section 14.

| ID      | Decision                                                                                                          | Rationale                                                                                                                                                                                                                                                                                                                                          | Date       |
| ------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| ADR-001 | Two-stage pipeline separated by an immutable capture bundle                                                       | Genesys is the scarce resource: rate limits, a customer tenant, permissions. Every reason to re-render documentation is offline and must cost zero API calls. Migration needs a contract, not a cache.                                                                                                                                             | 2026-08-20 |
| ADR-002 | The capture bundle is a first-class, schema-versioned, retained artifact                                          | It is a product consumed by a second system. The blueprint put the equivalent data in a directory documented as "private machine state, disposable, ignored" — you cannot build a migration product on that.                                                                                                                                       | 2026-08-20 |
| ADR-003 | Four source-path implementations behind one interface; the default is chosen in Phase 0                           | Two officially documented paths (Platform API `/configuration`, Archy CLI) were absent from the blueprint, which assumed the Architect Scripting SDK. The choice is empirical, not architectural.                                                                                                                                                  | 2026-08-20 |
| ADR-004 | Prefer a source path that yields Archy-importable YAML                                                            | Genesys documentation frames YAML export as the format for "version control and cross-organization migration" — precisely the future migration server use case.                                                                                                                                                                                    | 2026-08-20 |
| ADR-005 | Binary assets are content-addressed by SHA-256                                                                    | Deduplicates identical recordings across prompts, and structurally eliminates filename-driven path traversal: a tenant-controlled filename never reaches the filesystem.                                                                                                                                                                           | 2026-08-20 |
| ADR-006 | Resources are stored once at organization level with an explicit reference graph                                  | Makes "which flows use this queue" and "what breaks if we retire this data action" a lookup rather than a text search, and stops a shared queue being duplicated across eighty flows.                                                                                                                                                              | 2026-08-20 |
| ADR-007 | Narration is a resumable work queue, one flow per turn                                                            | The only shape that scales to hundreds of flows inside one agent session. Context cost stays bounded per flow instead of accumulating.                                                                                                                                                                                                             | 2026-08-20 |
| ADR-008 | Playwright Chromium for both Mermaid and PDF, behind swappable interfaces                                         | One dependency serves both needs; a separate typesetting toolchain would still require a renderer for Mermaid. `NullRenderer` preserves the degradation path.                                                                                                                                                                                      | 2026-08-20 |
| ADR-009 | Capture handles all flow types from day one; documentation depth is progressive                                   | Bundles are migration-complete immediately, while documentation quality widens incrementally. Reconciles "all flow types" with a shippable first release.                                                                                                                                                                                          | 2026-08-20 |
| ADR-010 | Product named Genesys Archivist; CLI `archivist`; MCP tools keep the `genesys_` prefix                            | Tool names are read by models for routing, so `genesys_flows_list` is more discoverable than `archivist_flows_list`. Product names are read by people.                                                                                                                                                                                             | 2026-08-20 |
| ADR-011 | npm workspaces rather than pnpm                                                                                   | Zero additional prerequisite on a machine that already has npm 10.9.2. All packages are private and internal, so the stricter resolution pnpm offers buys little here. Revisit if install times or phantom dependencies become a real problem.                                                                                                     | 2026-08-20 |
| ADR-012 | A dedicated `composition` package is the composition root                                                         | `application` may import only `domain`, and `apps/*` may not import adapters. Without a composition package nothing could wire concrete adapters to interfaces. Keeps both apps genuinely thin.                                                                                                                                                    | 2026-08-20 |
| ADR-013 | Primary capture source is `getFlowVersionConfiguration`; Architect YAML is retained as the migration payload only | Spike S3 found the configuration response carries a `manifest` listing every referenced resource with its stable ID and the nodes that reference it. That removes the name-to-ID join S1 identified as the largest risk in capture. YAML stays in the bundle because a migration tool needs an importable artifact, not because anything reads it. | 2026-08-20 |
| ADR-014 | Reverse dependency edges are computed by inverting the manifest graph locally, not requested from Genesys         | `getArchitectDependencytrackingConsumingresources` was not usable, and `postArchitectDependencytrackingBuild` is a mutation we must never hold permission for. Capture already walks every flow, so inversion costs no API calls and depends on no index we cannot refresh.                                                                        | 2026-08-20 |

## Template

```text
# ADR-NNN: <title>

Date:
Status:        proposed | accepted | superseded by ADR-NNN
Deciders:

## Context
What forced a decision. What was unknown.

## Options considered
Each with its trade-off.

## Decision
What was chosen.

## Consequences
What this makes easy. What it makes hard. What it forecloses.
```
