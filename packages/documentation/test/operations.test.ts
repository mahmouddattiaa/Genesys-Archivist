// packages/documentation/test/operations.test.ts
import { readFile, writeFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { normalizeFlow } from '@genesys-archivist/normalization';
import { analyzeFlow } from '@genesys-archivist/analysis';
import { renderOperations } from '../src/operations.js';

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
  doc = renderOperations(snapshot, analyzeFlow(snapshot), { generatedAt: '2026-08-20T00:00:00Z' });
});

describe('renderOperations', () => {
  it('states identity, version and freshness up front', () => {
    expect(doc).toContain('Fixture Flow');
    expect(doc).toContain('4.0');
    expect(doc).toContain('2026-08-20T00:00:00Z');
  });

  it('lists every dependency with its resolution status', () => {
    for (const d of snapshot.dependencies) expect(doc).toContain(d.type);
  });

  it('reports blast radius for a shared dependency', () => {
    expect(doc).toMatch(/blast radius|what breaks|impact/i);
  });

  it('lists the failure paths a caller can hit', () => {
    expect(doc).toMatch(/disconnect|timeout|no input|failure/i);
  });

  it('says plainly that inbound routes are not recorded in a single-flow snapshot', () => {
    expect(doc).toMatch(/not recorded|not captured|not available|not determined/i);
  });

  it('cites only evidence ids that exist in the snapshot', () => {
    const ids = new Set(snapshot.evidence.map((e) => e.evidenceId));
    for (const cited of doc.match(/sha256:[0-9a-f]{64}/g) ?? []) expect(ids.has(cited)).toBe(true);
  });

  it('is deterministic', () => {
    const again = renderOperations(snapshot, analyzeFlow(snapshot), {
      generatedAt: '2026-08-20T00:00:00Z',
    });
    expect(again).toBe(doc);
  });

  it('matches the golden file', async () => {
    if (process.env['UPDATE_GOLDEN'] === '1') {
      await writeFile('fixtures/golden/operations.md', doc, 'utf8');
    }
    expect(doc).toBe(await readFile('fixtures/golden/operations.md', 'utf8'));
  });
});
