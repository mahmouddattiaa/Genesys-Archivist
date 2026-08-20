#!/usr/bin/env node
/**
 * Phase 0 spike S1 — source fidelity.
 *
 * Compares the Platform API flow configuration against a manual Architect UI
 * YAML export of the same flow version, and answers the question S3 handed
 * back: does the JSON configuration carry a stable identifier on EVERY node,
 * or only on nodes that reference an external resource?
 *
 * Usage:
 *   node scripts/spike/s1-fidelity.mjs <path-to-yaml> [flowId] [version]
 *
 * The YAML export is customer configuration and is gitignored. Evidence written
 * to spike-evidence/ records counts and hashes, never names or expressions.
 *
 * Throwaway code. Never prints the client secret.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { REPO_ROOT, attempt, authenticate, loadSpikeEnv, platformClient } from './env.mjs';

const hash = (s) => 'n_' + createHash('sha256').update(String(s)).digest('hex').slice(0, 12);
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => console.log(`  ✗ ${m}`);
const warn = (m) => console.log(`  ! ${m}`);
const head = (m) => console.log(`\n${m}`);

/**
 * YAML construct -> JSON __type. Derived empirically from this corpus; every
 * entry is evidence, not an assumption. A sub-menu produces BOTH a Menu
 * container and a MenuAction entry point, which is why menuSubMenu maps to two.
 */
const TYPE_MAP = {
  playAudio: ['PlayAudioAction'],
  jumpToMenu: ['TransferMenuAction'],
  menuJumpToMenu: ['TransferMenuAction'],
  task: ['Task'],
  menuJumpToTask: ['TransferTaskAction'],
  menuTransferToAcd: ['TransferPureMatchAction'],
  transferToAcd: ['TransferPureMatchAction'],
  decision: ['DecisionAction'],
  menu: ['Menu'],
  menuSubMenu: ['Menu', 'MenuAction'],
  disconnect: ['DisconnectAction'],
  callData: ['DataAction'],
};

/**
 * Counts YAML action constructs.
 *
 * Actions appear ONLY as single-key list items: `- playAudio:`, `- decision:`.
 * Counting object properties as well double-counts every action, and also picks
 * up `settingsActionDefaults.callData` and `settingsErrorHandling…disconnect`,
 * which are default-settings blocks rather than actions in the flow.
 */
function profileYaml(node, counts = new Map()) {
  if (Array.isArray(node)) {
    for (const item of node) {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const keys = Object.keys(item);
        if (keys.length === 1 && TYPE_MAP[keys[0]]) {
          counts.set(keys[0], (counts.get(keys[0]) ?? 0) + 1);
        }
      }
      profileYaml(item, counts);
    }
    return counts;
  }
  if (!node || typeof node !== 'object') return counts;
  for (const v of Object.values(node)) profileYaml(v, counts);
  return counts;
}

/** Collects every object in the JSON config that carries a trackingId. */
function profileJson(cfg) {
  const tracked = [];
  const walk = (v, path) => {
    if (Array.isArray(v)) {
      for (const x of v) walk(x, path + '[]');
      return;
    }
    if (!v || typeof v !== 'object') return;
    if ('trackingId' in v) {
      tracked.push({
        path,
        trackingId: Number(v.trackingId),
        type: v.__type ?? v.type ?? 'UNKNOWN',
        name: typeof v.name === 'string' ? v.name : (v.name?.lit ?? null),
      });
    }
    for (const k of Object.keys(v)) walk(v[k], path ? `${path}.${k}` : k);
  };
  walk(cfg, '');
  return tracked;
}

async function main() {
  const yamlPath = process.argv[2];
  const flowId = process.argv[3] ?? 'b97e0e67-65fd-4d9a-a899-da5f24e702ba';
  const version = process.argv[4] ?? null;

  if (!yamlPath) {
    console.error(
      '\n  usage: node scripts/spike/s1-fidelity.mjs <path-to-yaml> [flowId] [version]\n',
    );
    process.exit(1);
  }

  const env = await loadSpikeEnv();
  const evidence = { spike: 'S1', flowIdHash: hash(flowId), probes: {} };
  const arch = new platformClient.ArchitectApi();

  console.log('\nS1 — source fidelity  (Platform API config vs manual YAML export)');
  await authenticate(env);
  ok('authenticated');

  // ------------------------------------------------------------ fetch config
  const flow = await attempt('flow', () => arch.getFlow(flowId, {}));
  if (!flow.ok) {
    bad(`flow lookup failed (${flow.status})`);
    process.exit(1);
  }
  const targetVersion = version ?? flow.body.publishedVersion?.id ?? null;
  head(`  flow  ${flow.body.name}  v${targetVersion}`);

  const res = targetVersion
    ? await attempt('cfg', () => arch.getFlowVersionConfiguration(flowId, targetVersion, {}))
    : await attempt('cfg', () => arch.getFlowLatestconfiguration(flowId, {}));
  if (!res.ok) {
    bad(`configuration unavailable (${res.status})`);
    process.exit(1);
  }
  const cfg = res.body;
  const bytes = JSON.stringify(cfg).length;
  ok(`configuration retrieved  ${(bytes / 1024).toFixed(1)} KiB`);

  // ------------------------------------------------- THE QUESTION: node IDs
  head('  node identity — does every node carry a stable ID?');
  const tracked = profileJson(cfg);
  const ids = tracked.map((t) => t.trackingId);
  const unique = new Set(ids);
  const min = Math.min(...ids);
  const max = Math.max(...ids);

  console.log(`    nodes with trackingId   ${tracked.length}`);
  console.log(`    trackingId range        ${min} .. ${max}`);
  console.log(`    nextTrackingNumber      ${cfg.nextTrackingNumber}`);
  console.log(`    duplicates              ${tracked.length - unique.size}`);

  const byPath = {};
  for (const t of tracked) byPath[t.path] = (byPath[t.path] ?? 0) + 1;
  console.log('\n    by container path');
  for (const [p, c] of Object.entries(byPath).sort((a, b) => b[1] - a[1])) {
    console.log(`      ${String(c).padStart(3)}  ${p}`);
  }

  console.log('');
  if (tracked.length - unique.size === 0) ok('trackingIds are unique across the flow');
  if (Number(cfg.nextTrackingNumber) > max) {
    ok('nextTrackingNumber exceeds every assigned id — the allocator is monotonic');
  }

  const byType = {};
  for (const t of tracked) byType[t.type] = (byType[t.type] ?? 0) + 1;
  evidence.probes.nodes = {
    count: tracked.length,
    min,
    max,
    duplicates: tracked.length - unique.size,
    nextTrackingNumber: cfg.nextTrackingNumber,
    byPath,
    byType,
    configBytes: bytes,
  };

  // --------------------------------------------------- structural comparison
  head('  structural comparison against the manual YAML export');
  const yamlDoc = parseYaml(await readFile(yamlPath, 'utf8'));
  const yamlCounts = profileYaml(yamlDoc);

  // Project YAML construct counts into JSON __type space.
  const expected = {};
  for (const [construct, n] of yamlCounts) {
    for (const jsonType of TYPE_MAP[construct] ?? []) {
      expected[jsonType] = (expected[jsonType] ?? 0) + n;
    }
  }

  const allTypes = [...new Set([...Object.keys(expected), ...Object.keys(byType)])].sort();
  console.log(
    `    ${'JSON __type'.padEnd(26)} ${'YAML'.padStart(5)} ${'JSON'.padStart(5)}   verdict`,
  );
  let matched = 0;
  let mismatched = 0;
  const diffs = [];
  for (const t of allTypes) {
    const y = expected[t] ?? 0;
    const j = byType[t] ?? 0;
    const verdict = y === j ? 'match' : `DIFF ${j - y > 0 ? '+' : ''}${j - y}`;
    if (y === j) matched += 1;
    else {
      mismatched += 1;
      diffs.push({ type: t, yaml: y, json: j });
    }
    console.log(
      `    ${t.padEnd(26)} ${String(y).padStart(5)} ${String(j).padStart(5)}   ${verdict}`,
    );
  }
  const yTotal = Object.values(expected).reduce((a, b) => a + b, 0);
  const jTotal = tracked.length;
  console.log(
    `    ${'TOTAL'.padEnd(26)} ${String(yTotal).padStart(5)} ${String(jTotal).padStart(5)}`,
  );

  console.log('');
  if (mismatched === 0) {
    ok(`every construct type matches — ${matched}/${allTypes.length} types, ${jTotal} nodes`);
  } else {
    warn(`${mismatched} type(s) differ — each difference must be explained, not tolerated`);
  }

  // -------------------------------------------------------- YAML refId count
  const yamlRefIds = (await readFile(yamlPath, 'utf8')).match(/refId:/g)?.length ?? 0;
  console.log(`    YAML refId count        ${yamlRefIds}`);
  console.log(`    JSON trackingId count   ${tracked.length}`);
  if (yamlRefIds < tracked.length) {
    warn(`the YAML export carries ${yamlRefIds} identifiers against the JSON's ${tracked.length}`);
    warn('this export was almost certainly taken WITHOUT "include tracking IDs" enabled');
  }

  evidence.probes.comparison = {
    yamlConstructCounts: Object.fromEntries(yamlCounts),
    expectedByJsonType: expected,
    actualByJsonType: byType,
    matchedTypes: matched,
    mismatchedTypes: mismatched,
    diffs,
    yamlTotal: yTotal,
    jsonTotal: jTotal,
    yamlRefIds,
  };

  await write(evidence);
  console.log('\n  evidence  spike-evidence/s1-fidelity.json  (names hashed)\n');
}

async function write(evidence) {
  const dir = join(REPO_ROOT, 'spike-evidence');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 's1-fidelity.json'), JSON.stringify(evidence, null, 2), 'utf8');
}

main().catch((err) => {
  console.error(`\n  FAILED  ${err.message}\n`);
  process.exit(1);
});
