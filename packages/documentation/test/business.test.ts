// packages/documentation/test/business.test.ts
import { readFile, writeFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { normalizeFlow } from '@genesys-archivist/normalization';
import { analyzeFlow } from '@genesys-archivist/analysis';
import { renderBusiness } from '../src/business.js';

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
  doc = renderBusiness(snapshot, analyzeFlow(snapshot), { generatedAt: '2026-08-20T00:00:00Z' });
});

describe('renderBusiness', () => {
  it('states identity, version and freshness up front', () => {
    expect(doc).toContain('Fixture Flow');
    expect(doc).toContain('4.0');
    expect(doc).toContain('2026-08-20T00:00:00Z');
  });

  it('reports the true node and edge counts', () => {
    expect(doc).toContain('47');
    expect(doc).toContain('55');
  });

  it('never asserts business intent the configuration cannot prove', () => {
    // The deterministic layer states facts. Purpose is a job for the narrative
    // layer, which is out of scope here and must be visibly absent.
    expect(doc).toMatch(/not recorded|cannot be determined|no business purpose/i);
  });

  it('presents caller journeys in reader-facing terms', () => {
    expect(doc).toMatch(/caller/i);
  });

  it('states plainly that there are exactly four ways out of the IVR', () => {
    expect(doc).toMatch(/four ways/i);
  });

  it('states plainly that most of the graph is mutually reachable', () => {
    expect(doc).toContain('35');
    expect(doc).toMatch(/47/);
  });

  it('never contains a raw node id in the document body', () => {
    // trk_<n> is this fixture's internal node id shape. A product manager
    // reading this document should never see one.
    expect(doc).not.toMatch(/trk_\d+/);
  });

  it('cites only evidence ids that exist in the snapshot', () => {
    const ids = new Set(snapshot.evidence.map((e) => e.evidenceId));
    for (const cited of doc.match(/sha256:[0-9a-f]{64}/g) ?? []) expect(ids.has(cited)).toBe(true);
  });

  it('is deterministic', () => {
    const again = renderBusiness(snapshot, analyzeFlow(snapshot), {
      generatedAt: '2026-08-20T00:00:00Z',
    });
    expect(again).toBe(doc);
  });

  it('matches the golden file', async () => {
    if (process.env['UPDATE_GOLDEN'] === '1') {
      await writeFile('fixtures/golden/business.md', doc, 'utf8');
    }
    expect(doc).toBe(await readFile('fixtures/golden/business.md', 'utf8'));
  });
});
