# S4 — Permission matrix

```text
Spike:        S4 — what is the true minimum permission set?
Decision:     PASS, after remediation. A dedicated read-only role was created
              and the gate now reports zero mutation, caller-data, and secret
              grants, with every endpoint the adapter calls reachable.
Date:         2026-08-20 (FAIL) / 2026-08-21 (PASS after remediation)
Environment:  purecloud-platform-client-v2, Node v22.15.0, region eu_west_1
Method:       scripts/spike/s4-permissions.mjs  (npm run spike:s4)
Result:       GO
```

`docs/14` sets the pass bar at **"a reviewed read-only role with no
secret/mutation/caller-data permissions."** `docs/13` makes it a release gate.
It is not met.

> **Numbering note.** Two indexes disagree. `docs/14-open-questions-and-spikes.md`
> lists ten spikes S0–S9 with **S4 = permission matrix**. `docs/spikes/README.md`
> lists eleven, S0–S10, with **S5 = permission matrix** and S4 = prompt-audio
> download. The spikes actually executed follow the second index — S3 was run as
> reference closure, which is `docs/spikes/README.md`'s S3, not `docs/14`'s
> "flow-type matrix". Everything else in the repository, including `CLAUDE.md`,
> calls this one S4, so this file keeps that name. **The prompt-audio download
> question is unanswered under either numbering** and is tracked as its own item
> in `docs/spikes/README.md`; migration mode's asset capture depends on it.

## Result after remediation — PASS

```text
before:  783 permission policies   580 mutation   128 caller-data
after:    16 permission policies     0 mutation     0 caller-data   0 secret
```

A dedicated `Genesys Archivist (read-only)` role was created and a new OAuth
client scoped to it alone. **14 of 17 probed endpoints reachable, which is 100%
of what the adapter calls.** The three that 403 are diagnostic-only —
`architect/ivrs`, `routing/wrapupcodes` and `telephony/didpools` — and no
shipped code requests any of them during a capture.

Four things this exercise established that no amount of reading would have:

1. **Five permission names in the adapter's own table did not exist.**
   `architect:datatable:viewRow` is really `architect:datatableRow:view`;
   schedules, schedule groups and emergency groups live in the `routing`
   domain, not `architect`; and `architect:ivr` and `routing:language:view`
   do not exist in any form. Found because a human could not locate them in the
   admin UI, then confirmed against the org's own catalogue of 1,728
   permissions via `scripts/spike/list-permissions.mjs`.

2. **A correctly scoped client cannot verify itself.** Reading its own OAuth
   configuration needs `oauth:client:view`, which is credential-adjacent and
   exactly what this gate keeps out. The spike now probes endpoints as the
   restricted client and reads grants with a separate admin credential
   (`GENESYS_ADMIN_CLIENT_*`). The restricted client failing that read is the
   role working, not a defect.

3. **Two violations only appeared under review of a real candidate role**:
   `integrations:actionCertificate` ("View client certificate for actions")
   is credential material that a check matching the literal word "credential"
   waved through, and `architect:flowExecution` exposes real calls while
   sitting inside the `architect` domain the product legitimately needs — so
   the domain-granularity caller-data check could not see it. Both are now
   caught by the gate; both were still present in the first saved role and are
   the reason the second run failed.

4. **Genesys's own metadata is sometimes wrong.**
   `routing:identityResolutionIvr:view` is described by the API as _"Edit
   identity resolution configuration."_ Not a UI glitch — that is what the
   catalogue returns.

## The role that passes

```text
architect:flow:view              architect:datatable:view
architect:userPrompt:view        architect:datatableRow:view
architect:systemPrompt:view      routing:queue:view
routing:schedule:view            routing:emergencyGroup:view
routing:scheduleGroup:view       integrations:integration:view
                                 integrations:action:view
```

`/api/v2/organizations/me` and `/api/v2/languages/{id}` need no permission at
all — both returned 200 under this role, and neither has a catalogue entry.

## Method

Two halves, and only the second is a judgement about the tenant:

1. **Endpoint probes** — call each read endpoint the production adapter needs
   and record reachable/forbidden.
2. **Grant inspection** — read the OAuth client's own roles
   (`GET /api/v2/oauth/clients/{id}`), expand every role's permission policies
   (`GET /api/v2/authorization/roles/{id}`), and judge each policy.

The mutation half is proven by **inspecting grants, never by attempting a
write.** AGENTS.md forbids a mutation being reachable at all, so a probe that
discovered this by trying one would itself be the violation. Grant inspection is
also strictly stronger: it proves the permission is _absent_, not merely that one
particular call happened to fail.

## Finding 1 — every read the adapter needs is reachable

17 of 17 endpoints returned 200: organization identity, flows, IVRs, user and
system prompts, schedules and schedule groups, emergency groups, data tables,
queues, languages, skills, wrap-up codes, integrations, integration actions, DID
pools, and divisions.

**This proves reachability, not minimum permission.** Under a credential that
holds nearly everything, a 200 says nothing about which permission produced it.
The `permission` column in `scripts/spike/s4-permissions.mjs` is therefore the
_expected_ permission, not a measured one. Measuring it is what re-running
against the restricted role does, and that is step two of this spike.

## Finding 2 — the credential is an administrator, and the gate fails on that

```text
2 roles    783 permission policies    88 domains
580 policies grant a mutating action
128 policies grant access to a caller-data domain
  0 policies name a credential-bearing entity
```

The Architect domain alone:

| Policy                                | Granted actions                                              |
| ------------------------------------- | ------------------------------------------------------------ |
| `architect:flow`                      | add, search, view, **unlock, edit, publish, launch, delete** |
| `architect:dependencyTracking`        | **rebuild**, view                                            |
| `architect:datatable`                 | add, search, view, **edit, delete**                          |
| `architect:datatableRow`              | add, view, **edit, delete**                                  |
| `architect:userPrompt`                | add, view, **edit, delete**                                  |
| `architect:systemPrompt`              | view, **edit**                                               |
| `architect:flowInstanceExecutionData` | view, **edit**                                               |

`architect:dependencyTracking: rebuild` is
`postArchitectDependencytrackingBuild` — the one mutation AGENTS.md names
explicitly as never to be held. ADR-014 exists precisely because we decided to
invert the manifest graph locally rather than hold that permission. The
permission is held anyway.

`architect:flow: publish, delete` means this credential can publish or delete a
production IVR.

Outside Architect, the worst of it:

| Policy                     | Granted actions                                                         |
| -------------------------- | ----------------------------------------------------------------------- |
| `authorization:role`       | add, edit, delete                                                       |
| `oauth:client`             | add, edit, delete, authorize                                            |
| `oauth:token`              | delete                                                                  |
| `recording:recording`      | download, access, restore, editRetention, **viewSensitiveData**, delete |
| `externalcontacts:contact` | add, edit, enrich, delete, viewAll                                      |
| `dataprivacy:maskingrule`  | add, edit, **execute**, delete                                          |
| `integrations:action`      | add, edit, **execute**, delete                                          |

`authorization:role: add, edit, delete` means the other 782 policies are not
even a ceiling: the credential can grant itself anything it does not already
have. `recording:viewSensitiveData` reaches call recordings, which is customer
conversation content the product has no reason to see.

## Finding 3 — this is a credential problem, not a code problem

Nothing in this repository calls a mutation. ADR-019 makes that structural: the
transport exposes exactly one verb, GET, so no mutation method exists to be
reached, and a test asserts the injected fetch is never called with anything
else across the whole suite.

That is the right defence and it is not the one this gate measures. The gate
measures **permission held**, because defence in depth assumes the first layer
fails. Flow content is tenant-authored and is treated throughout this design as
a prompt-injection vector; the entire evidence-pack and output-validation
architecture exists because we assume something upstream will eventually do
something we did not intend. If that ever happened while this credential were in
use, the blast radius would include publishing and deleting production IVRs.

Holding the permission is the finding. Not calling it is not a mitigation.

## Remediation

`npm run spike:s4` emits the role to create, derived from the adapter's actual
call list so it cannot drift into a hand-maintained second table:

```text
spike-evidence/s4-required-role.json
```

It contains `view` on `directory:organization`, `architect:flow`,
`architect:ivr`, `architect:userPrompt`, `architect:systemPrompt`,
`architect:schedule`, `architect:scheduleGroup`, `architect:emergencyGroup`,
`architect:datatable`, `routing:queue`, `routing:language`, `routing:skill`,
`routing:wrapupCode`, `integrations:integration`, `integrations:action`,
`telephony:plugin`, and `authorization:division` — and by construction has no
way to emit a mutating action.

Steps:

1. In Genesys Cloud Admin → People/Permissions → Roles, create
   **"Genesys Archivist (read-only)"** from that file.
2. Create a **new** OAuth client (client-credentials grant) with only that role.
   Do not re-scope the existing one: the existing one is useful for other work
   and this must be a separate identity with a separate audit trail.
3. Point `.env.phase0` at the new client and re-run `npm run spike:s4`.
4. The gate passes when it reports `gate: PASS` — no mutation, caller-data, or
   secret permission granted — **and** the endpoint probes still report 17/17
   reachable. If a probe now returns 403, the role is missing a `view` the
   adapter needs, and that 403 is the measurement `docs/14` asked for: it names
   the true minimum permission for that endpoint.
5. Record the resulting matrix here and flip the header block to `GO`.

Step 4 is the part `docs/14` describes as "start with no roles and add one
capability at a time." The over-privileged client made that measurement
impossible; the restricted role makes it automatic.

## Evidence

`spike-evidence/s4-permissions.json` — full policy list with hashed role ids,
the violation list, and every probe result. Gitignored: it is a map of a real
tenant's authorization posture.

## Note on the gate's own correctness

The first revision of the runner reported `INCONCLUSIVE` both when the grants
could not be read _and_ when they were read and found violating — which would
have filed a hard security failure under "we could not tell." Fixed to three
states before the result above was recorded. A verification tool that has not
itself been verified is not evidence.
