# 05 — Documentation Generation

## Two-layer strategy

Documentation generation has two independent layers:

1. **Deterministic layer:** renders facts, tables, graphs, inventories, paths, warnings, and changes directly from the validated snapshot and analysis.
2. **Narrative layer:** optionally uses an approved AI model to produce readable business explanations from a bounded redacted evidence pack.

The deterministic layer is mandatory and remains useful if AI access is unavailable or prohibited. A model may improve readability; it must never become the source of truth.

## Per-flow output

### `business.md`

Audience: product managers, operations, customer stakeholders.

Required sections:

1. Document status, flow identity, published version, generation time, and review state.
2. Purpose: source description plus explicitly labeled inference where needed.
3. Supported languages and entry behavior.
4. Caller journeys organized by intent/menu choice.
5. Business rules such as schedules, eligibility decisions, retries, and transfers.
6. External services and operational dependencies at a non-secret level.
7. Failure/customer experience: no input, no match, timeout, service failure, and disconnect behavior.
8. Business risks and unresolved questions.
9. Changes since the previous documented version.
10. Evidence and review notes.

Do not infer revenue, SLA, regulatory meaning, owner, customer segment, or business importance unless supplied by approved metadata.

### `technical.md`

Audience: contact-center engineers and developers.

Required sections:

1. Source identity, exact version, adapter/generator versions, hashes, and completeness.
2. Flow structure and entry points.
3. Menus, tasks, states, reusable elements, and action inventory.
4. Control-flow diagram and branch table.
5. Variables with scope/type/read/write locations.
6. Prompt/language inventory.
7. Queues, schedules, flows, data actions, integrations, and other dependencies.
8. External calls and their success/failure branches without credentials or sensitive payloads.
9. Error, retry, timeout, no-input, and no-match handling.
10. Graph findings: unreachable nodes, cycles, dangling edges, complexity, and unsupported constructs.
11. Semantic change report.
12. Evidence index and known limitations.

### Other artifacts

- `manifest.json` — machine-readable identity and hashes.
- `analysis.json` — deterministic findings.
- `change-log.md` — chronological semantic changes.
- `review.md` — unanswered questions and approvals.
- Diagrams split by menu/task when a whole-flow graph would be unreadable.

## Evidence pack for AI

The model receives a deliberately smaller structure, not raw SDK objects:

- Safe flow metadata.
- Bounded caller-journey facts.
- Business-rule table.
- Sanitized dependency summaries.
- Failure-path summary.
- Semantic change summary.
- Evidence IDs and safe excerpts.
- Explicit unknowns and prohibited claims.

The evidence pack excludes credentials, secure values, authorization headers, integration configurations not required for documentation, raw large payloads, and unrelated tenant data.

## Prompt-injection defense

Flow names, descriptions, prompt text, expressions, and data-action fields may contain arbitrary text. The narrative prompt must state that all such material is data, not instructions. Additionally:

- Use typed fields rather than concatenating raw YAML.
- Delimit every excerpt.
- Strip control characters and markup that can escape delimiters.
- Cap per-field and total sizes.
- Reject tool-call directives, URLs, or instructions introduced by source data when they are not factual content.
- Never let the model choose filesystem paths, profile IDs, organization IDs, or tool permissions.

Prompt wording alone is not sufficient; input shaping and output validation enforce the boundary.

## Narrative output contract

The model returns structured sections:

```json
{
  "sections": [
    {
      "id": "purpose",
      "markdown": "...",
      "claims": [
        {"text": "...", "kind": "inference", "confidence": "medium", "evidenceIds": ["ev_..."]}
      ]
    }
  ],
  "unknowns": [],
  "reviewRequired": true
}
```

The server validates schema, evidence existence, snapshot version, prohibited content, length, and unsupported certainty language. Validation cannot prove all prose true, so the output remains a draft until review.

## Deterministic caller-journey extraction

1. Start from each graph entry point.
2. Collapse structural containers while preserving action identity.
3. Identify intent-producing menu/input nodes.
4. Traverse success and failure branches with cycle guards.
5. Stop at business-relevant terminals: transfer, disconnect, return, external call, or bounded repeated state.
6. Produce path patterns with conditions and evidence.
7. Split complex graphs by reusable task/menu/state.

Never enumerate all paths in a highly branching cyclic graph. Report complexity and representative complete paths.

## Diagram policy

- Use Mermaid flowcharts for caller paths and dependency topology.
- Maximum practical node count per diagram is configurable; default around 30.
- Split by task/menu when the limit is exceeded.
- Use stable short labels and a legend mapping labels to node IDs.
- Escape source text; do not allow Mermaid directives or raw HTML from tenant content.
- Diagram generation failure must not block tabular technical documentation.

## Review workflow

Status lifecycle:

`generated -> automated_validated -> human_review_required -> approved`

A source change makes prior approval stale. Minor non-semantic template rebuilds may retain approval only if organizational policy permits and the manifest records the generator-only change.

## Quality validators

- Markdown parse and internal-link validation.
- Schema validation for manifests and analysis.
- Evidence IDs resolve to the selected snapshot.
- Every referenced node/dependency exists.
- Secret and sensitive-pattern scan.
- No prohibited raw source sections.
- Diagram syntax validation.
- Completeness threshold.
- Business inferences labeled and review status visible.
- Stable deterministic output for identical inputs and versions.

## Data-processing modes

- `deterministic-only`: no customer configuration is sent to an AI provider.
- `interactive-client`: the connected AI sees the approved evidence pack and submits a draft.
- `approved-provider`: the core calls a configured enterprise model endpoint under an approved processing agreement.

The manifest records the mode, provider class, model identifier, prompt/template version, and whether data left the local environment. It never records provider credentials.
