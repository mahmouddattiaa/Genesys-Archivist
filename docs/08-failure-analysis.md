# 08 — Failure Analysis, Bottlenecks, and Kill Criteria

## Executive risk statement

The largest product risk is not MCP. It is whether the official Genesys interfaces can load and faithfully represent every required Architect flow version using read-only permissions. The second risk is claiming business meaning that configuration alone cannot prove. The third is handling customer secrets and configuration safely across different AI clients.

## Failure-mode and effects analysis

Scores: severity (S), likelihood (L), and detectability difficulty (D), each 1–5. High values require earlier testing.

| Failure mode | Effect | S | L | D | Detection/test | Mitigation |
| --- | --- | ---: | ---: | ---: | --- | --- |
| Wrong Genesys product assumed | Adapter cannot work | 5 | 2 | 1 | Product/version confirmation | Stop and redesign |
| Flow list API returns metadata only | No full documentation | 5 | 5 | 1 | Phase 0 export spike | Use Architect Scripting; manual YAML fallback |
| SDK cannot load published flow read-only | Core promise fails | 5 | 2 | 2 | Least-privilege tenant test | Kill/renegotiate scope |
| SDK export omits node types | Incorrect docs | 5 | 3 | 3 | UI YAML vs SDK structural diff | Unsupported markers; coverage gate |
| SDK/package regression | Extraction stops after upgrade | 4 | 3 | 2 | Pinned-version contract suite | Pin, canary upgrade, fallback ingestion |
| Region misconfiguration | Auth failure or wrong tenant | 5 | 2 | 1 | Organization identity check | Region enum; tenant binding |
| Division permissions hide flows | False completeness | 5 | 3 | 3 | Compare visible divisions and admin inventory | Visibility warnings; admin review |
| Pagination bug | Missing flows | 5 | 2 | 3 | Multi-page synthetic/integration tests | Async iterator, page invariants |
| Rate limiting | Slow/failed runs | 3 | 4 | 1 | 429 chaos test | Bounded concurrency, Retry-After, resume |
| Access token expires mid-run | Partial extraction | 3 | 3 | 1 | Short-token integration test | Re-auth through SDK; persisted progress |
| Huge flow exhausts memory | Process crash | 4 | 3 | 2 | Oversized fixture/load test | Size budgets, streaming, per-flow process isolation if needed |
| Cycles cause infinite traversal | Hang/overflow | 4 | 3 | 1 | Property tests with cyclic graphs | Visited state, SCC, path limits |
| Dynamic expressions cannot be evaluated | Business behavior unclear | 4 | 5 | 1 | Expression inventory | Document expression; mark runtime-dependent |
| Dependency resolver lacks permission | Missing names/context | 3 | 4 | 1 | Permission matrix test | Preserve IDs and resolution status |
| Same-name resources are merged | Cross-wired docs | 5 | 2 | 2 | Duplicate-name fixtures | Stable IDs only |
| Flow changes during run | Mixed/stale docs | 4 | 3 | 2 | Republish race test | Plan version pin and pre-promotion recheck |
| Source contains a secret | Leakage into docs/model/log | 5 | 3 | 3 | Canary corpus | Layered redaction and provider gate |
| Flow text prompt-injects model | Unsafe actions/false prose | 5 | 3 | 4 | Adversarial prompt corpus | Typed evidence, delimiting, output validation |
| Model invents business intent | Misleading management docs | 4 | 5 | 4 | Claim/evidence review tests | Inference labels, confidence, human review |
| Tool response too large | Client truncates/fails | 3 | 4 | 1 | Large-flow client tests | Resources, pagination, summaries |
| Long MCP call times out | Agent sees failure while job continues | 3 | 4 | 1 | Slow-run test across clients | Async run ID/status tools |
| Client does not support optional MCP feature | Workflow breaks on one client | 3 | 3 | 1 | Compatibility matrix | Conservative core; optional enhancements |
| Secret passed in MCP args | Secret persists in chat logs | 5 | 3 | 1 | Schema negative test | No secret fields; CLI-only provisioning |
| Path traversal/symlink | Writes outside workspace | 5 | 2 | 2 | Security test corpus | Canonical allowlisted root; safe filesystem operations |
| Atomic promotion fails | Corrupt/incomplete docs | 4 | 2 | 2 | Fault-injected filesystem tests | Staging, journal, last-good preservation |
| Concurrent runs collide | Mixed output/manifests | 4 | 3 | 1 | Lock contention test | Per-org/output lock and idempotency |
| Deleted flow is mistaken for permission loss | History wrongly removed | 4 | 3 | 3 | Permission-loss simulation | Inaccessible state; delayed retirement |
| Raw source committed to public repo | Customer breach | 5 | 2 | 2 | Secret/classification CI checks | Private cache ignored; repository guard |
| AI provider violates data policy | Contract/compliance incident | 5 | 2 | 3 | Approval gate and egress test | Deterministic default; provider allowlist |
| Central remote service mixes tenants | Major breach | 5 | 2 | 4 | Tenant isolation security review | Do not ship remote mode prematurely |
| Employee assumes docs are current | Operational error | 4 | 4 | 2 | Stale manifest test | Prominent version/freshness banner |

## Bottlenecks

### 1. Genesys source fidelity

The official Platform API can enumerate flows, but detailed architecture requires the Architect Scripting SDK or an approved export. Flow-type coverage and SDK export stability define the ceiling of the product.

Response: build the source adapter first, prove it against a diverse corpus, and publish a supported-node matrix.

### 2. Business meaning is underdetermined

A graph can show that option 1 transfers to a queue. It may not prove why that queue exists, who owns it, the intended KPI, or whether the route is contractually critical.

Response: facts and inferences are separate, unknowns are prominent, and customer/business-owner review remains part of approval.

### 3. Large flows and AI context

Whole-org or large-flow exports can exceed tool-output and model-context limits.

Response: normalize locally, generate deterministic summaries, expose resources by section, and feed the model bounded evidence packs.

### 4. Cross-client differences

Clients differ in MCP versions, output limits, timeouts, approval UX, and optional feature support.

Response: conservative STDIO tools, asynchronous run pattern, small JSON schemas, and a pinned client compatibility matrix.

### 5. Credential distribution

There is no universal cross-vendor credential store. Requiring every employee to paste customer credentials into AI apps is unacceptable.

Response: local secure profiles provisioned outside chat, ideally by IT; one profile can be reused by every local client through the same installed server process.

### 6. Update ownership

MCP does not schedule itself. Documentation can still become stale if nobody runs or reviews updates.

Response: CLI plan/sync commands, scheduled change detection, and pull-request review are separate operational capabilities.

## Degraded modes

| Condition | Allowed behavior |
| --- | --- |
| AI provider unavailable/prohibited | Produce deterministic technical/business fact documents; skip narrative |
| Dependency permission missing | Keep ID/type, mark unresolved, complete with warning if policy allows |
| One flow fails | Continue other flows; never claim full success; preserve previous version |
| Diagram too complex | Split or omit diagram and retain tables |
| SDK export regression | Use pinned prior version or manual YAML ingestion; stop automatic freshness claim |
| Rate limit reached | Pause/resume within retry budget; otherwise persist and report |
| Draft inaccessible | Document published version and say draft status unavailable |

## Kill criteria

Stop full implementation or release if any remains true after Phase 0:

1. Representative flows cannot be loaded/exported/traversed with approved read-only permissions.
2. More than the approved structural-coverage threshold is missing or untraceable.
3. The SDK requires undocumented internal endpoints for the essential path.
4. The security owner does not approve local storage of customer configuration.
5. The product cannot prevent Genesys credentials from entering chat/tool arguments.
6. Customer configuration would be sent to an unapproved AI provider.
7. Cross-tenant identity cannot be verified before extraction.
8. Generated technical facts cannot be traced to source evidence.
9. Failed runs can overwrite the last known-good documentation.
10. A claimed supported client cannot complete the conservative core tool workflow.

## Decision outcomes if killed

- **Metadata inventory product:** list flows, IDs, versions, divisions, and publication state only.
- **Manual export documentation assistant:** ingest approved YAML exports and generate docs without automatic tenant sync.
- **Genesys-admin-operated exporter:** a privileged customer-side process creates sanitized packages that the MCP tool documents offline.
- **Full platform postponed:** wait for approved API/SDK capabilities or contractual access.

These are legitimate scope reductions, not hidden workarounds.
