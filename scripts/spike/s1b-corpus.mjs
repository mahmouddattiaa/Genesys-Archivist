#!/usr/bin/env node
/**
 * Phase 0 spike S1b — does the normalizer's structural model generalize?
 *
 * S1 proved 100% fidelity for ONE inbound call flow. The organization holds 511
 * flows across 17 types. This samples flows of every type and checks whether the
 * assumptions the normalizer is built on actually hold:
 *
 *   1. every flow uses `flowSequenceItemList` as its container list
 *   2. every node carries a `trackingId`
 *   3. which `__type` values exist beyond the ten already handled
 *   4. which manifest categories exist beyond the seven already handled
 *   5. whether the value wrapper stays lit/emp/ref/operator
 *
 * A "no" to 1 or 2 for any type means the extractors need a second strategy,
 * and it is far cheaper to learn that now than after the documentation layer is
 * built on top.
 *
 * Read-only. Never prints the client secret. Evidence is aggregate and hashed;
 * no flow name, queue name or prompt text is recorded.
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REPO_ROOT, attempt, authenticate, loadSpikeEnv, platformClient } from './env.mjs';

const PER_TYPE = Number(process.argv[2] ?? 2);
const hash = (s) => 'n_' + createHash('sha256').update(String(s)).digest('hex').slice(0, 10);
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => console.log(`  ✗ ${m}`);
const warn = (m) => console.log(`  ! ${m}`);

/** The ten node types the normalizer handles today, from S1. */
const KNOWN_NODE_TYPES = new Set([
  'Task',
  'Menu',
  'MenuAction',
  'PlayAudioAction',
  'TransferMenuAction',
  'TransferTaskAction',
  'TransferPureMatchAction',
  'DecisionAction',
  'DisconnectAction',
  'DataAction',
]);

/** The seven manifest categories seen in the reference flow. */
const KNOWN_MANIFEST = new Set([
  'dataAction',
  'queue',
  'ttsEngine',
  'ttsVoice',
  'language',
  'userPrompt',
  'systemPrompt',
]);

/** Value-wrapper discriminators the ValueRef parser models explicitly. */
const KNOWN_WRAPPERS = new Set(['lit', 'emp', 'ref']);

function profile(cfg) {
  const nodeTypes = new Map();
  const wrappers = new Map();
  let containers = 0;
  let nodes = 0;
  let tracked = 0;

  const list = Array.isArray(cfg.flowSequenceItemList) ? cfg.flowSequenceItemList : null;
  if (list) {
    containers = list.length;
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const visit = (n) => {
        if (!n || typeof n !== 'object') return;
        nodes += 1;
        if ('trackingId' in n) tracked += 1;
        const t = String(n.__type ?? 'UNKNOWN');
        nodeTypes.set(t, (nodeTypes.get(t) ?? 0) + 1);
      };
      visit(item);
      for (const a of item.actionList ?? []) visit(a);
      for (const c of item.menuChoiceList ?? []) visit(c?.action);
    }
  }

  // Value wrappers, anywhere in the document.
  const walk = (v) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== 'object') return;
    if (v.config && typeof v.config === 'object') {
      const [k] = Object.keys(v.config);
      if (k) wrappers.set(k, (wrappers.get(k) ?? 0) + 1);
    }
    Object.values(v).forEach(walk);
  };
  walk(cfg);

  return {
    hasSequenceList: list !== null,
    containers,
    nodes,
    tracked,
    allTracked: nodes > 0 && tracked === nodes,
    nodeTypes: Object.fromEntries(nodeTypes),
    manifestKeys: Object.keys(cfg.manifest ?? {}),
    wrappers: Object.fromEntries(wrappers),
    bytes: JSON.stringify(cfg).length,
  };
}

async function main() {
  const env = await loadSpikeEnv();
  await authenticate(env);
  const arch = new platformClient.ArchitectApi();

  console.log(`\nS1b — structural generalization across flow types (${PER_TYPE} per type)\n`);

  // Unfiltered walk: the server is the authority on which types exist (S2).
  const flows = [];
  let page = 1;
  for (;;) {
    const r = await attempt('flows', () => arch.getFlows({ pageSize: 100, pageNumber: page }));
    if (!r.ok) break;
    const batch = r.body.entities ?? [];
    flows.push(...batch);
    if (batch.length === 0 || (r.body.pageCount && page >= r.body.pageCount)) break;
    page += 1;
  }

  const byType = new Map();
  for (const f of flows) {
    const t = String(f.type ?? 'UNKNOWN').toLowerCase();
    if (!byType.has(t)) byType.set(t, []);
    byType.get(t).push(f);
  }
  console.log(`  ${flows.length} flows across ${byType.size} types\n`);

  const results = [];
  const unknownNodeTypes = new Map();
  const unknownManifest = new Map();
  const unknownWrappers = new Map();
  let noSequenceList = 0;
  let notAllTracked = 0;

  for (const [type, list] of [...byType.entries()].sort()) {
    const sample = list.filter((f) => f.publishedVersion?.id).slice(0, PER_TYPE);
    if (sample.length === 0) {
      console.log(`  ${type.padEnd(22)} — no published version to sample`);
      continue;
    }

    const rows = [];
    for (const f of sample) {
      const r = await attempt('cfg', () =>
        arch.getFlowVersionConfiguration(f.id, f.publishedVersion.id, {}),
      );
      if (!r.ok) {
        rows.push({ flow: hash(f.id), status: r.status });
        continue;
      }
      const p = profile(r.body);
      rows.push({ flow: hash(f.id), status: 200, ...p });

      if (!p.hasSequenceList) noSequenceList += 1;
      if (p.hasSequenceList && !p.allTracked) notAllTracked += 1;
      for (const [t, n] of Object.entries(p.nodeTypes)) {
        if (!KNOWN_NODE_TYPES.has(t)) unknownNodeTypes.set(t, (unknownNodeTypes.get(t) ?? 0) + n);
      }
      for (const k of p.manifestKeys) {
        if (!KNOWN_MANIFEST.has(k)) unknownManifest.set(k, (unknownManifest.get(k) ?? 0) + 1);
      }
      for (const [w, n] of Object.entries(p.wrappers)) {
        if (!KNOWN_WRAPPERS.has(w) && !/^[A-Z_=<>!+*/-]/.test(w) && w !== 'sysref') {
          unknownWrappers.set(w, (unknownWrappers.get(w) ?? 0) + n);
        }
      }
    }

    const good = rows.filter((r) => r.status === 200);
    const seq = good.filter((r) => r.hasSequenceList).length;
    const trk = good.filter((r) => r.allTracked).length;
    const totalNodes = good.reduce((n, r) => n + (r.nodes ?? 0), 0);
    console.log(
      `  ${type.padEnd(22)} sampled ${String(good.length).padStart(2)}  ` +
        `nodes ${String(totalNodes).padStart(4)}  ` +
        `seqList ${seq}/${good.length}  allTracked ${trk}/${good.length}` +
        (good.length < rows.length ? `  (${rows.length - good.length} unreadable)` : ''),
    );
    results.push({ type, rows });
  }

  console.log('\n  --- generalization verdict ---');
  if (noSequenceList === 0) ok('every sampled flow uses flowSequenceItemList');
  else
    bad(
      `${noSequenceList} sampled flow(s) have NO flowSequenceItemList — extractors need a second strategy`,
    );

  if (notAllTracked === 0) ok('every node in every sampled flow carries a trackingId');
  else
    bad(
      `${notAllTracked} sampled flow(s) have nodes WITHOUT a trackingId — deriveNodeId is load-bearing after all`,
    );

  console.log('');
  if (unknownNodeTypes.size === 0) ok('no node type beyond the ten already handled');
  else {
    warn(`${unknownNodeTypes.size} node type(s) beyond the ten handled today:`);
    [...unknownNodeTypes.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 30)
      .forEach(([t, n]) => console.log(`      ${t.padEnd(34)} ${n}`));
  }

  console.log('');
  if (unknownManifest.size === 0) ok('no manifest category beyond the seven already handled');
  else {
    warn(`${unknownManifest.size} manifest categor(ies) beyond the seven handled today:`);
    [...unknownManifest.entries()]
      .sort((a, b) => b[1] - a[1])
      .forEach(([t, n]) => console.log(`      ${t.padEnd(34)} in ${n} flow(s)`));
  }

  if (unknownWrappers.size > 0) {
    console.log('');
    warn('value-wrapper discriminators not modelled explicitly:');
    [...unknownWrappers.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .forEach(([t, n]) => console.log(`      ${t.padEnd(34)} ${n}`));
  }

  const dir = join(REPO_ROOT, 'spike-evidence');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 's1b-corpus.json'),
    JSON.stringify(
      {
        spike: 'S1b',
        perType: PER_TYPE,
        totalFlows: flows.length,
        types: byType.size,
        noSequenceList,
        notAllTracked,
        unknownNodeTypes: Object.fromEntries(unknownNodeTypes),
        unknownManifest: Object.fromEntries(unknownManifest),
        unknownWrappers: Object.fromEntries(unknownWrappers),
        results,
      },
      null,
      2,
    ),
    'utf8',
  );
  console.log('\n  evidence  spike-evidence/s1b-corpus.json  (ids hashed)\n');
}

main().catch((err) => {
  console.error(`\n  FAILED  ${err.message}\n`);
  process.exit(1);
});
