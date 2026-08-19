# 14 — Open Questions and Required Spikes

## Questions for Abdurrahman and IST

These questions do not block reading the architecture, but they block production implementation decisions.

### Platform and access

1. Is the target definitely Genesys Cloud CX Architect, not Genesys Engage/PureConnect?
2. Which Genesys regions must be supported?
3. Can every customer administrator create a dedicated read-only OAuth client?
4. What exact roles/divisions should each client see?
5. Are published flows sufficient, or must documentation cover checked-in and working drafts?
6. Which flow types are mandatory in release 1: inbound call only, or in-queue, outbound, bot, email/message, secure, survey, and workflow too?

### Output and review

7. Where should customer documentation live: private Git repository, SharePoint, Confluence, local package, or another system?
8. Should each customer have a separate repository/workspace?
9. Which languages should documents use?
10. Who approves business interpretations and technical accuracy?
11. How often should updates be checked, and should the tool generate a pull request or only a report?
12. How long should raw snapshots, manifests, and logs be retained?

### AI and security

13. May customer flow configuration be sent to Claude/OpenAI/Kimi or only to an approved enterprise model endpoint?
14. Is deterministic-only documentation acceptable when AI processing is prohibited?
15. May prompt text, data-action names/endpoints, queue names, and flow IDs appear in generated documents?
16. Which secret manager and device-management controls are available on employee machines?
17. Are employees permitted to retain customer configuration locally?
18. Is a remote centrally hosted version desired later, and who would own its operations/security?

### Product scope

19. Does “API key of each flow” mean the stable flow ID/version ID?
20. Is runtime execution/analytics documentation required, or only static Architect configuration?
21. Are diagrams mandatory for every flow?
22. What pilot customer/test organization is safe to use?

## Required technical spikes

### S0 — Package/runtime compatibility

Question: Which current Node LTS and package versions work together?

Test official MCP SDK, Genesys Platform SDK, and Architect Scripting SDK on supported Windows/macOS/Linux targets. Pin results.

Pass: install, authenticate to sandbox, initialize MCP, and package without unsupported runtime behavior.

### S1 — Read-only extraction fidelity

Question: Can the SDK load and export/traverse a full published flow with read-only permissions?

Compare official SDK output with manual Architect YAML export including tracking IDs.

Pass: approved structural-coverage threshold, explained differences, no mutation permission.

### S2 — Flow/version discovery

Question: Can every required flow and published version be identified across pages/divisions?

Pass: counts match an administrator-approved sandbox inventory and duplicate names remain separate.

### S3 — Flow-type matrix

Question: Which flow types and node types can be represented?

Pass: publish a capability matrix with `full`, `partial`, `opaque`, and `unsupported` entries.

### S4 — Permission matrix

Question: What is the true minimum permission set?

Start with no roles and add one capability at a time. Test discovery, source load, export, and dependency resolution separately.

Pass: reviewed read-only role with no secret/mutation/caller-data permissions.

### S5 — Large-flow behavior

Question: What are realistic extraction size, latency, memory, and tool-output constraints?

Pass: budgets established; largest approved fixture completes without raw source in MCP output.

### S6 — Change/freshness race

Question: What happens when a flow is republished during extraction?

Pass: stale version is detected and not promoted as current.

### S7 — Cross-client portability

Question: Does one conservative STDIO server work in the pinned clients?

Pass: core smoke matrix in `09-testing-strategy.md` succeeds.

### S8 — Secret and prompt-injection resistance

Question: Can hostile source content escape into logs, paths, prompts, or actions?

Pass: all canaries/red-team fixtures remain contained and the workflow completes or fails safely.

### S9 — Business-document accuracy

Question: How much business intent can reviewers recover from configuration alone?

Have Genesys engineers and a business owner grade deterministic and AI-assisted drafts blind.

Pass: acceptable correction rate is set by the product owner; unsupported intent becomes an explicit questionnaire, not an invented statement.

## Decision record template

For each spike record:

```text
Decision:
Date/owner:
Environment and versions:
Hypothesis:
Method:
Evidence:
Result:
Security/permission impact:
Architecture change:
Remaining uncertainty:
Go / conditional go / no-go:
```
