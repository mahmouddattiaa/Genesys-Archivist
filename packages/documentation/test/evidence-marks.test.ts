// packages/documentation/test/evidence-marks.test.ts
//
// business.md, technical.md, and operations.md are one deliverable and must
// share one evidence-citation notation: a short `[eN]` mark in the body,
// defined exactly once in a mark table at the end of the same document.
// Each renderer's own golden test already exercises its prose; this test
// exists because the "does every mark resolve, exactly once, within this
// document" property only makes sense checked across all three at once.
import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { normalizeFlow } from '@genesys-archivist/normalization';
import { analyzeFlow } from '@genesys-archivist/analysis';
import { renderBusiness } from '../src/business.js';
import { renderTechnical } from '../src/technical.js';
import { renderOperations } from '../src/operations.js';

let docs: Record<string, string>;

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
  const analysis = analyzeFlow(snapshot);
  const ctx = { generatedAt: '2026-08-20T00:00:00Z' };

  docs = {
    'business.md': renderBusiness(snapshot, analysis, ctx),
    'technical.md': renderTechnical(snapshot, analysis, ctx),
    'operations.md': renderOperations(snapshot, analysis, ctx),
  };
});

describe('evidence marks across the deterministic document set', () => {
  it('every [eN] mark used in a document body is defined exactly once in that document mark table', () => {
    for (const [name, contents] of Object.entries(docs)) {
      const defined = new Map<string, number>();
      for (const m of contents.matchAll(/^\|\s*\[e(\d+)\]\s*\|/gm)) {
        const mark = m[1] as string;
        defined.set(mark, (defined.get(mark) ?? 0) + 1);
      }
      expect(defined.size, `${name} defines no marks`).toBeGreaterThan(0);

      for (const [mark, occurrences] of defined) {
        expect(occurrences, `${name} defines [e${mark}] more than once`).toBe(1);
      }

      const used = new Set<string>();
      for (const m of contents.matchAll(/\[e(\d+)\]/g)) used.add(m[1] as string);
      for (const mark of used) {
        expect(defined.has(mark), `${name} uses [e${mark}] without defining it`).toBe(true);
      }
    }
  });

  it('every mark table entry is a real evidence id from the snapshot', async () => {
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
    const knownIds = new Set(snapshot.evidence.map((e) => e.evidenceId));

    for (const [name, contents] of Object.entries(docs)) {
      const rows = [...contents.matchAll(/\[e\d+\]\s*\|\s*(sha256:[0-9a-f]{64})\s*\|/g)];
      expect(rows.length, `${name} mark table has no rows`).toBeGreaterThan(0);
      for (const row of rows) {
        expect(knownIds.has(row[1] as string), `${name} mark table cites an unknown id`).toBe(true);
      }
    }
  });
});
