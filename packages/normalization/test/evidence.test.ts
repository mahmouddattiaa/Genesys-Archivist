// packages/normalization/test/evidence.test.ts
import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseFlowConfig } from '../src/config-schema.js';
import { extractNodes } from '../src/extract-nodes.js';
import { extractVariables } from '../src/extract-variables.js';
import { extractDependencies } from '../src/extract-dependencies.js';
import { buildEvidence } from '../src/evidence.js';

let parts: { cfg: any; nodes: any; vars: any; deps: any };
beforeAll(async () => {
  const raw: unknown = JSON.parse(
    await readFile('fixtures/flow-config/inboundcall-47-nodes.json', 'utf8'),
  );
  const cfg = parseFlowConfig(raw);
  parts = {
    cfg,
    nodes: extractNodes(cfg),
    vars: extractVariables(cfg),
    deps: extractDependencies(cfg),
  };
});

describe('buildEvidence', () => {
  it('produces at least one record per node', () => {
    const ev = buildEvidence(parts.cfg, parts.nodes, parts.vars, parts.deps);
    expect(ev.length).toBeGreaterThanOrEqual(parts.nodes.length);
  });

  it('gives every record a unique deterministic id', () => {
    const ev = buildEvidence(parts.cfg, parts.nodes, parts.vars, parts.deps);
    expect(new Set(ev.map((e) => e.evidenceId)).size).toBe(ev.length);
  });

  it('is deterministic across runs, so hashes stay stable', () => {
    const a = buildEvidence(parts.cfg, parts.nodes, parts.vars, parts.deps);
    const b = buildEvidence(parts.cfg, parts.nodes, parts.vars, parts.deps);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('points at the configuration with a resolvable JSON pointer', () => {
    const ev = buildEvidence(parts.cfg, parts.nodes, parts.vars, parts.deps);
    for (const e of ev.slice(0, 20)) expect(e.sourcePointer.startsWith('/')).toBe(true);
  });

  it('classifies every record', () => {
    const ev = buildEvidence(parts.cfg, parts.nodes, parts.vars, parts.deps);
    const allowed = new Set(['public', 'internal', 'confidential', 'restricted']);
    expect(ev.every((e) => allowed.has(e.classification))).toBe(true);
  });
});
