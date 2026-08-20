# S6 — Scale budgets

```text
Spike:        What are realistic extraction size, latency, memory and request
              budgets, and does an organization-wide capture finish in a time
              a person will wait for?
Decision:     PASS for context mode. Migration mode is bounded by audio, not
              by configuration.
Date:         2026-08-20
Environment:  purecloud-platform-client-v2, Node v22.15.0, region eu_west_1
Method:       scripts/spike/s6-scale.mjs  (npm run spike:s6)
Result:       GO
```

ADR-018 split capture into `context` (fast, whole-org) and `migration`
(everything). "Fast" was a claim. This measures it.

## Finding 1 — the sandbox is a real corpus, not a toy

```text
511 flows   401 with a published version
```

| Type                | Flows | Type           | Flows |
| ------------------- | ----: | -------------- | ----: |
| inboundcall         |   163 | securecall     |    11 |
| inboundshortmessage |    88 | inboundchat    |     3 |
| digitalbot          |    83 | voicesurvey    |     3 |
| bot                 |    59 | commonmodule   |     2 |
| outboundcall        |    29 | inqueueemail   |     2 |
| inqueuecall         |    18 | voicemail      |     1 |
| workflow            |    18 | workitem       |     1 |
| inboundemail        |    16 | speech, survey |     0 |
| inqueueshortmessage |    14 |                |       |

Fifteen populated types. This matters beyond capacity planning: the normalizer's
reference-field knowledge was measured on **one** of the 163 inbound-call flows,
which leaves 348 flows of other types unmeasured. That is what motivated the
sanitized nine-type fixture corpus.

## Finding 2 — discovery is nearly free

**19 requests, 9.0 seconds** for all 511 flows, filtering by type. `pageCount`
was present and correct in every response; an empty `entities` array is the
fallback terminator. Two types returned zero flows, which is a legitimate answer
and must not terminate a discovery loop early.

## Finding 3 — the configuration fetch is fast and small

Measured over 40 flows:

| Metric  |     p50 |     p95 |      max |    mean |
| ------- | ------: | ------: | -------: | ------: |
| latency |  197 ms |  478 ms |   503 ms |  237 ms |
| size    | 17.0 KB | 75.5 KB | 103.7 KB | 25.3 KB |

Manifest size: p50 **5** referenced resources per flow, max 13.

Those 40 were all inbound-call. The fixture corpus shows the tail is much
heavier elsewhere: a bot flow's configuration is **626 KB** and a digital-bot's
is **363 KB**, 6–25× the inbound-call mean. A per-flow memory budget derived
only from IVRs would be wrong by an order of magnitude on the 142 bot and
digital-bot flows.

## Finding 4 — context mode costs one request per flow

Serial, no concurrency, no throttling — the conservative floor, because the real
adapter will run some concurrency and Genesys rate limits will claw some back:

| Flows | Requests | Time             | Configuration bytes |
| ----: | -------: | ---------------- | ------------------: |
|   100 |      100 | ~24 s            |             ~2.4 MB |
|   300 |      300 | ~71 s (1.2 min)  |             ~7.2 MB |
|   500 |      500 | ~119 s (2.0 min) |              ~12 MB |

**The entire 401-flow published estate of this organization captures in roughly
95 seconds and 10 MB.** That is ADR-018's claim, measured.

It costs one request per flow because the configuration response carries the
manifest inline (ADR-013): context mode names every dependency without walking
to closure. Peak heap for the whole measurement process was **34 MB**.

## Finding 5 — migration mode is bounded by audio, not configuration

The S5 prompt-audio spike measured ~110 MB of audio in this organization, across
2,730 resources. Configuration for the same org is ~10 MB.

So `migration` mode is **roughly ten times the bytes and thousands more requests
than `context`**, and essentially all of that is asset download. Combined with
S5's finding that signed URLs expire after ~3,580 seconds, migration mode needs a
resumable download queue with re-resolution, not a loop — a serial download of
2,730 assets will outlive its own URLs.

`context` mode captures no assets at all, which is exactly why it stays fast.

## Remaining uncertainty

- The 40-flow configuration sample was all inbound-call, taken in discovery
  order. Latency and size for bot, digital-bot and workflow flows are known from
  the fixture corpus only as single points, not distributions.
- No concurrency was exercised, so Genesys rate-limit behaviour under parallel
  reads is unmeasured. The adapter's 429 handling is implemented and unit-tested
  but has not met a real 429.
- Full-organization wall time is extrapolated, not run.
- Normalization, analysis and rendering time are not included — this measures
  Stage 1's API cost only.

## Evidence

`spike-evidence/s6-scale.json` — per-flow timings, sizes, manifest type counts,
and the projections. Flow ids are hashed. Gitignored.
