// packages/documentation/test/technical.test.ts
import { readFile, writeFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { normalizeFlow } from '@genesys-archivist/normalization';
import { analyzeFlow } from '@genesys-archivist/analysis';
import { renderTechnical } from '../src/technical.js';

let doc = '';
let snapshot: ReturnType<typeof normalizeFlow>;

beforeAll(async () => {
  const config: unknown = JSON.parse(
    await readFile('fixtures/flow-config/inboundcall-47-nodes.json', 'utf8'),
  );
  snapshot = normalizeFlow({
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
  doc = renderTechnical(snapshot, analyzeFlow(snapshot), { generatedAt: '2026-08-20T00:00:00Z' });
});

describe('renderTechnical', () => {
  it('states identity, version and freshness up front', () => {
    expect(doc).toContain('Fixture Flow');
    expect(doc).toContain('4.0');
    expect(doc).toContain('platform-api');
  });

  it('reports the true node and edge counts', () => {
    expect(doc).toContain('47');
    expect(doc).toContain('55');
  });

  it('lists every dependency with its resolution status', () => {
    for (const d of snapshot.dependencies) expect(doc).toContain(d.type);
  });

  it('surfaces both read-never-written variables as defects', () => {
    expect(doc).toMatch(/read but never written/i);
  });

  it('cites only evidence ids that exist in the snapshot', () => {
    const ids = new Set(snapshot.evidence.map((e) => e.evidenceId));
    for (const cited of doc.match(/sha256:[0-9a-f]{64}/g) ?? []) expect(ids.has(cited)).toBe(true);
  });

  it('records the generator and normalizer versions', () => {
    expect(doc).toMatch(/generator|normalizer/i);
  });

  it('is deterministic', () => {
    const again = renderTechnical(snapshot, analyzeFlow(snapshot), {
      generatedAt: '2026-08-20T00:00:00Z',
    });
    expect(again).toBe(doc);
  });

  it('matches the golden file', async () => {
    if (process.env['UPDATE_GOLDEN'] === '1') {
      await writeFile('fixtures/golden/technical.md', doc, 'utf8');
    }
    expect(doc).toBe(await readFile('fixtures/golden/technical.md', 'utf8'));
  });

  it('disambiguates a variable name shared across scopes wherever it is named outside the §5 table', () => {
    // The fixture declares two variables named "Foxtrot": one flow-scoped
    // bool, one task-scoped string. Only the flow-scoped one is unused, so
    // that write-up must say which one — the bare name alone is ambiguous.
    const foxtrots = snapshot.variables.filter((v) => v.name === 'Foxtrot');
    expect(foxtrots).toHaveLength(2);
    const flowFoxtrot = foxtrots.find((v) => v.scope === 'flow');
    const taskFoxtrot = foxtrots.find((v) => v.scope === 'task');
    expect(flowFoxtrot).toBeDefined();
    expect(taskFoxtrot).toBeDefined();
    expect(flowFoxtrot!.scope).not.toBe(taskFoxtrot!.scope);

    expect(doc).toContain(`Foxtrot (${flowFoxtrot!.scope}, ${flowFoxtrot!.dataType})`);

    const unusedSection = doc.slice(doc.indexOf('### Variables declared but unused'));
    expect(unusedSection).toContain(`${flowFoxtrot!.scope}, ${flowFoxtrot!.dataType}`);
    expect(unusedSection).not.toContain(`${taskFoxtrot!.scope}, ${taskFoxtrot!.dataType}`);
  });

  it('every evidence mark used in the document resolves to exactly one real id in the §10 index', () => {
    const marksIndex = doc.indexOf('### Evidence marks');
    expect(marksIndex).toBeGreaterThan(-1);
    const marksSection = doc.slice(marksIndex);

    const rows = [...marksSection.matchAll(/\[e(\d+)\]\s*\|\s*(sha256:[0-9a-f]{64})\s*\|/g)];
    expect(rows.length).toBeGreaterThan(0);

    const knownIds = new Set(snapshot.evidence.map((e) => e.evidenceId));
    const idByMark = new Map<string, string>();
    for (const row of rows) {
      const markNumber = row[1]!;
      const evidenceId = row[2]!;
      expect(idByMark.has(markNumber)).toBe(false);
      idByMark.set(markNumber, evidenceId);
      expect(knownIds.has(evidenceId)).toBe(true);
    }

    const body = doc.slice(0, marksIndex);
    const bodyMarks = new Set((body.match(/\[e\d+\]/g) ?? []).map((m) => m.slice(2, -1)));
    for (const markNumber of bodyMarks) {
      expect(idByMark.has(markNumber)).toBe(true);
    }
  });
});
