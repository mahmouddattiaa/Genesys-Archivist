# Setting up a Genesys Cloud organisation for Archivist

Everything on this page happens **once per organisation**, in the Genesys Cloud admin
UI, before Archivist can read anything. It takes about fifteen minutes.

It is written to be followed literally, including by an AI agent doing the setup on
someone's behalf. **Step 3 is the one that is not discoverable** — it costs people an
hour of confusion, and nothing in the Genesys UI hints at it.

---

## What you are creating

| Thing                   | Why                                                                 |
| ----------------------- | ------------------------------------------------------------------- |
| A **read-only role**    | The least-privilege permission set Archivist actually needs         |
| An **OAuth client**     | Machine credentials (Client Credentials grant), scoped to that role |
| A **profile** or `.env` | Where the client id and secret are stored on the operator's machine |

Archivist **cannot write to Genesys**. Its HTTP transport exposes only `GET`. The role
below exists so the credential is minimal as well — defence in depth, not a substitute
for the code-level guarantee.

---

## Step 1 — Create the role

**Admin → People and Permissions → Roles / Permissions → Add Role**

Give it a clear name, e.g. `Archivist Read Only`.

On the **Permissions** tab, add exactly these:

```text
architect:flow:view
architect:datatable:view
architect:datatableRow:view
architect:systemPrompt:view
architect:userPrompt:view
integrations:integration:view
integrations:action:view
routing:queue:view
routing:schedule:view
routing:scheduleGroup:view
routing:emergencyGroup:view
```

> **The authoritative list is `packages/genesys-platform/src/permissions.ts`**, which maps
> every permission to the exact endpoint that needs it. Prefer it over this page if the
> two ever disagree.
>
> A warning from experience: that table itself named **five permissions that do not
> exist** until it was checked against the organisation's real catalogue. If a permission
> here cannot be found in the UI, do not invent a near-match and do not widen the role —
> run `node scripts/spike/list-permissions.mjs` to dump what the org actually offers, and
> fix the table.

Save the role.

---

## Step 2 — Do **not** widen this role later

If a capture later fails with a permission error, the correct response is to find the
endpoint that failed and add the one `:view` permission it needs.

**Never add a `:edit`, `:add`, `:delete`, or `:*` grant, and never assign a built-in
admin role to this client.** `npm run spike:s4` is a release gate that reads the
credential's granted policies and fails the build if any mutating, caller-data, or
credential permission appears. Widening the role to make a failure go away defeats the
only mechanism that keeps this tool safe to point at a customer's production estate.

For reference, the exercise that produced this role took a credential from **783
permission policies with 580 mutating grants** down to **16 policies with zero
mutation** — while keeping every endpoint Archivist calls reachable.

---

## Step 3 — Assign the role to your own user ⚠️

**This is the step everybody misses.**

After saving the role, open it again and use **Change Membership** (in the role's action
menu, sometimes shown as _Members_ / _Assigned Users_). **Add your own user account** to
the role and save.

Why it matters: **until the role has at least one member, it will not appear in the role
picker when you create the OAuth client in Step 4.** The list simply comes up without
it, with no error and no explanation, and the natural conclusion — "my role didn't save"
— is wrong. The role saved fine. It just has no members yet.

If the role is missing in Step 4, come back here first.

---

## Step 4 — Create the OAuth client

**Admin → Integrations → OAuth → Add Client**

| Field          | Value                                                                |
| -------------- | -------------------------------------------------------------------- |
| App Name       | e.g. `Archivist Capture`                                             |
| Grant Type     | **Client Credentials**                                               |
| Roles          | Select the role from Step 1 — it appears **only if Step 3 was done** |
| Token Duration | Default is fine                                                      |

Optionally restrict **Allowed IP addresses** to the machines that will run captures.
Recommended for a production organisation; leave blank while piloting.

Save, then copy the **Client ID** and **Client Secret**. The secret is shown once —
if you lose it, regenerate it rather than guessing.

---

## Step 5 — Store the credentials

### For normal use — the CLI profile store

```bash
archivist profile add \
  --id acme \
  --display-name "Acme Bank" \
  --region euw1 \
  --org <organizationId> \
  --client-id <clientId> \
  --output-root /path/to/output
# paste the secret at the hidden prompt, or:
echo "$SECRET" | archivist profile add ...
```

**The secret is never a command-line flag.** `--client-secret` is refused with an
explanation, because argv is visible in process listings and shell history. This is not
configurable and will not change.

Verify:

```bash
archivist doctor                 # Node version, credential store, profiles
archivist profile validate acme  # profile parses, secret present, output root writable
```

### For the spike scripts — `.env.phase0`

The `scripts/spike/*` diagnostics read a `.env.phase0` file at the repository root. It
is git-ignored; never commit it.

```dotenv
GENESYS_REGION=euw1
GENESYS_EXPECTED_ORG_ID=<organizationId>
GENESYS_CLIENT_ID=<clientId>
GENESYS_CLIENT_SECRET=<clientSecret>

# Optional: a single flow id to target the fidelity spikes
GENESYS_TARGET_IVR_ID=<flowId>

# Only for the S4 permission gate -- see below
GENESYS_ADMIN_CLIENT_ID=<adminClientId>
GENESYS_ADMIN_CLIENT_SECRET=<adminClientSecret>
```

Region accepts either the canonical form (`eu_west_1`) or the short form (`euw1`).

---

## Why the permission gate needs a _second_ credential

`npm run spike:s4` verifies that the capture credential holds no mutating permission. To
do that it must read the OAuth client's own configuration — which requires
`oauth:client:view`.

That is precisely the permission the gate exists to keep **out** of the capture role. A
correctly scoped read-only client therefore cannot inspect itself, by design.

So S4 uses a separate admin credential (`GENESYS_ADMIN_CLIENT_*`) purely to _read_ the
capture client's grants. The admin credential is never used for capture, and never
appears in a bundle, document, or log.

If you skip it, S4 reports **INCONCLUSIVE** — which is deliberately distinct from
**PASS** and from **FAIL**. An unverifiable gate must never look like a passed one.

---

## Verifying the whole setup

```bash
npm run spike:s4        # permission gate: expect PASS, and zero mutating policies
archivist doctor
archivist capture --profile acme --mode context --org <organizationId>
```

A first `context` capture across a real organisation is roughly 400 requests. On the
reference organisation — 511 flows, 401 published — it captured 502 flows in about six
minutes.

---

## Troubleshooting

| Symptom                                                | Cause                                                                                                                            |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| The new role is missing when creating the OAuth client | **Step 3.** The role has no members yet.                                                                                         |
| A permission in this list cannot be found in the UI    | The permission name may be wrong. Dump the real catalogue with `scripts/spike/list-permissions.mjs`.                             |
| `401` / `invalid_client`                               | Client id or secret mistyped, or the client is in a different region.                                                            |
| `403` on one endpoint only                             | One missing `:view` permission. Add that one. Do not widen the role.                                                             |
| S4 reports `INCONCLUSIVE`                              | `GENESYS_ADMIN_CLIENT_*` not set — see above. Not a failure.                                                                     |
| Capture refuses with an organisation mismatch          | Working as intended: `expectedOrganizationId` guards against a mistyped credential capturing the wrong customer's configuration. |
