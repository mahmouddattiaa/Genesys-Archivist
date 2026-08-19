# 12 — Step-by-Step Implementation Roadmap

## Delivery strategy

Build vertical proof slices with go/no-go gates. Do not start with a large MCP tool list or AI prose. The order below removes the highest-risk assumptions first.

## Milestone 0 — Decisions and sandbox

Deliverables:

- Confirm Genesys Cloud CX Architect and supported regions.
- Approved sandbox organization and owner.
- Read-only OAuth client candidate.
- Representative flow corpus.
- Data-classification and AI-processing decision.
- Pinned Node, MCP SDK, Platform SDK, and Architect Scripting SDK candidates.
- Architecture decision log for deviations.

Exit: all blocking organizational questions have owners and dates.

## Milestone 1 — Source extraction spike

Implement throwaway/sandbox code, not production architecture, to prove:

1. Start an Architect Scripting session with client credentials.
2. Discover organization identity.
3. Enumerate flows with pagination.
4. Resolve a published flow version.
5. Use documented SDK capabilities to load it.
6. Export to an object or traverse the object model.
7. Compare it against a manual YAML export with tracking IDs.
8. Repeat across the representative corpus.
9. Record exact permissions and API calls.
10. Measure payload sizes, latency, memory, and request counts.

Exit: all Phase 0 gates in `README.md` pass. Otherwise choose a reduced product outcome.

## Milestone 2 — Monorepo and domain contracts

- Initialize TypeScript workspace and strict configuration.
- Add formatting, linting, test runner, runtime validation, and CI.
- Implement schemas and domain DTOs.
- Create fake source provider, clock, ID generator, filesystem, and secret store.
- Implement canonical serialization and schema-version migration policy.
- Add `FlowSnapshot` property tests.

Exit: fake snapshots validate and serialize deterministically.

## Milestone 3 — Secure profiles and diagnostics

- Profile metadata repository.
- Secret-store interface and approved local implementation.
- Secure CLI prompt for provisioning.
- Region enum and organization binding.
- `doctor`, `profile list`, `profile check` commands.
- Central structured logger and redaction tests.

Exit: canary secrets appear nowhere outside the secret store/process memory.

## Milestone 4 — Production Genesys adapters

- Platform discovery adapter using official SDK.
- Paginated async iteration and retry classification.
- Architect Scripting load/export adapter.
- Read-only method allowlist and static review.
- Dependency resolvers with bounded concurrency.
- Recorded sanitized adapter fixtures.
- Permission coverage report.

Exit: live sandbox contract suite passes and mutation permissions are absent.

## Milestone 5 — Normalization and analysis

- Source DTO validation.
- Node/edge/container normalization.
- Tracking/stable ID strategy.
- Variables, prompts, error paths, and dependency references.
- Redaction/classification.
- Reachability, SCC/cycles, bounded journeys, complexity, and completeness.
- Unsupported-node handling.
- Canonical hashes and semantic diff.

Exit: supported-node matrix meets the approved coverage threshold.

## Milestone 6 — Deterministic documentation

- Per-flow output layout.
- Business fact template and technical template.
- Mermaid-safe diagram renderer and splitting.
- Evidence index and claim links.
- Markdown/link/schema/secret validators.
- Golden fixtures.
- Staging and atomic promotion.

Exit: deterministic docs are useful without any model and identical inputs produce identical meaningful output.

## Milestone 7 — Run planning and updates

- Immutable bounded plan and hash.
- Persisted run state machine.
- Idempotent start, status, cancellation, and resume.
- Version recheck before promotion.
- Per-flow manifests and change logs.
- Rename/delete/inaccessible/draft-drift behavior.
- Output locking and recovery journal.

Exit: every fault-injection point preserves last good output.

## Milestone 8 — CLI product

Commands:

```text
genesys-docs doctor
genesys-docs profile add|list|check
genesys-docs flows list
genesys-docs plan
genesys-docs sync
genesys-docs run status|cancel|resume
genesys-docs diff
genesys-docs support-bundle
```

Destructive cache/profile cleanup commands, if any, require separate approval design and are not MCP tools.

Exit: end-to-end sandbox documentation works without an AI client.

## Milestone 9 — MCP adapter

- STDIO server using official MCP SDK.
- Conservative tools/resources/prompts from `03-mcp-contract.md`.
- Fast initialization and clean stdout.
- Tool/result schemas and error mapping.
- Async job workflow.
- Output-size controls.
- Claude Code first, then remaining client smoke matrix.

Exit: identical plan/run results from CLI and MCP.

## Milestone 10 — Optional grounded AI narrative

Only after approval:

- Bounded evidence-pack builder.
- Provider policy/egress guard.
- Structured narrative schema.
- Claim/evidence validation.
- Adversarial prompt-injection suite.
- Human review lifecycle.
- Deterministic-only fallback.

Exit: narratives cannot bypass evidence, path, tenant, or tool policies and are visibly drafts.

## Milestone 11 — Packaging and pilot

- Signed internal artifact and installer/update policy.
- SBOM, provenance, dependency and secret scans.
- Client setup documents generated from current vendor docs.
- Pilot with a non-critical customer and plan-only first run.
- Manual comparison by a Genesys engineer and business reviewer.
- Record correction rate and support issues.

Exit: release criteria pass and named product/security/operations owners approve.

## Milestone 12 — Production hardening

- Performance budgets and SLOs from pilot data.
- Canary upgrades.
- Scheduled plan/diff and private pull-request workflow.
- Retention/deletion runbooks.
- Incident response exercise.
- Backward-compatible schema migrations.

## Implementation work packages

The implementing agent should create small, reviewable changes in this order:

1. Domain schema and fake provider.
2. Canonical hashing.
3. Secret/redaction framework.
4. Discovery adapter.
5. Source adapter.
6. Normalizer for one inbound-call fixture.
7. Graph analysis.
8. Deterministic technical doc.
9. Business fact doc.
10. Manifest/diff.
11. Run state machine/storage.
12. CLI vertical slice.
13. MCP vertical slice.
14. Additional flow/node coverage.
15. Security/chaos/client hardening.

Do not generate the whole repository in one unreviewed AI change.
