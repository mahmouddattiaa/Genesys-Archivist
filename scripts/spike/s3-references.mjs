#!/usr/bin/env node
/**
 * Phase 0 spike S3 — resource reference closure.
 *
 * Walks the chain from the original brief, read-only:
 *
 *   IVR config -> flow -> queues / prompts / data actions -> integrations
 *
 * The central question was whether the reference graph can be obtained WITH
 * STABLE IDS. Architect YAML references every resource by display name only,
 * and a name-to-ID join was the riskiest part of the capture design.
 *
 * Answer: getFlowVersionConfiguration returns a `manifest` that lists every
 * referenced resource with its stable id, its name, AND the nodes that
 * reference it. No join is required and no YAML parsing is required.
 *
 * READ-ONLY. postArchitectDependencytrackingBuild would rebuild the dependency
 * index and is a mutation; it is never called.
 *
 * Throwaway code. Never prints the client secret. Evidence is hashed.
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REPO_ROOT, attempt, authenticate, loadSpikeEnv, platformClient } from './env.mjs';

const hash = (s) => 'n_' + createHash('sha256').update(String(s)).digest('hex').slice(0, 12);
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => console.log(`  ✗ ${m}`);
const warn = (m) => console.log(`  ! ${m}`);
const head = (m) => console.log(`\n${m}`);

async function main() {
  const env = await loadSpikeEnv();
  const evidence = { spike: 'S3', region: env.region, probes: {} };
  const arch = new platformClient.ArchitectApi();
  const integ = new platformClient.IntegrationsApi();

  console.log('\nS3 — resource reference closure  (read-only)');
  await authenticate(env);
  ok('authenticated');

  // ---------------------------------------------------------- route -> flow
  head('  step 1  IVR configuration -> flow');
  const ivrId = env.targetIvrId;
  const ivr = await attempt('ivr', () => arch.getArchitectIvr(ivrId));
  let flowId = process.argv[2] ?? null;
  if (ivr.ok) {
    const refs = {
      openHours: ivr.body.openHoursFlow?.id ?? null,
      closedHours: ivr.body.closedHoursFlow?.id ?? null,
      holidayHours: ivr.body.holidayHoursFlow?.id ?? null,
    };
    flowId ??= refs.openHours ?? refs.closedHours ?? refs.holidayHours;
    ok(`IVR ${ivrId}`);
    for (const [slot, id] of Object.entries(refs))
      if (id) console.log(`    ${slot.padEnd(14)} → ${id}`);
    console.log(`    DIDs           ${(ivr.body.dnis ?? []).length}`);
    evidence.probes.ivr = { status: 200, refs, dids: (ivr.body.dnis ?? []).length };
  } else {
    warn(`IVR lookup failed (${ivr.status})`);
    evidence.probes.ivr = { status: ivr.status };
  }
  if (!flowId) {
    bad('no flow to walk');
    await write(evidence);
    process.exit(1);
  }

  // --------------------------------------------------------- flow identity
  head('  step 2  flow identity and version pinning');
  const flow = await attempt('flow', () => arch.getFlow(flowId, {}));
  if (!flow.ok) {
    bad(`flow lookup failed (${flow.status})`);
    await write(evidence);
    process.exit(1);
  }
  const publishedVersion = flow.body.publishedVersion?.id ?? null;
  ok(`${flow.body.name}   type=${flow.body.type}   division=${flow.body.division?.name ?? '?'}`);
  console.log(`    publishedVersion  ${publishedVersion ?? '(none)'}`);
  evidence.probes.flow = { status: 200, type: flow.body.type, publishedVersion };

  const latest = await attempt('latest', () => arch.getFlowLatestconfiguration(flowId, {}));
  const pinned = publishedVersion
    ? await attempt('pinned', () => arch.getFlowVersionConfiguration(flowId, publishedVersion, {}))
    : { ok: false, status: 0 };

  console.log(`    latestconfiguration      ${latest.ok ? 'OK' : 'HTTP ' + latest.status}`);
  console.log(
    `    version ${String(publishedVersion).padEnd(8)} config    ${pinned.ok ? 'OK' : 'HTTP ' + pinned.status}`,
  );
  if (pinned.ok) ok('version pinning works — a capture can target the published version exactly');
  evidence.probes.configuration = { latest: latest.status, pinned: pinned.status };

  const config = pinned.ok ? pinned.body : latest.ok ? latest.body : null;
  if (!config) {
    bad('no flow configuration retrievable');
    await write(evidence);
    process.exit(1);
  }

  // ------------------------------------------- THE FINDING: the manifest
  head('  step 3  manifest — first-order references WITH STABLE IDS');
  const manifest = config.manifest ?? {};
  const rows = [];
  let refCount = 0;
  let withIds = 0;
  let edgeCount = 0;

  for (const [type, list] of Object.entries(manifest)) {
    const entries = Array.isArray(list) ? list : [];
    for (const e of entries) {
      refCount += 1;
      if (typeof e.id === 'string' && e.id.length > 0) withIds += 1;
      const ctx = Array.isArray(e.context) ? e.context : [];
      edgeCount += ctx.length;
      rows.push({ type, id: e.id ?? null, name: e.name ?? null, edges: ctx.length });
    }
  }

  for (const [type, list] of Object.entries(manifest)) {
    const n = Array.isArray(list) ? list.length : 0;
    console.log(`    ${type.padEnd(16)} ${String(n).padStart(3)}`);
  }
  console.log('');
  ok(`${refCount} referenced resource(s), ${edgeCount} reference edge(s)`);

  if (refCount > 0 && withIds === refCount) {
    ok('EVERY reference carries a stable ID — no name-to-ID join needed');
  } else if (refCount > 0) {
    warn(`${refCount - withIds} reference(s) lack a stable ID`);
  }

  const withProvenance = rows.filter((r) => r.edges > 0).length;
  if (withProvenance > 0) {
    ok(`${withProvenance} reference(s) carry node-level provenance (viaNodeId, viaField)`);
  }
  evidence.probes.manifest = {
    types: Object.keys(manifest),
    refCount,
    edgeCount,
    allHaveStableIds: refCount > 0 && withIds === refCount,
    rows: rows.map((r) => ({
      type: r.type,
      hasId: Boolean(r.id),
      nameHash: hash(r.name ?? ''),
      edges: r.edges,
    })),
  };

  // ----------------------------------- second order: data action -> integration
  head('  step 4  second-order walk — data action → integration');
  const actions = Array.isArray(manifest.dataAction) ? manifest.dataAction : [];
  const secondOrder = [];
  if (actions.length === 0) {
    warn('flow consumes no data action');
  }
  for (const a of actions.slice(0, 10)) {
    const act = await attempt('act', () => integ.getIntegrationsAction(a.id, {}));
    if (!act.ok) {
      console.log(`    action ${a.id.slice(0, 24)}…  HTTP ${act.status}`);
      secondOrder.push({ action: hash(a.id), status: act.status });
      continue;
    }
    const integrationId = act.body.integrationId ?? null;
    console.log(`    action     ${act.body.category} / ${String(act.body.name).slice(0, 40)}…`);
    console.log(
      `      contract  ${act.body.contract ? 'present' : 'absent'}   secure=${act.body.secure}`,
    );

    let integrationName = null;
    let credentialsExposed = null;
    if (integrationId) {
      const i = await attempt('int', () => integ.getIntegration(integrationId, {}));
      if (i.ok) {
        integrationName = i.body.name;
        const cfg = i.body.config?.current ?? {};
        credentialsExposed = Object.prototype.hasOwnProperty.call(cfg, 'credentials');
        console.log(`      → integration  ${i.body.name}   type=${i.body.integrationType?.id}`);
        console.log(
          `      → credentials in response: ${credentialsExposed ? 'PRESENT' : 'absent'}`,
        );
      } else {
        console.log(`      → integration  HTTP ${i.status}`);
      }
    }
    secondOrder.push({
      action: hash(a.id),
      status: 200,
      hasContract: Boolean(act.body.contract),
      integration: integrationName ? hash(integrationName) : null,
      credentialsExposed,
    });
  }
  if (secondOrder.some((s) => s.integration)) {
    ok('second-order closure reached: flow → data action → integration, all by stable ID');
  }
  if (secondOrder.every((s) => s.credentialsExposed !== true)) {
    ok('no integration credential was returned by any response');
  } else {
    bad('an integration response contained a credentials field — redactor must strip it');
  }
  evidence.probes.secondOrder = secondOrder;

  // ------------------------------------------------ reverse edges (optional)
  head('  step 5  reverse edges — what USES this flow');
  const consuming = await attempt('rev', () =>
    arch.getArchitectDependencytrackingConsumingresources(flowId, {
      version: publishedVersion ?? '',
    }),
  );
  if (consuming.ok) {
    const ents = consuming.body.entities ?? [];
    ok(`${ents.length} consumer(s) — blast radius available directly`);
    evidence.probes.consuming = { status: 200, count: ents.length };
  } else {
    warn(`dependency-tracking reverse lookup unavailable (${consuming.status})`);
    warn('reverse edges must be computed by inverting the manifest graph across all flows');
    evidence.probes.consuming = { status: consuming.status };
  }

  await write(evidence);
  console.log('\n  evidence  spike-evidence/s3-references.json  (names hashed)\n');
}

async function write(evidence) {
  const dir = join(REPO_ROOT, 'spike-evidence');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 's3-references.json'), JSON.stringify(evidence, null, 2), 'utf8');
}

main().catch((err) => {
  console.error(`\n  FAILED  ${err.message}\n`);
  process.exit(1);
});
