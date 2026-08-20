#!/usr/bin/env node
/**
 * Phase 0 spike S2 — discovery completeness.
 *
 * Answers: can every flow and version be discovered across types, divisions,
 * and pages? Also doubles as S0 evidence, because it exercises the official
 * SDK end to end: install, region mapping, client-credentials login, paginated
 * reads. Everything downstream depends on those working.
 *
 * Throwaway code. Not production architecture. Do not import it from packages/.
 *
 * NEVER prints the client secret. Evidence written to spike-evidence/ stores
 * hashed names, never the names themselves, because flow and queue names are
 * customer configuration.
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REPO_ROOT, attempt, authenticate, loadSpikeEnv, platformClient } from './env.mjs';

/** Every Architect flow type. Release 1 captures all of them. */
const FLOW_TYPES = [
  'inboundcall',
  'inboundchat',
  'inboundemail',
  'inboundshortmessage',
  'outboundcall',
  'inqueuecall',
  'securecall',
  'speech',
  'survey',
  'voicesurvey',
  'bot',
  'digitalbot',
  'commonmodule',
  'workflow',
];

const hash = (s) => 'n_' + createHash('sha256').update(String(s)).digest('hex').slice(0, 12);
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => console.log(`  ✗ ${m}`);
const warn = (m) => console.log(`  ! ${m}`);

/**
 * Follows every page until the server reports completion.
 *
 * docs/02: "Follow every page until the server reports completion." pageCount
 * is trusted when present; an empty page is the fallback terminator.
 */
async function pageThrough(label, call, { pageSize = 100, maxPages = 200 } = {}) {
  const entities = [];
  let pageNumber = 1;
  let pages = 0;

  for (;;) {
    const res = await attempt(label, () => call({ pageSize, pageNumber }));
    if (!res.ok) return { entities, pages, status: res.status, complete: false };

    pages += 1;
    const batch = res.body?.entities ?? [];
    entities.push(...batch);

    const pageCount = res.body?.pageCount;
    if (batch.length === 0) break;
    if (typeof pageCount === 'number' && pageNumber >= pageCount) break;
    if (pageNumber >= maxPages) return { entities, pages, status: 200, complete: false };
    pageNumber += 1;
  }
  return { entities, pages, status: 200, complete: true };
}

async function main() {
  const env = await loadSpikeEnv();
  const evidence = {
    spike: 'S2',
    region: env.region,
    sdk: 'purecloud-platform-client-v2',
    probes: {},
  };

  console.log('\nS2 — discovery completeness  (official Genesys SDK)');
  console.log(`  region ${env.region}\n`);

  await authenticate(env);
  ok('authenticated with the client credentials grant');
  ok('SDK region mapping resolved from PureCloudRegionHosts');

  const organizationApi = new platformClient.OrganizationApi();
  const architectApi = new platformClient.ArchitectApi();
  const authorizationApi = new platformClient.AuthorizationApi();

  // --- tenant identity ------------------------------------------------------
  const org = await attempt('org', () => organizationApi.getOrganizationsMe());
  if (!org.ok) {
    bad(`organization lookup failed (${org.status})`);
    evidence.probes.organization = { status: org.status };
    await writeEvidence(evidence);
    process.exit(1);
  }

  const orgId = org.body.id;
  ok(`organization  ${org.body.name}`);
  console.log(`    organizationId  ${orgId}`);

  if (env.expectedOrgId === null) {
    warn('GENESYS_EXPECTED_ORG_ID is blank — paste the ID above into .env.phase0');
    warn('the tenant guard is NOT armed until you do');
  } else if (env.expectedOrgId !== orgId) {
    bad(`TENANT MISMATCH: expected ${env.expectedOrgId}, reached ${orgId}`);
    bad('aborting before reading any flow');
    evidence.probes.organization = { status: 200, tenantMismatch: true };
    await writeEvidence(evidence);
    process.exit(2);
  } else {
    ok('tenant binding verified');
  }
  evidence.probes.organization = { status: 200, orgIdHash: hash(orgId) };

  // --- divisions ------------------------------------------------------------
  const divisions = await pageThrough('divisions', (o) =>
    authorizationApi.getAuthorizationDivisions(o),
  );
  if (divisions.status === 200) {
    ok(`divisions  ${divisions.entities.length}  (${divisions.pages} page(s))`);
  } else {
    warn(`divisions unavailable (${divisions.status}) — permission gap?`);
  }
  evidence.probes.divisions = { status: divisions.status, count: divisions.entities.length };

  // --- flows by type --------------------------------------------------------
  console.log('\n  flows by type');
  const byType = {};
  const nameIndex = new Map(); // "type|name" -> Set(divisionId)
  let total = 0;

  for (const type of FLOW_TYPES) {
    const res = await pageThrough(`flows:${type}`, (o) => architectApi.getFlows({ ...o, type }));
    byType[type] = { count: res.entities.length, pages: res.pages, status: res.status };

    if (res.status !== 200) {
      console.log(`    ${type.padEnd(20)} unavailable (${res.status})`);
      continue;
    }
    if (res.entities.length === 0) continue;

    total += res.entities.length;
    console.log(
      `    ${type.padEnd(20)} ${String(res.entities.length).padStart(4)}   ${res.pages} page(s)` +
        (res.complete ? '' : '   INCOMPLETE'),
    );

    for (const flow of res.entities) {
      const key = `${type}|${flow.name}`;
      if (!nameIndex.has(key)) nameIndex.set(key, new Set());
      nameIndex.get(key).add(flow.division?.id ?? 'none');
    }
  }
  console.log(`    ${'TOTAL'.padEnd(20)} ${String(total).padStart(4)}`);
  evidence.probes.flows = { total, byType };

  // --- the number that matters most ----------------------------------------
  // Architect YAML references every resource by display NAME, not by ID. If two
  // same-named flows live in different divisions, a name-to-ID join can
  // silently mis-resolve. See docs/spikes/S1-yaml-structure-findings.md.
  const collisions = [...nameIndex.entries()].filter(([, divs]) => divs.size > 1);
  console.log('');
  if (collisions.length === 0) {
    ok('no same-named flows across divisions — the name-to-ID join is unambiguous here');
  } else {
    bad(`${collisions.length} flow name(s) appear in MORE THAN ONE division`);
    bad('the name-to-ID join needs an explicit scoping rule before capture is built');
    for (const [key, divs] of collisions.slice(0, 5)) {
      console.log(`      ${key.split('|')[0]}  in ${divs.size} divisions`);
    }
  }
  evidence.probes.nameCollisions = {
    count: collisions.length,
    keys: collisions.map(([k, d]) => ({ keyHash: hash(k), divisions: d.size })),
  };

  // --- IVR configurations ---------------------------------------------------
  console.log('');
  const ivrs = await pageThrough('ivrs', (o) => architectApi.getArchitectIvrs(o));
  if (ivrs.status === 200) {
    ok(`IVR configurations  ${ivrs.entities.length}  (${ivrs.pages} page(s))`);
    const dids = ivrs.entities.flatMap((i) => i.dnis ?? []);
    console.log(`    DIDs mapped         ${dids.length}`);

    if (env.targetIvrId) {
      const target = ivrs.entities.find((i) => i.id === env.targetIvrId);
      if (target) {
        ok(`target IVR found  ${env.targetIvrId}`);
        const refs = {
          openHours: target.openHoursFlow?.id ?? null,
          closedHours: target.closedHoursFlow?.id ?? null,
          holidayHours: target.holidayHoursFlow?.id ?? null,
        };
        for (const [slot, id] of Object.entries(refs)) {
          if (id) console.log(`    ${slot.padEnd(14)} → flow ${id}`);
        }
        const primary = refs.openHours ?? refs.closedHours ?? refs.holidayHours;
        if (primary) {
          console.log('\n      THIS is the flow S1 needs a manual Architect YAML export of,');
          console.log('      with tracking IDs enabled.');
        } else {
          warn('target IVR has no flow on any hours slot');
        }
        evidence.probes.targetIvr = { found: true, refs };
      } else {
        bad(`target IVR ${env.targetIvrId} not found in this organization`);
        evidence.probes.targetIvr = { found: false };
      }
    }
    evidence.probes.ivrs = { status: 200, count: ivrs.entities.length, dids: dids.length };
  } else {
    warn(`IVR configurations unavailable (${ivrs.status})`);
    warn('check the read permission for Architect IVRs');
    evidence.probes.ivrs = { status: ivrs.status };
  }

  await writeEvidence(evidence);
  console.log('\n  evidence  spike-evidence/s2-inventory.json  (names hashed)\n');
}

async function writeEvidence(evidence) {
  const dir = join(REPO_ROOT, 'spike-evidence');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 's2-inventory.json'), JSON.stringify(evidence, null, 2), 'utf8');
}

main().catch((err) => {
  console.error(`\n  FAILED  ${err.message}\n`);
  process.exit(1);
});
