# 11 — Observability and Operations

## Objectives

Operators must be able to answer:

- Which organization and flow versions were processed?
- What succeeded, failed, retried, or was skipped?
- Is documentation current and complete?
- Did any secret or prohibited data leave the process?
- Which adapter/generator/client versions were involved?
- Can a failed run resume safely?

## Structured logging

Every event includes:

- Timestamp and severity.
- Event name.
- Correlation ID and run ID.
- Safe profile ID and organization ID.
- Flow ID when applicable.
- Pipeline phase and attempt.
- Duration and outcome.
- Sanitized error code/category.

It excludes credentials, tokens, authorization headers, raw request/response bodies, raw flow source, narrative prompt bodies, and uncontrolled file paths.

## Recommended events

- `server.started`, `server.stopped`.
- `profile.validation.started|succeeded|failed`.
- `plan.created|expired|rejected`.
- `run.started|resumed|cancelled|completed|failed`.
- `flow.discovery.page`.
- `flow.extraction.started|succeeded|failed`.
- `flow.normalization.coverage`.
- `dependency.resolution.summary`.
- `rate_limit.wait`.
- `document.validation.failed`.
- `promotion.started|succeeded|rolled_back`.
- `security.secret_detected`, `security.tenant_mismatch`, `security.path_rejected`.

Security events never echo the detected secret.

## Metrics

Local mode may expose metrics in run reports rather than a network endpoint:

- Runs and flows by status.
- Discovery pages/API calls.
- Extraction latency per flow/type.
- Retry and rate-limit waits.
- Snapshot/source sizes and peak memory.
- Supported/partial/opaque/unsupported node counts.
- Unresolved dependencies by reason.
- Documentation validation failures.
- Unchanged skip rate.
- Stale documentation count.
- Narrative generation/validation outcome by mode.

Remote mode exports metrics to approved observability infrastructure with tenant-safe labels.

## Audit records

An append-only audit record captures:

- Actor/process identity available from the local or remote boundary.
- Tool/CLI operation.
- Organization/profile and selected flow IDs.
- Plan hash and run ID.
- Source versions and artifact hashes.
- Policy decisions and data-processing mode.
- Result and review state.

Audit records are not debug logs and have a defined retention policy.

## Health and diagnostics

Health dimensions:

- Runtime and package integrity.
- Secret-store availability.
- Output store safety/access.
- Genesys authentication and tenant binding.
- Discovery permission coverage.
- Architect source adapter capability.
- Lock/run-journal consistency.
- Schema and template availability.
- Optional model-provider policy/connectivity.

MCP initialization should remain fast. Expensive Genesys checks occur through `genesys_connection_check`, not every server startup.

## SLOs

Set numeric SLOs after Phase 0 measurements. Categories:

- MCP initialization latency.
- Connection-check latency.
- Flow-list page latency.
- Documentation-run completion percentile by flow size.
- Successful resume rate.
- Last-good-output preservation rate: 100%.
- Secret leakage: zero tolerance.
- Completeness and freshness targets.

## Operational runbook

### Authentication failure

1. Stop automatic retry after the budget.
2. Confirm profile/region/organization identity without printing the secret.
3. Check client rotation/expiry in the approved admin process.
4. Re-provision secret outside chat.
5. Re-run connection check.

### Permission failure

1. Report missing capability and affected divisions/resources.
2. Do not suggest a broad admin role.
3. Compare against the approved read-only permission matrix.
4. Re-run the least-privilege test after changes.

### Rate limiting

1. Honor upstream delay and reduce concurrency.
2. Persist run progress.
3. If the retry budget expires, stop/resume later.
4. Review actual request counts and dependency expansion.

### Source fidelity regression

1. Quarantine the failing SDK version.
2. Preserve source and sanitized comparison evidence.
3. Re-run the fixture corpus with the previous pinned version.
4. Use manual YAML degraded mode if approved.
5. Do not promote incomplete documentation.

### Failed promotion

1. Keep the last-good directory active.
2. Inspect the run journal and staging validation.
3. Retry only the atomic promotion when preconditions still match.
4. Otherwise create a new plan/run.

### Suspected data leak

1. Stop the process and disable the profile.
2. Preserve redacted audit evidence.
3. Rotate affected credentials.
4. Notify the approved security/engagement contacts.
5. Follow customer contractual incident procedures.

## Backup and recovery

- Generated documentation belongs in approved private source control when possible.
- Run manifests and approved documents are backed up according to engagement policy.
- Raw caches are not the only copy of evidence needed to explain a document; manifests and safe evidence indexes must be sufficient for review.
- Restore tests verify indexes, hashes, and organization boundaries.
- Recovery never merges artifacts from different organizations.
