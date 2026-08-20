// packages/analysis/test/findings.test.ts
import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { normalizeFlow } from '@genesys-archivist/normalization';
import { analyzeFlow } from '../src/findings.js';

let analysis: ReturnType<typeof analyzeFlow>;

beforeAll(async () => {
  const config: unknown = JSON.parse(
    await readFile('fixtures/flow-config/inboundcall-47-nodes.json', 'utf8'),
  );
  const snapshot = normalizeFlow({
    config,
    source: {
      provider: 'platform-api',
      adapterVersion: '0.1.0',
      extractedAt: '2026-08-20T00:00:00Z',
      region: 'eu_west_1',
      organizationId: 'org_1',
      trackingIdsAvailable: true,
      redactionApplied: true,
    },
    flow: {
      id: 'f1',
      name: 'Fixture Flow',
      type: 'inboundcall',
      secure: false,
      version: { selected: '4.0', state: 'published' },
    },
  });
  analysis = analyzeFlow(snapshot);
});

describe('analyzeFlow against the real flow', () => {
  it('finds both variables that are read but never written', () => {
    const f = analysis.findings.filter((x) => x.code === 'VARIABLE_READ_NEVER_WRITTEN');
    expect(f).toHaveLength(2);
  });

  it('rates a read-never-written variable as an error, because the branch cannot work', () => {
    const f = analysis.findings.find((x) => x.code === 'VARIABLE_READ_NEVER_WRITTEN');
    expect(f?.severity).toBe('error');
    expect(f?.kind).toBe('derived');
  });

  it('cites evidence for every finding that names a node', () => {
    const ids = new Set(analysis.snapshot.evidence.map((e) => e.evidenceId));
    for (const f of analysis.findings) {
      for (const id of f.evidenceIds) expect(ids.has(id)).toBe(true);
    }
  });

  it('reports no unreachable node in this flow', () => {
    expect(analysis.findings.filter((x) => x.code === 'NODE_UNREACHABLE')).toHaveLength(0);
  });

  it('reports no dangling edge in this flow', () => {
    expect(analysis.findings.filter((x) => x.code === 'EDGE_DANGLING')).toHaveLength(0);
  });

  it('records the cycle as a fact rather than a defect', () => {
    const f = analysis.findings.find((x) => x.code === 'CYCLE_PRESENT');
    expect(f?.kind).toBe('fact');
    expect(f?.severity).toBe('info');
  });

  it('produces caller journeys', () => {
    expect(analysis.journeys.length).toBeGreaterThan(0);
  });

  it('never emits an inference from the deterministic analyzer', () => {
    // packages/analysis calls no model. Anything it says is fact or derived.
    expect(analysis.findings.every((f) => f.kind === 'fact' || f.kind === 'derived')).toBe(true);
  });

  it('is deterministic', () => {
    expect(JSON.stringify(analyzeFlow(analysis.snapshot))).toBe(JSON.stringify(analysis));
  });
});
