#!/usr/bin/env node
/**
 * Builds a committable fixture corpus spanning Architect flow types.
 *
 * Why this exists: `packages/normalization` was measured against exactly one
 * inbound-call flow. The scale spike then found this sandbox holds 511 flows
 * across fifteen types — 88 inbound short message, 83 digital bot, 59 bot, 29
 * outbound call, 18 workflow. A normalizer whose reference-field knowledge came
 * from one inbound-call flow is not wrong on those; it is *unmeasured* on them,
 * which is worse, because nothing reports the difference.
 *
 * Synthesizing fixtures from `docs/04` would only re-encode what we already
 * believe. Sanitizing real ones preserves the structural quirks that are the
 * entire reason to have a fixture.
 *
 *   node scripts/spike/make-fixtures.mjs [type ...]
 *
 * AGENTS.md forbids real customer configuration in fixtures/. Every
 * tenant-authored string is replaced deterministically by
 * scripts/spike/sanitize-config.mjs, which also refuses to emit a fixture in
 * which any original GUID survived.
 *
 * Throwaway code. Not production architecture.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REPO_ROOT, attempt, authenticate, loadSpikeEnv, platformClient } from './env.mjs';
import { GUID_RE, det, sanitize } from './sanitize-config.mjs';

const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => console.log(`  ✗ ${m}`);

/**
 * The types worth a fixture, in the order the corpus needs them.
 *
 * Chosen by population in the sandbox and by how different their construct set
 * is from inbound call — a bot flow's node vocabulary shares almost nothing
 * with an IVR's, which is exactly what makes it the useful test.
 */
const DEFAULT_TYPES = [
  'bot',
  'digitalbot',
  'workflow',
  'inboundshortmessage',
  'inqueuecall',
  'outboundcall',
  'commonmodule',
  'inboundemail',
  'securecall',
  'voicesurvey',
];

/**
 * Picks the flow whose configuration is largest among a bounded sample.
 *
 * A fixture's value is the constructs it contains. The smallest published flow
 * of a type is usually a one-node stub that would exercise nothing, so a
 * fixture chosen by "first published" tests almost nothing and looks like
 * coverage.
 */
const SAMPLE_PER_TYPE = 6;

async function firstPage(api, type) {
  const res = await attempt('flows', () =>
    api.getFlows({ type: [type], pageSize: 50, pageNumber: 1 }),
  );
  if (!res.ok) return { entities: [], status: res.status };
  return { entities: res.body?.entities ?? [], status: 200 };
}

async function buildFixture(api, type) {
  const page = await firstPage(api, type);
  if (page.status !== 200) return { type, ok: false, reason: `flows list status ${page.status}` };

  const published = page.entities.filter((f) => f.publishedVersion?.id ?? f.publishedVersion);
  if (published.length === 0) return { type, ok: false, reason: 'no published flow of this type' };

  let best = null;
  for (const flow of published.slice(0, SAMPLE_PER_TYPE)) {
    const version = String(flow.publishedVersion?.id ?? flow.publishedVersion);
    const res = await attempt('config', () =>
      api.getFlowVersionConfiguration(flow.id, version, {}),
    );
    if (!res.ok) continue;
    const bytes = Buffer.byteLength(JSON.stringify(res.body), 'utf8');
    if (best === null || bytes > best.bytes) best = { flow, version, body: res.body, bytes };
  }
  if (best === null) return { type, ok: false, reason: 'no configuration could be fetched' };

  const clean = sanitize(best.body);

  // The same leak guard sanitize-config.mjs applies, repeated here rather than
  // trusted: this script is the one that decides what lands in a committed
  // directory, so it does its own check rather than assuming an import did.
  const originalGuids = new Set();
  const collect = (v) => {
    if (Array.isArray(v)) return v.forEach(collect);
    if (!v || typeof v !== 'object') return;
    for (const val of Object.values(v)) {
      if (typeof val === 'string' && GUID_RE.test(val)) originalGuids.add(val.toLowerCase());
      else collect(val);
    }
  };
  collect(best.body);
  const serialized = JSON.stringify(clean).toLowerCase();
  const survivors = [...originalGuids].filter((g) => serialized.includes(g));
  if (survivors.length > 0) {
    return {
      type,
      ok: false,
      reason: `${survivors.length} original GUID(s) survived sanitization`,
    };
  }

  // An independent content guard, not a repeat of the GUID check.
  //
  // The GUID guard passed on a digital-bot candidate that still carried
  // sixteen of the customer's own intent names -- "cancel service", "inquire
  // about prices" -- because they were object KEYS, and the sanitizer only
  // pseudonymised keys under five hardcoded parents. A guard that only looks
  // for the leak you already know about is not a guard.
  //
  // These two rules would have caught it: every structural key in this API is
  // an ASCII identifier, and no sanitized value contains non-Latin script.
  const contentLeaks = findContentLeaks(clean);
  if (contentLeaks.length > 0) {
    return {
      type,
      ok: false,
      // The offending text is deliberately not echoed: it is the customer data
      // this check exists to keep out of a committed directory.
      reason: `${contentLeaks.length} tenant-text leak(s): ${summarizeLeaks(contentLeaks)}`,
    };
  }

  clean.$archivistFixture = {
    note: 'Sanitized from a real Architect flow configuration. Structure preserved exactly; every tenant-authored string replaced deterministically.',
    sourceFlowIdHash: det(best.flow.id, 12),
    sourceType: type,
    sourceVersion: best.version,
    generatedBy: 'scripts/spike/make-fixtures.mjs',
  };

  const nodeCount = countNodes(best.body);
  const manifestTypes = Object.keys(best.body?.manifest ?? {}).filter((k) =>
    Array.isArray(best.body.manifest[k]),
  );

  return {
    type,
    ok: true,
    bytes: best.bytes,
    nodeCount,
    manifestTypes,
    json: JSON.stringify(clean, null, 2) + '\n',
  };
}

/**
 * Finds strings and keys that cannot have come out of the sanitizer.
 *
 * Non-ASCII anywhere means a tenant string survived: every replacement this
 * pipeline produces is drawn from an ASCII word list, a hex digest, or a
 * language tag. A key containing whitespace means the same -- the API's own
 * keys are camelCase identifiers.
 */
function findContentLeaks(node) {
  const leaks = [];
  const NON_ASCII = /[^ -~]/;
  const walk = (n, path) => {
    if (Array.isArray(n)) return n.forEach((x, i) => walk(x, `${path}[${i}]`));
    if (!n || typeof n !== 'object') return;
    for (const [k, v] of Object.entries(n)) {
      const p = path ? `${path}.${k}` : k;
      if (NON_ASCII.test(k) || /\s/.test(k)) leaks.push({ kind: 'key', path: p });
      if (typeof v === 'string') {
        if (NON_ASCII.test(v)) leaks.push({ kind: 'value', path: p });
      } else walk(v, p);
    }
  };
  walk(node, '');
  return leaks;
}

/** Paths only. The leaking text itself is never printed. */
function summarizeLeaks(leaks) {
  const keys = leaks.filter((l) => l.kind === 'key').length;
  const values = leaks.length - keys;
  const sample = leaks.slice(0, 3).map((l) => l.path.split('.').slice(0, -1).join('.') || '(root)');
  return `${keys} key(s), ${values} value(s) under ${[...new Set(sample)].join(', ')}`;
}

/** Counts objects carrying a trackingId — the node identity ADR-016 settled on. */
function countNodes(body) {
  let n = 0;
  const walk = (v) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== 'object') return;
    if (v.trackingId !== undefined) n += 1;
    for (const val of Object.values(v)) walk(val);
  };
  walk(body);
  return n;
}

async function main() {
  const requested = process.argv.slice(2);
  const types = requested.length > 0 ? requested : DEFAULT_TYPES;

  const env = await loadSpikeEnv();
  console.log(`\nFixture corpus   region=${env.region}   ${types.length} types\n`);
  await authenticate(env);

  const api = new platformClient.ArchitectApi();
  const dir = join(REPO_ROOT, 'fixtures', 'flow-config');
  await mkdir(dir, { recursive: true });

  const built = [];
  for (const type of types) {
    const result = await buildFixture(api, type);
    if (!result.ok) {
      bad(`${type} — ${result.reason}`);
      continue;
    }
    const name = `${type}-${result.nodeCount}-nodes.json`;
    await writeFile(join(dir, name), result.json, 'utf8');
    ok(
      `${name}  ${result.nodeCount} nodes, ${result.bytes} B source, manifest: ${result.manifestTypes.join(', ') || 'none'}`,
    );
    built.push({ type, name, nodeCount: result.nodeCount, manifestTypes: result.manifestTypes });
  }

  console.log('\n' + '─'.repeat(64));
  console.log(`  ${built.length} of ${types.length} fixtures written to fixtures/flow-config/`);
  const allManifestTypes = new Set(built.flatMap((b) => b.manifestTypes));
  console.log(`  manifest resource types across the corpus: ${allManifestTypes.size}`);
  console.log(`    ${[...allManifestTypes].sort().join(', ')}`);
  console.log('─'.repeat(64) + '\n');
}

main().catch((err) => {
  console.error(`\nFixture build failed: ${err?.message ?? 'unknown error'}\n`);
  process.exitCode = 1;
});
