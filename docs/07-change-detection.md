# 07 — Change Detection and Documentation Updates

## Goal

Keep documentation current without reprocessing every flow, erasing review history, or equating timestamps with meaningful change.

## Manifest strategy

Each flow documentation directory contains a manifest with:

- Organization, flow, and selected-version identity.
- Discovery metadata observed at run time.
- Source, normalized graph, evidence pack, template, and document hashes.
- Adapter, SDK, analyzer, redactor, and generator versions.
- Completeness and warning summary.
- AI processing mode and review status.
- Prior manifest/document reference.

The run manifest contains the full plan and per-flow results. See `schemas/run-manifest.schema.json`.

## Detection algorithm

1. Discover current flow descriptors.
2. Match by stable organization ID and flow ID.
3. Compare selected version/publication metadata against the last manifest.
4. If metadata is identical and no generator/policy rebuild is required, skip extraction.
5. If metadata changed or is ambiguous, load and normalize the selected source.
6. Compare canonical graph hash.
7. If graph hash is unchanged, record metadata-only change and optionally refresh the banner.
8. If graph hash changed, run semantic diff and regenerate affected documents.
9. Validate and atomically promote the new set.

## Semantic diff categories

- Flow metadata changed.
- Entry point or start container changed.
- Menu choice added, removed, relabeled, or rerouted.
- Action added, removed, moved, or materially reconfigured.
- Condition/expression changed.
- Variable added, removed, type-changed, or read/write location changed.
- Prompt/language reference changed.
- Queue/flow/schedule/data-action dependency changed.
- Success/failure/timeout/no-input/no-match path changed.
- Published version changed without semantic graph change.
- Unsupported/opaque source coverage changed.

Movement is not considered semantic if stable tracking IDs and relationships prove behavior is unchanged.

## Review classification

| Change class | Example | Default review |
| --- | --- | --- |
| Cosmetic | Description or display label only | Light review |
| Documentation-only | Template or wording update | Automated plus spot check |
| Behavioral | Menu route, decision, queue, schedule, error path | Human review required |
| Dependency | Data action or integration reference | Engineer review required |
| Security-sensitive | Secure-flow marker, redaction, auth-related dependency | Security/lead review |
| Coverage regression | Previously supported node becomes opaque | Block approval |

## Deleted, renamed, and inaccessible flows

- Rename: stable ID retains history and output identity; display name and slug may update with a redirect/index record.
- Deleted: mark `retired` after confirmation on a later discovery run; archive documentation. Do not delete automatically.
- Permission loss: mark `inaccessible`, not deleted.
- Division move: preserve stable identity and record the move.
- Duplicate name: never merge.
- Recreated flow with same name but new ID: treat as a new flow and link only through human review.

## Draft drift

When policy permits visibility of checked-in/working versions, report drift separately:

- Caller-visible documentation remains tied to published version.
- A prominent section says a newer non-published version exists.
- Do not publish business claims from a draft as current behavior.
- A later publication closes the drift and triggers a normal semantic update.

## Generator and policy changes

A rebuild can occur without a source change when:

- Snapshot schema changes.
- Normalization bug is fixed.
- Redaction policy changes.
- Analyzer or template changes materially.
- AI prompt/model policy changes.

The manifest records `rebuildReason` and separates source diffs from generated-output diffs.

## Scheduling

The CLI, not MCP, owns scheduled/headless operation.

Recommended progression:

1. Manual pilot runs.
2. Scheduled local run that only plans/reports changes.
3. Scheduled deterministic generation into a branch.
4. Pull request with semantic change report.
5. Optional approved narrative generation.

Do not automatically merge customer documentation updates into a protected branch.

## Consistency and race control

- A plan records the selected version for every flow.
- Before promotion, re-check version metadata.
- If the selected version changed mid-run, mark the flow stale and replan; do not promote mixed results.
- Acquire an organization/output lock for promotion.
- Each staged flow is independently complete; partial run success may be promoted only if policy allows and the run report clearly lists failures.

## Recovery

- Persist completion after every flow.
- Resume only with the same plan hash, policy, generator version, and organization identity.
- Revalidate access tokens and selected versions on resume.
- Preserve failed staged artifacts for a configured diagnostic period, after redaction.
- A repair command can rebuild indexes from per-flow manifests.

## Freshness presentation

Every generated document begins with:

- Organization and flow identity.
- Selected version/publication state.
- Source observation and generation times.
- Review state.
- Completeness/warning status.
- Link to the latest change report.

If the tool cannot validate freshness, the document must say `Freshness unknown`; it must not display a green/current badge.
