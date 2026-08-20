# S1 Preliminary — Architect YAML structure

Findings from a real Architect YAML export of an inbound call flow (515 lines) supplied on 2026-08-20. This is S1 evidence arriving ahead of the spike: it does not replace the four-path comparison, but it settles several questions the design had left open and it changes one architectural decision.

Resource names are generalized here. The raw export is customer configuration and is gitignored, never committed.

## Finding 1 — YAML references resources by NAME, not by stable ID

The most consequential finding. Every outward reference in the export is a display name:

```yaml
targetQueue:
  lit:
    name: <queue-name> # no GUID anywhere

category:
  <integration-name>: # the integration, by name
    dataAction:
      '<data-action-name>': # the action, by name
        inputs: ...
```

`docs/04-domain-model.md` is unambiguous: _"Dependency identity: resource type plus stable Genesys ID"_ and _"Deduplicate by stable ID, never by name."_ A YAML export cannot satisfy that. It also cannot distinguish two same-named queues in different divisions, which `docs/02` explicitly requires.

**This changes the source-path decision.** S1 was framed as "score four candidate paths and pick one." That framing is wrong. The correct architecture is:

| Source                                      | Supplies                                                                |
| ------------------------------------------- | ----------------------------------------------------------------------- |
| Architect YAML (via Archy or manual export) | Flow structure, logic, expressions, menu topology, inline audio         |
| Platform API                                | Stable IDs, divisions, versions, and resolution of every name to a GUID |

They are **complementary, not alternatives.** Neither alone produces a migration-grade bundle: YAML has the logic but no identity, the Platform API has identity but not the full authored structure. The capture pipeline must run both and join them on name-within-scope.

That join is now the risky part of the design, because a name collision across divisions is the one case where it can silently mis-resolve. S1 must test exactly that case.

## Finding 2 — `refId` exists only on containers, not on actions

Ten `refId` values across roughly fifty actions. They appear on `menu` and `task` containers; individual actions such as `playAudio`, `decision`, `transferToAcd`, and `disconnect` carry none.

Node identity therefore falls through to the derived-ID path for the large majority of nodes. `deriveNodeId` from Plan 1 Task 3 is load-bearing, not an edge case — which is fortunate, because it is already implemented and property-tested for stability under sibling reordering.

References between containers use a typed path with a bracketed `refId`:

```text
/inboundCall/tasks/task[Call Entry_10]
/inboundCall/menus/menu[Caller Main Menu_17]
```

This maps cleanly onto the `containerPath` array already in `FlowSnapshot`.

## Finding 3 — values are a discriminated union the domain model does not yet have

Every settable value in the export is wrapped in exactly one of five forms:

| Wrapper         | Meaning                                          | Count in this flow |
| --------------- | ------------------------------------------------ | ------------------ |
| `lit`           | Literal constant                                 | 32                 |
| `noValue: true` | Explicitly unset — distinct from absent          | 64                 |
| `tts`           | Inline text-to-speech, the caller-facing wording | 16                 |
| `exp`           | Expression, evaluated at runtime                 | 5                  |
| `var`           | Binds an output into a variable                  | several            |

`noValue: true` being the most common wrapper matters: it is an _explicit_ unset, semantically different from a missing key, and flattening the two would lose information a migration tool needs.

**Action required:** add a `ValueRef` discriminated union to `packages/domain`. Without it the normalizer will flatten `lit` and `exp` into strings and lose the distinction between a constant and a runtime expression — which is precisely the distinction the technical document must show.

## Finding 4 — this flow has zero prompt resources, so it cannot validate S4

All sixteen audio sources are inline `tts:`. There are no user-prompt references and exactly one system prompt reference. **There is no audio file to download.**

Consequences:

- **S4 cannot be validated against this flow.** Kill criterion 11 asks whether prompt audio downloads under a read-only role; a flow with no recorded prompts cannot answer it. S4 needs a flow that uses recorded user prompts.
- Inline TTS text _is_ the caller-facing wording, and belongs in `business.md` verbatim. It is business content, not a technical detail.
- For migration, TTS text travels inside the flow definition and needs no asset handling at all. A bundle whose flows are all TTS is migration-complete without any binary assets, and `migrationReadiness.assetsCaptured` should reflect that honestly rather than reporting a gap.

## Finding 5 — the analyzer would have caught a real defect in this flow

Variable read and write counts across the whole export:

| Variable                       | Read in an expression | Written | Verdict                                                                    |
| ------------------------------ | --------------------: | ------: | -------------------------------------------------------------------------- |
| `Flow.hasComplaint`            |                     1 |   **0** | Gates a decision; initial value `false`; **that branch can never execute** |
| `Flow.complaintResolutionDate` |                     1 |   **0** | Callers would hear the literal placeholder initial value                   |
| `Flow.isVIP`                   |                     0 |       0 | Declared, never used                                                       |
| `Flow.isBlocked`               |                     0 |       0 | Declared, never used                                                       |
| `Task.user_type`               |                     2 |       1 | The only variable that actually works                                      |

The VIP and blocked-caller logic runs entirely off `Task.user_type`, populated by the data action. The four `Flow.*` variables are vestigial stubs — their descriptions even say `STUB: ... Set from a Data Action` — and no action ever sets them.

So **the complaints branch of this IVR is unreachable**, and a caller with an open complaint would never be routed as intended.

This is exactly the finding `packages/analysis` is specified to produce: a variable read in a decision condition but written nowhere makes that branch statically dead. It is also exactly the kind of thing that is invisible in the Architect UI and expensive to discover by hand. It validates the analysis layer more convincingly than any synthetic fixture could.

## Finding 6 — the data action contract exposes the PII surface

The single data action keys on the caller's ANI and returns roughly ten fields from a records system, including full name, email address, and mobile number.

The documentation must record **that these fields flow through the IVR**, because a business reader and a security reviewer both need to know it. It must never record field _values_ — Archivist reads configuration only and never touches runtime or caller data, so this falls out of the design rather than requiring a new control.

The redactor's job here is narrow and already specified: keep the endpoint and the input/output mapping, keep `${...}` placeholders, never request the integration's credentials.

## Impact on the plans

| Change                                                                                                           | Where                                              |
| ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Source paths are complementary, not alternatives. S1 becomes "prove the YAML-plus-API join", not "pick a winner" | `docs/spikes/README.md`, ADR-014 when written      |
| Add a `ValueRef` discriminated union (`lit`/`exp`/`var`/`noValue`/`tts`)                                         | New task in `packages/domain`                      |
| Name-to-ID resolution needs an explicit collision test across divisions                                          | S1, and the resource-graph walker in Plan 2 Task 6 |
| S4 needs a different flow — one with recorded prompts                                                            | Phase 0 prerequisites                              |
| A sanitized fixture derived from this export should seed the normalizer tests                                    | Plan 3                                             |

## What this artifact does not settle

It is one flow, of one type, exported one way. It says nothing about whether the Platform API `/configuration` endpoint returns this same shape, whether the Architect Scripting SDK preserves `refId` values, or how bot, digital, and in-queue flows differ. The four-path comparison in S1 still has to run.
