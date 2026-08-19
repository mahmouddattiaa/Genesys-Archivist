# 09 — Testing Strategy

## Testing objective

Prove that the tool is complete enough to trust, fails safely, does not leak secrets, and behaves consistently across supported clients. A happy-path demo is not a production test.

## Test layers

### 1. Domain unit tests

- Stable identity derivation.
- Canonical serialization and hashes.
- Graph traversal with branches, cycles, nested containers, and disconnected nodes.
- Strongly connected components and bounded caller paths.
- Variable read/write indexing.
- Dependency extraction and resolution states.
- Semantic diff classification.
- Completeness calculations.
- Redaction and sensitive-pattern handling.
- Filename/slug generation without path influence.

Use property-based tests for graphs, ordering, Unicode, and canonical hashes.

### 2. Schema and parser tests

- Validate every fixture against source DTO and snapshot schemas.
- Reject oversized/deep/aliased malicious YAML.
- Preserve unknown node types as opaque/unsupported.
- Verify that a parser upgrade does not silently change canonical output.
- Test every supported flow type and language feature.

### 3. Golden documentation tests

For a fixed snapshot, assert exact normalized Markdown for:

- Simple menu IVR.
- Nested reusable task.
- Schedule/closed-hours routing.
- Data action success/failure/timeout.
- No-input/no-match retry loop.
- Multi-language prompts.
- Transfer and disconnect paths.
- Unsupported node and unresolved dependency.
- Semantic version changes.

Normalize generation timestamps in test mode. Review golden changes like code.

### 4. Adapter contract tests

Run against recorded sanitized responses and the installed official SDK:

- Authentication success, rejection, expiry, and regional mismatch.
- Flow pagination and duplicated names.
- Division visibility.
- Published and checked-in version selection.
- Flow load/export/traverse behavior.
- Dependency resolution and permission failures.
- Rate-limit response classification.
- SDK schema drift.

The recorded corpus must not contain real customer data.

### 5. Live Genesys sandbox tests

Use an explicitly approved test organization only. Seed representative flows through normal Genesys mechanisms. Required scenarios:

- At least two pages of flow metadata.
- At least two divisions with different visibility.
- Inbound call flow with menus and retries.
- Data action and queue transfer.
- Reusable task/flow reference.
- Cycle/loop.
- Multiple languages.
- Published version plus newer draft.
- Rename, republish, delete, and permission-loss transitions.
- Very large supported flow.

Compare SDK-derived structure with an Architect UI YAML export containing tracking IDs.

### 6. MCP contract tests

- Initialize and list tools/resources.
- Validate JSON Schema for every input/result.
- Ensure logs never contaminate STDIO protocol output.
- Pagination and continuation tokens.
- Plan expiration, hash mismatch, and idempotent run start.
- Slow run returns immediately with a run ID.
- Cancellation and resume.
- Large source exposed by resources, not inline results.
- All structured error categories.
- Unsupported optional client capabilities do not break core tools.

### 7. Cross-client smoke matrix

Pin the exact tested versions in release evidence.

| Scenario                            | Claude Code | Cursor   | Codex    | Kimi     |
| ----------------------------------- | ----------- | -------- | -------- | -------- |
| Configure local STDIO               | Required    | Required | Required | Required |
| Initialize/list tools               | Required    | Required | Required | Required |
| Connection check                    | Required    | Required | Required | Required |
| Paginated flow list                 | Required    | Required | Required | Required |
| Plan/start/status                   | Required    | Required | Required | Required |
| Read bounded documentation resource | Required    | Required | Required | Required |
| Cancel failed/slow run              | Required    | Required | Required | Required |
| No secret visible in transcript/log | Required    | Required | Required | Required |

Do not mark a client supported based only on successful initialization.

## Security test corpus

Insert unique canary secrets into every plausible location:

- Environment and token fields.
- SDK error body.
- URL query string.
- Data-action configuration.
- Prompt/description/expression.
- Variable default.
- Integration/dependency metadata.
- Filesystem path and exception.

After the run, scan stdout, stderr, log files, manifests, snapshots, Markdown, resources, caches, and test reports. Any canary outside the controlled secret source fails release.

Adversarial source text includes:

- Instructions to ignore system rules.
- Requests to read local files.
- Tool names and fake JSON tool calls.
- Markdown/HTML/Mermaid escaping attempts.
- Paths such as `../../other-customer`.
- Symlink destinations.
- Extremely long text and control characters.

## Fault-injection and chaos tests

Inject failures at every state transition:

- Network disconnect during page 2.
- `429` with and without retry metadata.
- Token expiry between discovery and export.
- One dependency endpoint returning `403`.
- One flow republished during extraction.
- Process termination after staging but before promotion.
- Disk full during Markdown write.
- Permission denied during promotion.
- Lock owner crash.
- Corrupt prior manifest.
- AI provider timeout or invalid schema.

In every case verify run state, retry behavior, audit event, resumability, and preservation of last good output.

## Performance tests

Measure, do not guess:

- Tenant discovery time versus flow count/pages.
- Per-flow SDK load/export time.
- Peak memory for small/median/large flows.
- Normalization and diagram time.
- Cache hit/unchanged skip time.
- Total API requests per flow and per run.
- Tool/result/resource sizes.

Initial budgets are set after Phase 0. A production target might be expressed as percentile SLOs, not one absolute demo time.

## Regression corpus

Every production defect adds a minimal sanitized fixture and negative test. Track the supported node matrix by SDK version and flow type. An SDK upgrade cannot merge until:

- Corpus extraction passes.
- Canonical changes are explained.
- Golden docs are reviewed.
- Security and client smoke tests pass.

## Test environments

- Unit/offline: no network, fake clock/IDs/filesystem.
- Recorded integration: sanitized SDK/HTTP recordings.
- Genesys sandbox: live test tenant, read-only product credentials.
- Client compatibility: isolated workstation/CI images with supported clients.
- Production canary: one approved non-critical customer profile, plan-only first.

Production credentials and customer exports never enter ordinary CI fixtures.
