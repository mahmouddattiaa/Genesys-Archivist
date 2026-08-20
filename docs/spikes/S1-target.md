# Phase 0 Target — BFSI-MajorelX sandbox

Non-secret configuration for the Phase 0 spikes. **No credential appears in this file and none ever may.** The client secret lives only in `.env.phase0`, which is gitignored.

## Organization

| Field                | Value                                                    |
| -------------------- | -------------------------------------------------------- |
| Organization name    | BFSI-MajorelX                                            |
| Genesys Cloud region | **eu-west-1 (Ireland)**                                  |
| Region enum          | `euw1`                                                   |
| App host             | `https://apps.mypurecloud.ie`                            |
| API base             | `https://api.mypurecloud.ie`                             |
| Login host           | `https://login.mypurecloud.ie`                           |
| Organization ID      | _discovered on first connect — see bootstrap note below_ |

The region is derived from the `.ie` app host. Never infer a region from an organization display name; the host is the authority.

## Authentication

OAuth **client credentials** grant only. The client ID is not a secret and is recorded in `.env.phase0`; the client secret is entered there by hand and never leaves that file.

The tool does not use, and must never accept, a Genesys username or password. `AGENTS.md` forbids username/password automation against the Genesys login page, so a human login is irrelevant to every code path in this project.

### Bootstrap note on `GENESYS_EXPECTED_ORG_ID`

The tenant-mismatch guard compares the organization it reaches against an expected ID, which creates a chicken-and-egg problem on the very first connection. Bootstrap sequence:

1. Leave `GENESYS_EXPECTED_ORG_ID` blank for the first run of `s2-discovery.mjs`.
2. The probe prints the discovered organization ID. That value is not a secret.
3. Paste it into `.env.phase0`.
4. Every subsequent run enforces it and aborts on mismatch.

## The concrete test case

Rather than a synthetic corpus, Phase 0 uses a real routing path in this sandbox.

| Field                | Value                                  |
| -------------------- | -------------------------------------- |
| Entry point          | Call Routing → IVR configuration       |
| Admin UI             | `/directory/#/admin/routing/ivrs`      |
| Target IVR config ID | `5ffacb01-3ae5-49e9-8e54-58d4f32c76f7` |

### Required walk

1. **Call the routing API to list IVR configurations.** The goal is the full list with pagination, looped over; for this spike only the one ID above matters.
2. **Resolve the flow configured on that route.** An IVR config maps inbound DIDs to an Architect flow, so this is the edge from route to flow.
3. **Fetch that flow's configuration**, then walk outward to everything it references.
4. **Document the whole setup from route to flow**, explicitly including **prompts** and any **integrations / data actions** used.
5. **Produce two documents**: one business-focused, one technical-focused.

### Why this target is well chosen

It exercises the exact chain the design cares about, end to end, on real data:

```text
IVR config (DID -> flow)          -> validates the call-routes resource type
  -> Architect flow definition    -> validates the S1 source-path comparison
    -> prompts                    -> validates S4, the asset download probe
    -> data actions               -> validates second-order reference walking
      -> integrations             -> validates that credentials are never fetched
```

The data-action hop matters most. It is the first place the resource walk must follow a reference _through_ one resource to reach another, and it is where the redactor must keep the endpoint URL and the `${...}` header template while never requesting the integration's credentials.

## Spike coverage from this one route

| Spike | What this target proves                                                                                               |
| ----- | --------------------------------------------------------------------------------------------------------------------- |
| S1    | Source-path fidelity for the resolved flow, against a manual Architect YAML export of the same flow with tracking IDs |
| S2    | Pagination and completeness of the IVR configuration list                                                             |
| S3    | Reference-walk closure: route → flow → prompt → data action → integration                                             |
| S4    | Whether prompt audio downloads under a read-only role — the input to kill criterion 11                                |
| S5    | The minimum permission set needed for exactly this chain                                                              |

## Still needed before S1 can run

- [ ] A **manual export of the resolved flow from the Architect UI as YAML, with tracking IDs enabled.** S1 scores every automated source path against this baseline; without it there is nothing to compare to.
- [ ] Confirmation that the OAuth client uses the **client credentials** grant and carries a read-only role.
- [ ] An administrator-approved count of IVR configurations in this org, so S2 has an expected number to match.

## Credential hygiene for this sandbox

The client secret and a user password for this organization were transmitted over a chat channel during planning and should be treated as exposed. Recommended before the pilot, and required before any production organization is touched:

- Rotate the OAuth client secret. Rotating a secret preserves the client ID; creating a new client changes it, in which case update `GENESYS_CLIENT_ID` too.
- Rotate the user account password.
- Provision every future secret through `archivist profile add` or directly into `.env.phase0`, never through a chat message.
