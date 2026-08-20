#!/usr/bin/env node
/**
 * Lists the permissions this organization actually defines.
 *
 * Read-only. Exists because the Genesys admin UI's grouping and labels do not
 * match the API's domain:entity:action strings -- "Emergency Group" appears
 * under Routing, an Architect schedule is not the Outbound schedule of the
 * same name -- so hunting for a permission by eye is unreliable. This asks the
 * org what it has.
 *
 *   node scripts/spike/list-permissions.mjs [filterRegex]
 *
 * Throwaway diagnostic. Prints no tenant data: permission names are product
 * vocabulary, not customer configuration.
 */
import { attempt, authenticate, loadSpikeEnv, platformClient } from './env.mjs';

const filter = new RegExp(process.argv[2] ?? '.', 'i');

const env = await loadSpikeEnv();
await authenticate(env);
const api = new platformClient.AuthorizationApi();

const domains = [];
for (let page = 1; page <= 20; page += 1) {
  const res = await attempt('perms', () =>
    api.getAuthorizationPermissions({ pageSize: 500, pageNumber: page }),
  );
  if (!res.ok) {
    console.log(`getAuthorizationPermissions failed: status ${res.status}`);
    process.exitCode = 1;
    break;
  }
  const entities = res.body?.entities ?? [];
  domains.push(...entities);
  const pageCount = res.body?.pageCount;
  if (entities.length === 0 || (typeof pageCount === 'number' && page >= pageCount)) break;
}

const rows = [];
for (const domainEntry of domains) {
  // Shape, measured rather than assumed: { domain, permissionMap: { <entityType>: [ { action, label } ] } }
  for (const entries of Object.values(domainEntry.permissionMap ?? {})) {
    for (const entry of entries ?? []) {
      rows.push({
        key: `${entry.domain}:${entry.entityType}:${entry.action}`,
        label: entry.label ?? '',
      });
    }
  }
}

const matched = rows.filter((r) => filter.test(r.key) || filter.test(r.label));
matched.sort((a, b) => a.key.localeCompare(b.key));
for (const r of matched) console.log(r.key.padEnd(48), '|', r.label);
console.log(`\n${matched.length} of ${rows.length} permissions matched.`);
