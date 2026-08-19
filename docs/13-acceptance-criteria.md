# 13 — Acceptance Criteria and Release Gates

## Product acceptance

- [ ] Target product and supported regions are documented.
- [ ] An employee can provision a profile without entering a secret into chat.
- [ ] The tool verifies organization identity before listing/extracting flows.
- [ ] All visible flows are discovered across pagination.
- [ ] Published versions are selected consistently.
- [ ] A supported flow produces business, technical, manifest, analysis, and change artifacts.
- [ ] Unchanged flows are skipped.
- [ ] Changed flows produce a semantic diff.
- [ ] Renamed, deleted, and inaccessible flows follow documented behavior.
- [ ] Last good output survives every tested run failure.

## Source fidelity gate

- [ ] Official SDK methods and versions are recorded.
- [ ] Exact read-only permission matrix is approved.
- [ ] Representative SDK export/traversal matches manual YAML structure.
- [ ] Supported-node coverage meets the approved threshold.
- [ ] Every unsupported or opaque object is visible.
- [ ] No undocumented production endpoint is used.
- [ ] No mutation method is reachable from the production adapter.

## Documentation quality gate

- [ ] Technical facts trace to evidence.
- [ ] Business inferences are labeled with confidence and review state.
- [ ] Unknowns and unresolved dependencies are visible.
- [ ] Every document identifies organization, flow ID, selected version, freshness, completeness, and generator version.
- [ ] Diagrams are valid or gracefully omitted.
- [ ] Markdown and internal links validate.
- [ ] Identical inputs produce deterministic factual output.
- [ ] Pilot reviewers can explain the main caller journeys from the output.

## Security gate

- [ ] No password, client secret, access token, authorization header, secure value, or integration credential appears in output, logs, errors, caches, fixtures, or MCP transcripts.
- [ ] Secret canary suite passes.
- [ ] Prompt-injection corpus passes.
- [ ] Path traversal and symlink tests pass.
- [ ] Cross-tenant profile mismatch stops before extraction.
- [ ] Customer workspaces/caches are isolated.
- [ ] AI data-processing mode is approved and recorded.
- [ ] Dependency scan and SBOM review have no unapproved critical issue.
- [ ] Release artifact is signed/provenanced according to IST policy.

## Reliability gate

- [ ] Pagination, timeout, retry, rate-limit, token-expiry, and partial-permission tests pass.
- [ ] Jobs persist, cancel, and resume safely.
- [ ] Concurrency and output locks prevent collision.
- [ ] Mid-run flow republish is detected before promotion.
- [ ] Disk, permission, process-crash, and corrupt-manifest fault tests preserve last good output.
- [ ] Retry budgets prevent infinite loops.

## MCP/client gate

- [ ] STDIO stdout contains protocol traffic only.
- [ ] Tool and result schemas pass validation.
- [ ] Full sources are not inlined into tool results.
- [ ] Long runs use plan/start/status rather than one blocking call.
- [ ] The same build completes the core smoke scenario in pinned Claude Code, Cursor, Codex, and Kimi versions claimed as supported.
- [ ] Client-specific optional features are not required for the core workflow.
- [ ] One-time client configuration instructions contain no Genesys secret.

## Operations gate

- [ ] `doctor` identifies common setup faults safely.
- [ ] Structured logs and audit records contain correlation/run/flow identity without secrets.
- [ ] Runbook covers auth, permissions, rate limits, SDK regressions, promotion failure, and suspected leaks.
- [ ] Retention, backup, deletion, and customer classification policies have owners.
- [ ] Update, canary, and rollback procedures are tested.
- [ ] Pilot correction/support metrics are reviewed.

## Release decision

Release requires named approval from:

- Product/practice owner.
- Genesys technical owner.
- Security/data owner.
- Operations/support owner.

Any unmet kill criterion in `08-failure-analysis.md` overrides the checklist and blocks release.
