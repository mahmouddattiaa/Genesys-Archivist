# S5 — Prompt audio download

```text
Spike:        Can prompt audio be downloaded with read-only permissions?
Decision:     PASS. Kill criterion 11 is cleared. Migration mode is real.
Date:         2026-08-20
Environment:  purecloud-platform-client-v2, Node v22.15.0, region eu_west_1
Method:       scripts/spike/s5-assets.mjs  (npm run spike:s5)
Result:       GO — with one design constraint that changes resumable capture.
```

> **Numbering.** `docs/spikes/README.md` calls this S4; `docs/14` does not list it
> at all. Filed as S5 because `docs/spikes/S4-permission-matrix.md` already exists
> under the name the rest of the repository uses. See the numbering warning in
> `docs/spikes/README.md`.

This is **kill criterion 11**: if prompt audio could not be downloaded read-only,
the capture bundle would be documentation-grade rather than migration-grade, and
ADR-018's `migration` mode would have to say so in the manifest rather than imply
a migration path that does not exist. `migration` is one of the two things the
product offers, so this was a product question, not an implementation detail.

## Finding 1 — audio is listable and downloadable, read-only

```text
  221 user prompts
1,566 system prompts
2,733 prompt resources total
2,730 carry a media URI   (99.9%)
```

Ten downloaded as a bounded probe. All ten succeeded: `audio/x-wav`, 19–123 KB
each, 417,302 bytes across the ten.

## Finding 2 — the URIs are pre-signed, and that is a security result

Every download was performed with plain `fetch` and **no `Authorization`
header**, deliberately. All ten returned 200.

That means the adapter never carries a bearer token to the media host. The
alternative — a media URI that required the Genesys access token — would have
meant sending a credential to a host chosen by the API response rather than by
us, which is a materially worse story and one that AGENTS.md's first rule would
have forced us to design around. It does not arise.

The corollary is that **a media URI is itself a bearer credential** for the
object it points at. It is therefore treated exactly like a secret: never
logged, never written to the manifest, never included in evidence. The probe
records hashes and byte counts only, and its own fetch-error handler captures
the error _name_ rather than the message, because a `fetch` failure message
contains the full URL.

## Finding 3 — signed URLs expire in about an hour, and that changes resume

Measured lifetime: **3,580–3,584 seconds**, advertised in the URL itself.

This is a real constraint on `resumeCapture`, not a footnote. A capture that
takes longer than an hour — and an organization-wide `migration` capture of 2,730
assets plausibly will — cannot hold a list of media URIs and work through it. Nor
can a run resumed the next morning replay a persisted URI list; every one of
them will have expired.

**Design requirement:** resumable capture must persist the _resource identity_
(prompt id + language) and re-resolve the media URI at download time. It must
never persist the URI. This has the pleasant side effect of being the same rule
the security constraint already demanded, for a different reason.

Retry logic needs the same treatment: a 403 from a media host is an **expired
URL**, not a permission failure, and must be handled by re-resolving rather than
by reporting a permission gap. Those two produce identical status codes and
completely different remediations.

## Finding 4 — bytes are stable across reads

Each URI was downloaded twice and the SHA-256 compared. All ten matched.

Content-addressed asset storage in the bundle depends on this. If the same
logical asset hashed differently on two reads, deduplication would silently
store duplicates and bundle verification would fail on a re-download.

## Finding 5 — a first scale number

At an observed mean of ~41 KB per resource, 2,730 resources extrapolates to
**roughly 110 MB of audio** for this sandbox organization alone. That is the
first measured input to the scale-budget spike, and it is large enough that
`migration` mode needs an explicit asset budget and a resumable download queue
rather than a loop.

`context` mode captures no assets at all (ADR-018), which this number retroactively
justifies: the fast mode stays fast because it never touches these 110 MB.

## Evidence

`spike-evidence/s5-assets.json` — per-download byte counts, MIME types, content
hashes, stability results, and signed-URL lifetimes. **Media URIs are
deliberately omitted from the evidence file**; a signed URL is a bearer
credential. Gitignored regardless.

## Follow-up

- [ ] The bounded probe covered 10 of 2,730 resources. A full-org asset capture
      is still unmeasured for latency, throttling behaviour, and total wall time.
      That belongs to the scale-budget spike.
- [ ] Three resources carry no media URI. Unremarkable — a prompt can exist with
      no audio uploaded for a language — but capture must record them as
      `unsupported`/`missing` rather than skipping them, per AGENTS.md.
- [ ] `resumeCapture` must be checked against Finding 3 before migration mode is
      run against a real organization.
