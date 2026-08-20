// packages/genesys-platform/src/permissions.ts
//
// The static half of spike S4 (the permission-matrix release gate), recorded
// as a code table rather than prose so `resolveMissingPermission` can turn a
// 403 into a named permission instead of a raw authorization response.
//
// This table is NOT the release gate itself, and it is NOT a measured
// result. `docs/spikes/S4-permission-matrix.md` ran both halves of that
// spike: every endpoint probe below returned 200, but the credential used to
// probe them holds 580 mutating grants across 783 policies (including
// `architect:flow: publish, delete` and `architect:dependencyTracking:
// rebuild` -- the exact mutation AGENTS.md names as never to be held) --
// VERIFIED against GET /api/v2/authorization/permissions on the live org.
// Five names in this table did not exist: architect:datatable:viewRow is really
// architect:datatableRow:view, and schedules, schedule groups and emergency
// groups live in the routing domain rather than architect. architect:ivr and
// routing:language:view do not exist in any form -- those two carry an empty
// permission, meaning "not yet measured", the same convention organizations.me
// already uses. A table whose whole job is to name the permission behind a 403
// naming permissions that cannot be granted was worse than naming none.
// which means a 200 there proves reachability, not minimum permission. S4's
// own words: "the `permission` column... is therefore the *expected*
// permission, not a measured one." The live measurement (re-running against
// a freshly created role holding only these permissions, per S4's
// remediation section) has not happened. Treat a mismatch discovered by that
// run as a correction to this file, not evidence the file was unnecessary.
//
// What IS true regardless of which credential this adapter runs under: no
// mutation is *reachable* from this code, because ADR-019's transport
// exposes exactly one HTTP verb. On the over-privileged sandbox credential,
// that is the only read-only guarantee that actually holds -- the
// credential itself provides none.
export type PlatformOperation =
  | 'organizations.me'
  | 'flows.list'
  | 'flows.get'
  | 'flows.versions.list'
  | 'flows.versions.configuration'
  | 'flows.latestConfiguration'
  | 'routing.queues.get'
  | 'architect.prompts.get'
  | 'architect.prompts.resources.list'
  | 'architect.systemPrompts.get'
  | 'integrations.get'
  | 'integrations.actions.get'
  | 'flows.datatables.get'
  | 'flows.datatables.rows.list'
  | 'architect.schedules.get'
  | 'architect.scheduleGroups.get'
  | 'architect.emergencyGroups.get'
  | 'architect.ivrs.get'
  | 'architect.ivrs.list'
  | 'languages.get';

export interface PermissionRequirement {
  readonly operation: PlatformOperation;
  readonly endpoint: string;
  /** The Genesys Cloud permission string, in `division:entity:action` form,
   * as it appears in the Genesys Cloud admin role editor. */
  readonly permission: string;
}

/**
 * One row per operation this adapter calls. `organizations.me` genuinely
 * requires no permission -- it identifies the authenticated client, which
 * Genesys exposes unconditionally to any valid OAuth token -- and is listed
 * with an empty permission string for completeness rather than omitted,
 * so the table remains "every operation this file calls," not "every
 * operation that happens to need a role".
 */
export const PERMISSION_MATRIX: readonly PermissionRequirement[] = [
  { operation: 'organizations.me', endpoint: 'GET /api/v2/organizations/me', permission: '' },
  { operation: 'flows.list', endpoint: 'GET /api/v2/flows', permission: 'architect:flow:view' },
  {
    operation: 'flows.get',
    endpoint: 'GET /api/v2/flows/{flowId}',
    permission: 'architect:flow:view',
  },
  {
    operation: 'flows.versions.list',
    endpoint: 'GET /api/v2/flows/{flowId}/versions',
    permission: 'architect:flow:view',
  },
  {
    operation: 'flows.versions.configuration',
    endpoint: 'GET /api/v2/flows/{flowId}/versions/{versionId}/configuration',
    permission: 'architect:flow:view',
  },
  {
    operation: 'flows.latestConfiguration',
    endpoint: 'GET /api/v2/flows/{flowId}/latestconfiguration',
    permission: 'architect:flow:view',
  },
  {
    operation: 'routing.queues.get',
    endpoint: 'GET /api/v2/routing/queues/{queueId}',
    permission: 'routing:queue:view',
  },
  {
    operation: 'architect.prompts.get',
    endpoint: 'GET /api/v2/architect/prompts/{promptId}',
    permission: 'architect:userPrompt:view',
  },
  {
    operation: 'architect.prompts.resources.list',
    endpoint: 'GET /api/v2/architect/prompts/{promptId}/resources',
    permission: 'architect:userPrompt:view',
  },
  {
    operation: 'architect.systemPrompts.get',
    endpoint: 'GET /api/v2/architect/systemprompts/{promptId}',
    permission: 'architect:systemPrompt:view',
  },
  {
    operation: 'integrations.get',
    endpoint: 'GET /api/v2/integrations/{integrationId}',
    permission: 'integrations:integration:view',
  },
  {
    operation: 'integrations.actions.get',
    endpoint: 'GET /api/v2/integrations/actions/{actionId}',
    permission: 'integrations:action:view',
  },
  {
    operation: 'flows.datatables.get',
    endpoint: 'GET /api/v2/flows/datatables/{datatableId}',
    permission: 'architect:datatable:view',
  },
  {
    operation: 'flows.datatables.rows.list',
    endpoint: 'GET /api/v2/flows/datatables/{datatableId}/rows',
    permission: 'architect:datatableRow:view',
  },
  {
    operation: 'architect.schedules.get',
    endpoint: 'GET /api/v2/architect/schedules/{scheduleId}',
    permission: 'routing:schedule:view',
  },
  {
    operation: 'architect.scheduleGroups.get',
    endpoint: 'GET /api/v2/architect/schedulegroups/{scheduleGroupId}',
    permission: 'routing:scheduleGroup:view',
  },
  {
    operation: 'architect.emergencyGroups.get',
    endpoint: 'GET /api/v2/architect/emergencygroups/{emergencyGroupId}',
    permission: 'routing:emergencyGroup:view',
  },
  {
    operation: 'architect.ivrs.get',
    endpoint: 'GET /api/v2/architect/ivrs/{ivrId}',
    permission: '',
  },
  {
    operation: 'architect.ivrs.list',
    endpoint: 'GET /api/v2/architect/ivrs',
    permission: '',
  },
  {
    operation: 'languages.get',
    endpoint: 'GET /api/v2/languages/{languageId}',
    permission: '',
  },
];

const BY_OPERATION: ReadonlyMap<PlatformOperation, PermissionRequirement> = new Map(
  PERMISSION_MATRIX.map((row) => [row.operation, row]),
);

/** The permission a 403 on this operation should be reported as missing.
 * Returns `null` for an operation the table does not know about, which is
 * itself a fact worth surfacing rather than a value to default away. */
export function permissionForOperation(operation: PlatformOperation): string | null {
  const row = BY_OPERATION.get(operation);
  return row === undefined || row.permission === '' ? null : row.permission;
}
