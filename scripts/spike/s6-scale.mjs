#!/usr/bin/env node
/**
 * Phase 0 spike — scale budgets.
 *
 * Question: what are realistic extraction size, latency, memory, and request
 * count budgets, and does an organization-wide capture finish in a time a
 * person will wait for?
 *
 * This is the number the product promise rests on. ADR-018 splits capture into
 * `context` (fast, whole-org, "what does this IVR do") and `migration`
 * (everything). "Fast" is a claim, and until this runs it is an unmeasured one.
 *
 * Measures, read-only:
 *   1. Every flow in the organization, by type and division.
 *   2. Latency and response size of getFlowVersionConfiguration per flow —
 *      the single call ADR-015 made the primary source.
 *   3. Manifest size per flow: how many resources a context capture names.
 *   4. Request count for a full context-mode capture.
 *   5. Extrapolation to 100 / 300 / 500 flows.
 *
 * Throwaway code. Not production architecture. Do not import it from packages/.
 *
 * NEVER prints the client secret, a flow name, or configuration content. Flow
 * names are customer configuration; evidence stores hashes, sizes, and timings.
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REPO_ROOT, attempt, authenticate, loadSpikeEnv, platformClient } from './env.mjs';

const hash = (s) => 'n_' + createHash('sha256').update(String(s)).digest('hex').slice(0, 12);
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => console.log(`  ✗ ${m}`);
const warn = (m) => console.log(`  ! ${m}`);

/** Every Architect flow type. Release 1 captures all of them. */
const FLOW_TYPES = [
  'inboundcall',
  'inboundchat',
  'inboundemail',
  'inboundshortmessage',
  'outboundcall',
  'inqueuecall',
  'inqueueemail',
  'inqueueshortmessage',
  'securecall',
  'speech',
  'survey',
  'voicesurvey',
  'bot',
  'digitalbot',
  'commonmodule',
  'voicemail',
  'workflow',
  'workitem',
];

/**
 * Cap the configuration fetches.
 *
 * A full org-wide fetch is the thing being extrapolated *to*, not the thing
 * being run: this is a measurement, and it must not become an unbudgeted
 * capture of a tenant's entire Architect estate as a side effect.
 */
const MAX_CONFIG_FETCHES = 40;

const percentile = (sorted, p) => {
  if (sorted.length === 0) return null;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
};

async function pageThrough(call, { pageSize = 100, maxPages = 100 } = {}) {
  const entities = [];
  let pageNumber = 1;
  let requests = 0;
  for (;;) {
    const res = await attempt('page', () => call({ pageSize, pageNumber }));
    requests += 1;
    if (!res.ok) return { entities, requests, status: res.status, complete: false };
    const batch = res.body?.entities ?? [];
    entities.push(...batch);
    const pageCount = res.body?.pageCount;
    if (batch.length === 0) break;
    if (typeof pageCount === 'number' && pageNumber >= pageCount) break;
    if (pageNumber >= maxPages) return { entities, requests, status: 200, complete: false };
    pageNumber += 1;
  }
  return { entities, requests, status: 200, complete: true };
}

/**
 * Counts the resources a manifest names, by type.
 *
 * Iterates the manifest's own keys rather than a fixed list, for the same
 * reason the production adapter must: S3 measured seven types on one flow, and
 * a type this script has never seen is exactly the thing worth counting.
 */
function summarizeManifest(manifest) {
  if (manifest === null || typeof manifest !== 'object') return { types: {}, total: 0, edges: 0 };
  const types = {};
  let total = 0;
  let edges = 0;
  for (const [key, value] of Object.entries(manifest)) {
    if (!Array.isArray(value)) continue;
    types[key] = value.length;
    total += value.length;
    for (const entry of value) {
      if (Array.isArray(entry?.context)) edges += entry.context.length;
    }
  }
  return { types, total, edges };
}

async function main() {
  const env = await loadSpikeEnv();
  console.log(`\nScale budgets   region=${env.region}\n`);
  await authenticate(env);
  ok('authenticated (client credentials grant)');

  const api = new platformClient.ArchitectApi();

  console.log('\nDiscovery');
  const discoveryStart = performance.now();
  const flows = [];
  let discoveryRequests = 0;
  const byType = {};

  for (const type of FLOW_TYPES) {
    const page = await pageThrough((p) => api.getFlows({ ...p, type: [type] }));
    discoveryRequests += page.requests;
    if (page.status === 403) {
      bad(`${type} — 403`);
      continue;
    }
    if (!page.complete) warn(`${type} — pagination did not complete`);
    byType[type] = page.entities.length;
    for (const f of page.entities) flows.push({ ...f, discoveredType: type });
  }
  const discoveryMs = Math.round(performance.now() - discoveryStart);

  ok(`${flows.length} flows in ${discoveryRequests} requests, ${discoveryMs} ms`);
  for (const [type, n] of Object.entries(byType)) {
    if (n > 0) console.log(`      ${String(n).padStart(4)}  ${type}`);
  }

  const published = flows.filter((f) => f.publishedVersion?.id ?? f.publishedVersion);
  ok(`${published.length} have a published version`);

  console.log(`\nConfiguration fetch (${Math.min(MAX_CONFIG_FETCHES, published.length)} sampled)`);
  const samples = [];
  let configRequests = 0;

  for (const flow of published.slice(0, MAX_CONFIG_FETCHES)) {
    const version = flow.publishedVersion?.id ?? flow.publishedVersion;
    const started = performance.now();
    const res = await attempt('config', () =>
      api.getFlowVersionConfiguration(flow.id, String(version), {}),
    );
    const ms = Math.round(performance.now() - started);
    configRequests += 1;

    if (!res.ok) {
      samples.push({
        flowId: hash(flow.id),
        type: flow.discoveredType,
        ok: false,
        status: res.status,
        ms,
      });
      bad(`${flow.discoveredType} — status ${res.status} (${ms} ms)`);
      continue;
    }

    // Serialized size is the honest proxy for what crosses the wire and what
    // the normalizer has to hold. It is not the compressed transfer size.
    const serialized = JSON.stringify(res.body);
    const manifest = summarizeManifest(res.body?.manifest ?? null);

    samples.push({
      flowId: hash(flow.id),
      type: flow.discoveredType,
      ok: true,
      status: 200,
      ms,
      bytes: Buffer.byteLength(serialized, 'utf8'),
      manifestResources: manifest.total,
      manifestEdges: manifest.edges,
      manifestTypes: manifest.types,
    });
  }

  const good = samples.filter((s) => s.ok);
  const latencies = good.map((s) => s.ms).sort((a, b) => a - b);
  const sizes = good.map((s) => s.bytes).sort((a, b) => a - b);
  const resources = good.map((s) => s.manifestResources).sort((a, b) => a - b);

  const meanMs =
    latencies.length > 0 ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;
  const meanBytes =
    sizes.length > 0 ? Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length) : 0;

  ok(`${good.length}/${samples.length} configurations fetched`);
  console.log(
    `      latency  p50 ${percentile(latencies, 50)} ms   p95 ${percentile(latencies, 95)} ms   max ${latencies.at(-1)} ms   mean ${meanMs} ms`,
  );
  console.log(
    `      size     p50 ${percentile(sizes, 50)} B   p95 ${percentile(sizes, 95)} B   max ${sizes.at(-1)} B   mean ${meanBytes} B`,
  );
  console.log(
    `      manifest p50 ${percentile(resources, 50)}   max ${resources.at(-1)} resources per flow`,
  );

  /**
   * Extrapolation, stated as a budget rather than a prediction.
   *
   * Serial, one request at a time, which is the conservative floor: the
   * production adapter will run some concurrency, and Genesys rate limits will
   * claw some of that back. A number that assumes no concurrency and no
   * throttling is the one worth planning against.
   */
  console.log('\nContext-mode budget (serial, no concurrency, no throttling)');
  const projections = [100, 300, 500].map((n) => ({
    flows: n,
    requests: n,
    seconds: Math.round((n * meanMs) / 1000),
    megabytes: Number(((n * meanBytes) / 1_048_576).toFixed(1)),
  }));
  for (const p of projections) {
    const mins = (p.seconds / 60).toFixed(1);
    console.log(
      `      ${String(p.flows).padStart(3)} flows  →  ${p.requests} requests, ~${p.seconds}s (${mins} min), ~${p.megabytes} MB`,
    );
  }
  console.log(
    '      context mode costs ONE request per flow: ADR-018 reads the manifest\n' +
      '      inline from the configuration response rather than walking to closure.',
  );

  const heap = Math.round(process.memoryUsage().heapUsed / 1_048_576);
  console.log(`\n      peak heap this process: ~${heap} MB`);

  console.log('\n' + '─'.repeat(64));
  console.log(`  flows discovered:  ${flows.length}  (${published.length} published)`);
  console.log(`  discovery cost:    ${discoveryRequests} requests, ${discoveryMs} ms`);
  console.log(`  config sampled:    ${good.length} of ${published.length}`);
  console.log(`  mean per flow:     ${meanMs} ms, ${meanBytes} B`);
  console.log('─'.repeat(64) + '\n');

  const dir = join(REPO_ROOT, 'spike-evidence');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 's6-scale.json'),
    JSON.stringify(
      {
        spike: 'scale-budgets',
        region: env.region,
        discovery: {
          flows: flows.length,
          published: published.length,
          byType,
          requests: discoveryRequests,
          milliseconds: discoveryMs,
        },
        configuration: {
          sampled: samples.length,
          succeeded: good.length,
          requests: configRequests,
          latencyMs: {
            p50: percentile(latencies, 50),
            p95: percentile(latencies, 95),
            max: latencies.at(-1) ?? null,
            mean: meanMs,
          },
          bytes: {
            p50: percentile(sizes, 50),
            p95: percentile(sizes, 95),
            max: sizes.at(-1) ?? null,
            mean: meanBytes,
          },
          manifestResources: {
            p50: percentile(resources, 50),
            max: resources.at(-1) ?? null,
          },
        },
        projections,
        heapMegabytes: heap,
        samples,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
  console.log('evidence → spike-evidence/s6-scale.json\n');
}

main().catch((err) => {
  console.error(`\nScale spike failed: ${err?.message ?? 'unknown error'}\n`);
  process.exitCode = 1;
});
