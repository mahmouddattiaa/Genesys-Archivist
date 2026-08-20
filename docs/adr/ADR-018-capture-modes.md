# ADR-018: Two capture modes — `context` and `migration`

Date: 2026-08-20
Status: accepted
Deciders: Abdurrahman (IST)

## Context

The tool has two genuinely different jobs, and until now the design assumed one.

**Understanding.** Developers at IST work across many IVRs and many projects. Coming back to an
IVR after months, a developer needs to re-orient quickly: what does this flow do, what does it
call, where does a caller end up. This wants breadth (every flow in the org) and speed, and it
wants documentation as the deliverable.

**Moving.** A separate migration server will later take a capture and recreate these IVRs on
another platform or in another org. This wants depth: not just that a flow references a queue,
but everything needed to rebuild that queue, plus the prompt audio a caller actually hears. It
is slower and much larger, and it wants the bundle as the deliverable.

Treating these as one operation forces every capture to pay the migration price. Capturing an
organization's prompt audio to answer "what does this IVR do?" is enormously wasteful, and the
wait discourages the frequent, casual use the understanding case depends on.

## What makes the split cheap

Spike S3 established, and `fixtures/flow-config/inboundcall-47-nodes.json` confirms, that
`getFlowVersionConfiguration` returns a `manifest` carrying **`name`, `id`, and per-node
`context`** for every referenced resource — queues, data actions, prompts, TTS engine and voice,
languages. That arrives with the flow definition itself, at no additional request.

So the expensive part of capture is not learning _what_ a flow references. It is fetching each
referenced resource's full body and downloading binary assets. Those bodies are what a migration
needs in order to _recreate_ a resource; they are not what a developer needs in order to
_understand_ a flow.

The two jobs therefore separate along a line that already exists in the data.

## Decision

Capture takes a **mode** and a **scope**.

```text
mode  = 'context' | 'migration'
scope = one named flow, or every flow in an organization (optionally filtered by flow type)
```

|                                                     | `context`                      | `migration` |
| --------------------------------------------------- | ------------------------------ | ----------- |
| Flow definitions                                    | yes                            | yes         |
| Inline resource manifest (ids, names, provenance)   | yes — free with the definition | yes         |
| Resource bodies (reference graph walked to closure) | **no**                         | yes         |
| Prompt audio and other binary assets                | **no**                         | yes         |
| Data-table rows                                     | **no**                         | yes         |
| `business.md` / `technical.md` / `operations.md`    | yes                            | yes         |
| Sealed capture bundle                               | yes, marked as context         | yes         |

Both modes produce a bundle. The bundle is the published contract, and having one artifact shape
means the documentation stage never has to care which mode produced its input.

## The rule that makes this safe

**A `context` bundle must never be mistakable for a `migration` bundle.**

This is the existing "never present an incomplete capture as complete" rule applied to a new
axis, and it is the whole risk of adding modes: someone hands a context bundle to the migration
server, which recreates an IVR whose prompts are silent and whose queues do not exist.

The manifest already carries the machinery. A context capture records
`policy.captureAssets: false` and `policy.captureDataTableRows: false`, and
`migrationReadiness.archyImportableYaml: false` with an explicit entry in
`migrationReadiness.caveats`. A consumer that checks `migrationReadiness` before acting cannot be
fooled by a context bundle, and `verifyBundle` reports the mismatch rather than leaving the
consumer to notice.

Documentation generated from a context bundle must say the same thing in prose: it describes
which resources a flow references, and states plainly that their configuration was not captured
in this mode. That is a fact about the capture, not a limitation to hide.

## Consequences

- `context` is fast enough to run across a whole organization routinely, which is what the
  understanding case needs to be useful at all.
- Documentation quality barely differs between modes for the questions a developer actually asks
  of an unfamiliar IVR, because the manifest supplies the names. What a context document cannot
  answer is a question about a resource's own configuration — queue membership, a data action's
  request contract — and it says so.
- `operations.md`'s blast-radius section still works in context mode: it is computed from
  `referencedByNodeIds`, which comes from the manifest.
- The mode is recorded in the bundle, so a later run can tell whether an existing bundle is
  upgradeable in place or must be recaptured.

## Rejected

**One mode with flags.** `--no-assets --no-data-tables --shallow` expresses the same capture, but
puts the burden of understanding the safety consequence on whoever types the command, and an
omitted flag silently changes what the bundle is fit for. A named mode carries the intent into
the manifest, where a consumer can check it.

**Context mode without a bundle** (documents only). Tempting, since the documents are the point.
Rejected because it creates a second output contract, means a context run cannot later be
upgraded or diffed, and would let the documentation stage receive input that never passed through
sealing and verification.
