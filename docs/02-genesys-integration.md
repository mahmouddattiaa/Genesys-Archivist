# 02 — Genesys Integration

## Supported target

This design assumes Genesys Cloud CX Architect. Verify the product and regional deployment before implementation.

## Authentication model

Use a dedicated Genesys OAuth client. For unattended local or CI extraction, client credentials are the expected grant because the process acts as an application, not a human user.

The required setup inputs are:

- Profile display name.
- Genesys region/environment.
- OAuth client ID.
- OAuth client secret, entered through a secure CLI prompt or resolved from an approved secret store.
- Output classification and location.

An organization name and a user's username/password are not a production integration contract. Do not automate web login. On connection, discover the organization ID/name from an authorized endpoint and compare it to the profile's expected organization identity to prevent cross-tenant mistakes.

## Least-privilege policy

The production profile is read-only. Determine the exact permission set empirically in Phase 0 and have a Genesys administrator review it.

Expected categories include:

- Architect UI/view capability required by Architect Scripting.
- Flow search/view permissions for selected divisions and flow types.
- Read permissions for referenced queues, prompts, schedules, data actions, integrations, users, or groups only when dependency names must be resolved.

Forbidden categories include:

- Flow add/edit/delete/publish/check-in/unlock.
- OAuth client secret view/reset/create.
- Integration credential view.
- Recording, transcript, conversation, analytics, or historical execution data.

If the official SDK requires a mutation permission merely to load or export, treat that as a security exception requiring an explicit approval; do not silently grant it.

## Regional routing

Genesys Cloud uses region-specific login and API hosts. The profile stores a validated region enum rather than accepting arbitrary hosts. The source adapter maps the enum using the official SDK region configuration. Tests must cover at least two regions and reject profile/organization mismatches.

Never infer a region solely from an organization display name.

## Discovery path

Use the public Architect/Flows Platform API through the official SDK to enumerate flow metadata.

Discovery requirements:

- Follow every page until the server reports completion.
- Filter by supported flow types and divisions only after recording visibility boundaries.
- Preserve stable `flowId`, type, division, current/published version, modified time, publication state, and source metadata available from the API.
- Deduplicate by stable ID, never by name.
- Treat same-name flows in different divisions as distinct.
- Record partial visibility when permissions prevent resolving a division or dependency.

Endpoint names and SDK method signatures must be generated or verified from the installed official SDK and current API Explorer. Do not hand-code a stale endpoint from this blueprint.

## Full configuration extraction

The Platform API flow list is not sufficient to document the complete IVR graph. The preferred full-source path is the official Architect Scripting SDK:

1. Start an Architect scripting session using the configured region and OAuth client.
2. Obtain flow information for the selected stable flow ID and target version.
3. Load the flow read-only.
4. Export to an in-memory object or traverse the loaded object model.
5. Immediately convert the source into an internal DTO; no SDK object crosses the adapter boundary.
6. End the session and discard access tokens.

The official SDK documentation exposes flow capabilities including `getFlowInfoAsync`, `loadAsync`, `traverse`, and `exportToObjectAsync`. The exact call sequence, parameters, supported versions, and output format are a Phase 0 proof, not an assumption.

### Fidelity comparison

For each representative fixture:

1. Manually export YAML from Architect with tracking IDs enabled.
2. Export or traverse the same published version through the SDK.
3. Compare containers, nodes, edge labels, expressions, variables, dependencies, prompts, error paths, and IDs.
4. Explain every difference.
5. Mark unsupported UI-only constructs in the snapshot.

Genesys notes that sequence builders may be rendered as equivalent expressions in YAML. The documentation generator must describe the expression semantics without pretending to reproduce the exact visual editing construct.

## Fallback source provider

`ManualYamlSourceProvider` ingests a user-supplied Architect YAML export. It is acceptable for:

- Parser development.
- Offline demonstrations.
- Organizations that do not permit OAuth automation.
- Temporary coverage when an SDK export regression occurs.

It does not provide automatic discovery or update detection. The UI export process and file handoff become operational dependencies, and the resulting documentation must say `sourceMode: manual-yaml`.

Reverse engineering encoded `.i3flow` formats or calling undocumented browser endpoints is not an approved fallback.

## Version selection

Default policy: document the current published version because that represents caller-visible behavior.

Optional policies, gated by permissions and requirements:

- `published`: only published version.
- `checked-in`: latest checked-in version.
- `working-copy`: latest saved draft; requires explicit authorization and a visible draft watermark.
- `published-and-latest`: document published behavior and separately report unpublished drift.

Never mix nodes from different versions into one snapshot. Version identity must be stored with every artifact.

## Referenced dependencies

Resolve references through separate read-only resolver interfaces:

- Queues and wrap-up codes.
- Data actions and integration names.
- User/system prompts and languages.
- Schedules and schedule groups.
- Other Architect flows and reusable tasks.
- Groups, users, skills, scripts, response assets, and data tables when encountered.

Dependency resolution is best effort and bounded. Store stable ID, display name, type, source node pointers, and resolution status. Do not retrieve credentials, secure values, or runtime customer data. An unresolved reference remains visible and lowers completeness.

## Pagination, throttling, and retries

- Use server-provided pagination fields.
- Apply bounded concurrency and jittered exponential backoff only for retryable network errors, `429`, and selected `5xx` responses.
- Honor `Retry-After` and SDK retry metadata when supplied.
- Do not retry authentication/authorization failures, schema violations, or unsupported-flow errors as if they were transient.
- Enforce a retry budget per run so a failing organization cannot loop indefinitely.
- Persist progress after each completed flow so the run can resume.

Do not build a strategy around a remembered fixed requests-per-minute number. Genesys limits can differ by resource and evolve. Observe actual headers, document measured behavior, and remain below the customer's approved usage.

## Token lifecycle

- Access tokens live only in memory.
- Refresh/re-authenticate through the official SDK when expired.
- Never write tokens into manifests, snapshots, exceptions, or debug dumps.
- The logger redacts authorization headers and known token patterns before serialization.
- Repeated authentication failure opens a circuit breaker and requires operator action.

## Adapter interface

The domain-facing interface should resemble:

```ts
interface GenesysSourceProvider {
  validateConnection(profileId: string): Promise<ConnectionIdentity>;
  listFlows(query: FlowDiscoveryQuery): AsyncIterable<FlowDescriptor>;
  loadFlowSource(ref: FlowVersionRef): Promise<RawFlowSource>;
  resolveDependencies(refs: DependencyRef[]): Promise<DependencyResolution[]>;
}
```

This is illustrative. The implementation must use domain DTOs, cancellation signals, deadlines, and correlation context.
