# 00 — Product Brief

## Problem

IST employees need to understand customer Genesys Cloud Architect IVRs without manually opening and documenting each flow. Existing documentation can become stale when a flow is republished, renamed, or structurally changed. Employees also use different AI coding clients, so the extraction capability should not be tied to a single vendor's plugin system.

## Product goal

Provide a read-only tool that can:

1. Connect to an explicitly authorized Genesys Cloud organization.
2. Discover Architect flows and their identifiers and versions.
3. Load the complete configuration of selected published flows.
4. Normalize different flow types into one evidence-linked graph.
5. Produce business and technical documentation for every supported flow.
6. Detect changes and update only affected documents.
7. Expose the workflow to AI clients through MCP while remaining operable from a CLI.
8. Fail visibly when the source is incomplete, unsupported, or unauthorized.

## Primary users

| User                     | Need                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------ |
| Contact-center engineer  | Inspect exact routing, menus, variables, prompts, integrations, and error paths      |
| Practice/product manager | Obtain a business-readable inventory and change summary                              |
| Application developer    | Trace dependencies and understand technical implementation                           |
| Reviewer/auditor         | Verify when documentation was generated, from which version, and with which warnings |
| Platform administrator   | Distribute the tool and control credentials, permissions, and data retention         |

## User journeys

### First-time setup

1. An administrator creates or approves a least-privilege OAuth client in the customer organization.
2. The employee runs a secure CLI setup command and selects the Genesys region.
3. The secret is stored in an approved OS or enterprise secret store; the project keeps only a profile identifier.
4. The employee registers the local MCP server once in Claude Code or another client.
5. `doctor` validates runtime, output permissions, credential retrieval, tenant identity, and required Genesys permissions.

### Initial documentation

1. The AI or employee lists available flows.
2. The tool creates a bounded plan showing flow count, flow types, versions, expected writes, and warnings.
3. The user confirms the plan.
4. The tool extracts, normalizes, analyzes, and stages documents.
5. Validation checks structure, traceability, redaction, completeness, and links.
6. Valid output is atomically promoted; failures preserve the previous output.

### Update documentation

1. The tool compares current flow/version metadata against the previous manifest.
2. Unchanged flows are skipped.
3. Changed flows are re-extracted and semantically diffed.
4. Deleted or inaccessible flows are marked; their documentation is archived, not silently erased.
5. A change report is generated for review.

## Functional scope

### Required

- Multiple connection profiles without exposing secrets.
- Organization and region validation.
- Paginated flow discovery.
- Published-version documentation for inbound call flows first.
- Stable identifiers and semantic hashes.
- Flow graph, variables, prompts, queues, schedules, data actions, reusable objects, and failure paths when present.
- Business and technical Markdown.
- Incremental change detection.
- Local STDIO MCP support.
- CLI diagnostics and non-interactive synchronization.
- Structured logs and run manifests.
- Sanitized fixtures and comprehensive failure testing.

### Later, after validation

- Additional Architect flow types.
- Draft/latest-working-copy documentation.
- Optional approved LLM provider for unattended narrative generation.
- Remote Streamable HTTP MCP deployment with corporate SSO.
- Pull-request automation and centralized reporting.
- Operational/execution data correlation.

### Explicitly out of scope

- Retrieving hidden API keys, client secrets, passwords, or integration credentials.
- Modifying Architect configuration.
- Live call control.
- Caller PII, recordings, transcripts, analytics, or execution histories.
- A general Genesys administration client.
- A public SaaS product.

## Success metrics

| Metric                             | Target for first release                                                    |
| ---------------------------------- | --------------------------------------------------------------------------- |
| Metadata inventory completeness    | 100% of flows visible to the OAuth client                                   |
| Supported-node structural coverage | At least 99% in the approved fixture corpus; no silent omissions            |
| Evidence traceability              | 100% of technical facts and all material business statements                |
| Unchanged-flow skip rate           | 100% when source metadata and canonical hash are unchanged                  |
| Secret leakage tests               | Zero findings                                                               |
| Failed-run effect                  | Last known-good documentation remains intact                                |
| Cross-client contract              | Same build passes selected Claude Code, Cursor, Codex, and Kimi smoke tests |
| Manual correction rate             | Measured during pilot; release target set after baseline                    |

## Assumptions

- The target is Genesys Cloud CX Architect.
- IST has contractual authorization to read and document each selected customer organization.
- A customer administrator can create a read-only OAuth client.
- Generated material is stored in a customer-approved private location.
- The implementing team can obtain a test organization with representative flows.
- AI processing of customer configuration is optional until data-processing approval exists.

## Product principles

- **Evidence before prose:** deterministic source facts are the authority.
- **Read-only by construction:** no mutation methods in the production adapter.
- **Local-first:** avoid central hosting until there is a real organizational need.
- **Portable interface:** MCP is supported, but the domain engine is independent.
- **Visible uncertainty:** unsupported or inferred content is labeled.
- **Incremental and reviewable:** changes produce diffs, not silent regeneration.
