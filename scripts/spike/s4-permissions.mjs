#!/usr/bin/env node
/**
 * Phase 0 spike S4 — permission matrix.
 *
 * docs/14 asks: "What is the true minimum permission set?" and sets the pass
 * bar at "a reviewed read-only role with no secret/mutation/caller-data
 * permissions". docs/13 makes it a release gate.
 *
 * Two halves, and this file is the live one:
 *
 *   1. STATIC — the endpoint-to-permission table lives in
 *      packages/genesys-platform/src/permissions.ts, so a 403 at runtime can
 *      name the missing permission instead of surfacing a raw authorization
 *      response.
 *   2. LIVE — this script. It reads the OAuth client's granted roles and every
 *      permission policy inside them, and asserts that not one of them grants a
 *      mutation, a secret, or caller data. It then probes each endpoint the
 *      adapter actually calls and records reachable/forbidden.
 *
 * The mutation half is deliberately proven by INSPECTING GRANTS, never by
 * attempting a write. AGENTS.md forbids a mutation being reachable at all; a
 * test that discovers this by trying one would itself be the violation. The
 * grant inspection is strictly stronger anyway: it proves the permission is
 * absent rather than that one particular call failed.
 *
 * Throwaway code. Not production architecture. Do not import it from packages/.
 *
 * NEVER prints the client secret. Evidence written to spike-evidence/ stores
 * hashed resource names, never the names themselves, because flow and queue
 * names are customer configuration.
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REPO_ROOT, attempt, authenticate, loadSpikeEnv, platformClient } from './env.mjs';

const hash = (s) => 'n_' + createHash('sha256').update(String(s)).digest('hex').slice(0, 12);
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => console.log(`  ✗ ${m}`);
const warn = (m) => console.log(`  ! ${m}`);

/**
 * Genesys permission policies name an action set per domain/entity. Only these
 * two actions read. Everything else — add, edit, delete, and the `*` wildcard —
 * changes state, and the wildcard is the worst of them because it silently
 * grows as Genesys adds actions.
 */
const READ_ACTIONS = new Set(['view', 'search']);

/**
 * Domains that carry caller data or credentials rather than configuration.
 * Even `view` on these is outside what this product needs: docs/06 scopes the
 * capture to Architect configuration, not to conversations or recordings.
 */
const SENSITIVE_DOMAINS = new Set([
  'conversation',
  'recording',
  'quality',
  'speechandtextanalytics',
  'voicemail',
  'externalcontacts',
  'employeeengagement',
  'messaging',
]);

/** Entities whose bodies can carry a credential regardless of domain. */
const SECRET_ENTITIES = new Set(['credential', 'credentials', 'clientsecret', 'secret']);

/**
 * The endpoints the production adapter calls, addressed through the SDK.
 *
 * Resolved by name at run time rather than referenced directly: the SDK's
 * method names drift between major versions, and a probe that dies on an
 * unknown method tells you nothing about the eighteen it could have checked.
 * A missing method is recorded as `sdk-method-absent`, which is a finding about
 * this script, not about the tenant's permissions.
 */
const PROBES = [
  {
    api: 'OrganizationApi',
    method: 'getOrganizationsMe',
    args: [],
    permission: 'directory:organization:view',
  },
  {
    api: 'ArchitectApi',
    method: 'getFlows',
    args: [{ pageSize: 1 }],
    permission: 'architect:flow:view',
  },
  {
    api: 'ArchitectApi',
    method: 'getArchitectIvrs',
    args: [{ pageSize: 1 }],
    permission: 'architect:ivr:view',
  },
  {
    api: 'ArchitectApi',
    method: 'getArchitectPrompts',
    args: [{ pageSize: 1 }],
    permission: 'architect:userPrompt:view',
  },
  {
    api: 'ArchitectApi',
    method: 'getArchitectSystemprompts',
    args: [{ pageSize: 1 }],
    permission: 'architect:systemPrompt:view',
  },
  {
    api: 'ArchitectApi',
    method: 'getArchitectSchedules',
    args: [{ pageSize: 1 }],
    permission: 'architect:schedule:view',
  },
  {
    api: 'ArchitectApi',
    method: 'getArchitectSchedulegroups',
    args: [{ pageSize: 1 }],
    permission: 'architect:scheduleGroup:view',
  },
  {
    api: 'ArchitectApi',
    method: 'getArchitectEmergencygroups',
    args: [{ pageSize: 1 }],
    permission: 'architect:emergencyGroup:view',
  },
  {
    api: 'ArchitectApi',
    method: 'getFlowsDatatables',
    args: [{ pageSize: 1 }],
    permission: 'architect:datatable:view',
  },
  {
    api: 'RoutingApi',
    method: 'getRoutingQueues',
    args: [{ pageSize: 1 }],
    permission: 'routing:queue:view',
  },
  {
    api: 'RoutingApi',
    method: 'getRoutingLanguages',
    args: [{ pageSize: 1 }],
    permission: 'routing:language:view',
  },
  {
    api: 'RoutingApi',
    method: 'getRoutingSkills',
    args: [{ pageSize: 1 }],
    permission: 'routing:skill:view',
  },
  {
    api: 'RoutingApi',
    method: 'getRoutingWrapupcodes',
    args: [{ pageSize: 1 }],
    permission: 'routing:wrapupCode:view',
  },
  {
    api: 'IntegrationsApi',
    method: 'getIntegrations',
    args: [{ pageSize: 1 }],
    permission: 'integrations:integration:view',
  },
  {
    api: 'IntegrationsApi',
    method: 'getIntegrationsActions',
    args: [{ pageSize: 1 }],
    permission: 'integrations:action:view',
  },
  {
    api: 'TelephonyProvidersEdgeApi',
    method: 'getTelephonyProvidersEdgesDidpools',
    args: [{ pageSize: 1 }],
    permission: 'telephony:plugin:all',
  },
  {
    api: 'AuthorizationApi',
    method: 'getAuthorizationDivisions',
    args: [{ pageSize: 1 }],
    permission: 'authorization:division:view',
  },
];

function instantiate(name) {
  const Ctor = platformClient[name];
  if (typeof Ctor !== 'function') return null;
  try {
    return new Ctor();
  } catch {
    return null;
  }
}

/**
 * Reads the OAuth client's own grants.
 *
 * Requires `oauth:client:view`. If the client cannot read itself, that is not a
 * failure of the gate — it is a *stricter* posture than the gate asks for — but
 * it does mean the mutation assertion has to be made by a human in the admin
 * UI instead. The script says so rather than passing silently.
 */
async function readGrantedRoles(clientId) {
  const oauthApi = instantiate('OAuthApi');
  if (oauthApi === null) return { available: false, reason: 'sdk-method-absent', roles: [] };

  const client = await attempt('oauth-client', () => oauthApi.getOauthClient(clientId));
  if (!client.ok) {
    return {
      available: false,
      reason: client.status === 403 ? 'oauth:client:view not granted' : `status ${client.status}`,
      roles: [],
    };
  }

  // The SDK has used both shapes across versions.
  const divisions = client.body?.roleDivisions ?? [];
  const legacy = client.body?.roles ?? [];
  const roleIds = new Set();
  for (const rd of divisions) if (rd?.roleId) roleIds.add(rd.roleId);
  for (const r of legacy) if (r?.id) roleIds.add(r.id);

  return { available: true, reason: null, roles: [...roleIds] };
}

async function readRolePolicies(roleIds) {
  const authApi = instantiate('AuthorizationApi');
  if (authApi === null) return { available: false, policies: [] };

  const policies = [];
  for (const roleId of roleIds) {
    const role = await attempt('role', () => authApi.getAuthorizationRole(roleId));
    if (!role.ok) {
      policies.push({ roleId: hash(roleId), unreadable: true, status: role.status });
      continue;
    }
    for (const p of role.body?.permissionPolicies ?? []) {
      policies.push({
        roleId: hash(roleId),
        roleName: role.body?.name ?? null,
        domain: p.domain ?? null,
        entityName: p.entityName ?? null,
        actionSet: p.actionSet ?? [],
        allowConditions: p.allowConditions ?? false,
      });
    }
  }
  return { available: true, policies };
}

/**
 * The gate itself. A policy fails if it grants any non-read action, touches a
 * caller-data domain, or names a credential-bearing entity.
 */
function judgePolicies(policies) {
  const violations = [];
  for (const p of policies) {
    if (p.unreadable) continue;
    const domain = String(p.domain ?? '').toLowerCase();
    const entity = String(p.entityName ?? '').toLowerCase();

    const mutating = (p.actionSet ?? []).filter((a) => !READ_ACTIONS.has(String(a).toLowerCase()));
    if (mutating.length > 0) {
      violations.push({
        kind: 'mutation',
        policy: `${domain}:${entity}`,
        detail: `grants ${mutating.join(', ')}`,
      });
    }
    if (SENSITIVE_DOMAINS.has(domain)) {
      violations.push({
        kind: 'caller-data',
        policy: `${domain}:${entity}`,
        detail: 'caller-data domain',
      });
    }
    if (SECRET_ENTITIES.has(entity)) {
      violations.push({
        kind: 'secret',
        policy: `${domain}:${entity}`,
        detail: 'credential-bearing entity',
      });
    }
  }
  return violations;
}

async function probeEndpoints() {
  const results = [];
  for (const probe of PROBES) {
    const api = instantiate(probe.api);
    if (api === null || typeof api[probe.method] !== 'function') {
      results.push({ ...probe, outcome: 'sdk-method-absent', status: null });
      warn(`${probe.api}.${probe.method} — not in this SDK version`);
      continue;
    }
    const res = await attempt(probe.method, () => api[probe.method](...probe.args));
    const outcome = res.ok ? 'reachable' : res.status === 403 ? 'forbidden' : `error-${res.status}`;
    results.push({ ...probe, outcome, status: res.status });
    if (res.ok) ok(`${probe.method} — ${probe.permission}`);
    else if (res.status === 403) warn(`${probe.method} — 403, needs ${probe.permission}`);
    else bad(`${probe.method} — status ${res.status}`);
  }
  return results;
}

async function main() {
  const env = await loadSpikeEnv();
  console.log(`\nS4 — permission matrix   region=${env.region}\n`);
  await authenticate(env);
  ok('authenticated (client credentials grant)');

  console.log('\nGranted roles and permission policies');
  const granted = await readGrantedRoles(env.clientId);
  let violations = [];
  let policies = [];

  if (!granted.available) {
    warn(`could not read the OAuth client's own grants: ${granted.reason}`);
    warn('the mutation assertion must be made by a human in Admin > Integrations > OAuth');
  } else {
    const read = await readRolePolicies(granted.roles);
    policies = read.policies;
    ok(`${granted.roles.length} role(s), ${policies.length} permission policies`);
    violations = judgePolicies(policies);
    if (violations.length === 0) ok('no mutation, caller-data, or secret permission granted');
    for (const v of violations) bad(`${v.kind}: ${v.policy} — ${v.detail}`);
  }

  console.log('\nEndpoint probes');
  const probes = await probeEndpoints();

  const reachable = probes.filter((p) => p.outcome === 'reachable').length;
  const forbidden = probes.filter((p) => p.outcome === 'forbidden');

  /**
   * Three outcomes, not two.
   *
   * The first version of this line reported INCONCLUSIVE both when the grants
   * could not be read and when they were read and found violating — which
   * would have filed a hard security failure under "we could not tell". They
   * are opposite findings and must not share a label.
   *
   * The gate is decided by the *grant* assertion, never by the probe results.
   * A forbidden read endpoint is a capability gap to fix in the role; a granted
   * mutation is a security failure. Note also that "17/17 reachable" proves
   * only that the endpoints answer under the credential that was used — under
   * an over-privileged credential it says nothing about the minimum permission
   * each one needs. That is measured by re-running against the restricted role.
   */
  const gate = !granted.available ? 'INCONCLUSIVE' : violations.length === 0 ? 'PASS' : 'FAIL';

  console.log('\n' + '─'.repeat(64));
  console.log(`  gate:      ${gate}`);
  if (gate === 'FAIL') {
    const mutation = violations.filter((v) => v.kind === 'mutation').length;
    const callerData = violations.filter((v) => v.kind === 'caller-data').length;
    const secret = violations.filter((v) => v.kind === 'secret').length;
    console.log(`  policies:  ${policies.length}`);
    console.log(`  violations: ${mutation} mutation, ${callerData} caller-data, ${secret} secret`);
  }
  console.log(`  reachable: ${reachable}/${probes.length} read endpoints`);
  console.log(`  forbidden: ${forbidden.length}`);
  if (forbidden.length > 0) {
    console.log('  missing permissions:');
    for (const p of forbidden) console.log(`    - ${p.permission}`);
  }
  console.log('─'.repeat(64) + '\n');

  const dir = join(REPO_ROOT, 'spike-evidence');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 's4-permissions.json'),
    JSON.stringify(
      {
        spike: 'S4',
        gate,
        region: env.region,
        organizationHash: env.expectedOrgId ? hash(env.expectedOrgId) : null,
        grantsReadable: granted.available,
        grantsUnreadableReason: granted.reason,
        policies: policies.map((p) => ({
          roleId: p.roleId,
          domain: p.domain,
          entityName: p.entityName,
          actionSet: p.actionSet,
        })),
        violations,
        probes: probes.map(({ api, method, permission, outcome, status }) => ({
          api,
          method,
          permission,
          outcome,
          status,
        })),
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
  /**
   * The role the product actually needs, emitted as something an admin can act
   * on rather than a paragraph in a document they have to translate.
   *
   * Derived from PROBES, so it stays in step with the adapter's real call list
   * instead of drifting into a hand-maintained second table. `view` and
   * `search` only — by construction, this file has no way to emit a mutating
   * action.
   */
  const required = {};
  for (const p of PROBES) {
    const [domain, entity] = p.permission.split(':');
    if (!domain || !entity) continue;
    required[domain] ??= {};
    required[domain][entity] ??= new Set();
    required[domain][entity].add('view');
  }
  await writeFile(
    join(dir, 's4-required-role.json'),
    JSON.stringify(
      {
        name: 'Genesys Archivist (read-only)',
        description:
          'Minimum role for the Genesys Archivist capture adapter. View only. ' +
          'Grants no mutation, no credential, and no caller-data permission.',
        permissionPolicies: Object.entries(required).flatMap(([domain, entities]) =>
          Object.entries(entities).map(([entityName, actions]) => ({
            domain,
            entityName,
            actionSet: [...actions],
            allowConditions: false,
          })),
        ),
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  console.log('evidence → spike-evidence/s4-permissions.json');
  console.log('required role → spike-evidence/s4-required-role.json\n');

  process.exitCode = gate === 'PASS' ? 0 : 1;
}

main().catch((err) => {
  // Only the message. Genesys auth and authorization errors have been observed
  // to echo request parameters back in the body.
  console.error(`\nS4 failed: ${err?.message ?? 'unknown error'}\n`);
  process.exitCode = 1;
});
