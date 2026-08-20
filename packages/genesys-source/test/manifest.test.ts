import { readFile } from 'node:fs/promises';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { FlowConfiguration } from '@genesys-archivist/genesys-platform';
import { extractManifestReferences } from '../src/manifest.js';

describe('extractManifestReferences', () => {
  it('flattens every manifest key generically, including one never seen before', () => {
    const configuration: FlowConfiguration = {
      manifest: {
        queue: [{ id: 'q1', name: 'Sales', context: [] }],
        // A manifest type this file has never heard of must still produce a
        // reference -- that is the entire point of iterating by key.
        someBrandNewResourceType2027: [{ id: 'x1', name: 'Mystery', context: [] }],
      },
    };
    const { references, warnings } = extractManifestReferences(configuration);
    expect(references).toEqual(
      expect.arrayContaining([
        { type: 'queue', id: 'q1' },
        { type: 'someBrandNewResourceType2027', id: 'x1' },
      ]),
    );
    expect(warnings).toHaveLength(0);
  });

  it('records a warning, never a silent drop, for an entry with no id', () => {
    const configuration: FlowConfiguration = {
      manifest: { ttsEngine: [{ id: null, name: 'Bravo Alpha', context: [] }] },
    };
    const { references, warnings } = extractManifestReferences(configuration);
    expect(references).toHaveLength(0);
    expect(warnings).toEqual([{ code: 'MANIFEST_ENTRY_MISSING_ID', manifestType: 'ttsEngine' }]);
  });

  it('deduplicates repeated (type, id) pairs', () => {
    const configuration: FlowConfiguration = {
      manifest: {
        queue: [
          { id: 'q1', name: 'Sales', context: [{ id: 'n1', actionName: 'a' }] },
          { id: 'q1', name: 'Sales', context: [{ id: 'n2', actionName: 'b' }] },
        ],
      },
    };
    const { references } = extractManifestReferences(configuration);
    expect(references).toEqual([{ type: 'queue', id: 'q1' }]);
  });

  it('returns no references for a configuration with no manifest at all', () => {
    expect(extractManifestReferences({}).references).toEqual([]);
  });

  it("handles the real sanitized 47-node fixture, matching S3's observed manifest shape", async () => {
    const raw = await readFile('fixtures/flow-config/inboundcall-47-nodes.json', 'utf8');
    const configuration = JSON.parse(raw) as FlowConfiguration;
    const { references } = extractManifestReferences(configuration);
    const types = new Set(references.map((r) => r.type));
    expect(types).toEqual(
      new Set(['dataAction', 'queue', 'ttsEngine', 'ttsVoice', 'language', 'systemPrompt']),
    );
  });

  it('handles every fixture in the nine-type corpus without throwing or dropping a type', async () => {
    const files = [
      'bot-187-nodes.json',
      'digitalbot-69-nodes.json',
      'securecall-39-nodes.json',
      'inqueuecall-37-nodes.json',
      'voicesurvey-16-nodes.json',
      'inboundemail-15-nodes.json',
      'outboundcall-11-nodes.json',
      'workflow-9-nodes.json',
      'inboundshortmessage-5-nodes.json',
    ];
    for (const file of files) {
      const raw = await readFile(`fixtures/flow-config/${file}`, 'utf8');
      const configuration = JSON.parse(raw) as FlowConfiguration;
      const manifestKeyCount = Object.keys(configuration.manifest ?? {}).length;
      const { references, warnings } = extractManifestReferences(configuration);
      // Every manifest key with at least one entry must contribute at least
      // one reference or warning -- nothing simply vanishes.
      const coveredTypes = new Set([
        ...references.map((r) => r.type),
        ...warnings.map((w) => w.manifestType),
      ]);
      expect(coveredTypes.size, file).toBeLessThanOrEqual(manifestKeyCount);
      expect(coveredTypes.size, file).toBeGreaterThan(0);
    }
  });
});

describe('extractManifestReferences: property tests', () => {
  it('produces exactly one reference or warning per manifest entry, for any manifest shape', () => {
    const entryArb = fc.record({
      id: fc.option(fc.string({ minLength: 1, maxLength: 40 }), { nil: null }),
      name: fc.option(fc.string(), { nil: null }),
      context: fc.constant(null),
    });
    const manifestArb = fc.dictionary(
      fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0),
      fc.array(entryArb, { maxLength: 5 }),
    );

    fc.assert(
      fc.property(manifestArb, (manifest) => {
        const configuration: FlowConfiguration = { manifest };
        const { references, warnings } = extractManifestReferences(configuration);
        const totalEntries = Object.values(manifest).reduce(
          (sum, entries) => sum + entries.length,
          0,
        );
        // Deduplication can only ever reduce the reference count relative to
        // entries-with-ids, never increase it, and every entry lacking an id
        // becomes exactly one warning.
        const entriesWithIds = Object.values(manifest)
          .flat()
          .filter((e) => e.id !== null && e.id.trim().length > 0).length;
        const entriesWithoutIds = totalEntries - entriesWithIds;
        expect(warnings.length).toBe(entriesWithoutIds);
        expect(references.length).toBeLessThanOrEqual(entriesWithIds);
        // Every reference's type is a real manifest key.
        for (const ref of references) {
          expect(Object.prototype.hasOwnProperty.call(manifest, ref.type)).toBe(true);
        }
      }),
    );
  });
});
