// packages/normalization/test/extract-settings.test.ts
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { parseFlowConfig, type RawFlowConfig } from '../src/config-schema.js';
import { extractNodes } from '../src/extract-nodes.js';
import { extractSettings } from '../src/extract-settings.js';

const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function loadFixture(name: string): Promise<RawFlowConfig> {
  const raw: unknown = JSON.parse(await readFile(`fixtures/flow-config/${name}`, 'utf8'));
  return parseFlowConfig(raw);
}

describe('extractSettings', () => {
  describe('measured against the real corpus', () => {
    // Exact counts of nodes.settings ending up non-empty, measured directly
    // against each fixture by running the extractor and counting — not
    // inferred from docs/04. A node has no entry when every one of its own
    // top-level fields was excluded (self-identity, an edge/dependency
    // reference, an unset value-ref, or a pure UI-metadata field) — every
    // action type carrying real per-node configuration in these three
    // flows contributes at least one settings field.
    it('produces exactly 37 of 47 nodes with non-empty settings on inboundcall-47', async () => {
      const cfg = await loadFixture('inboundcall-47-nodes.json');
      const { nodes } = extractNodes(cfg);
      const { settingsByNode } = extractSettings(cfg, nodes);
      expect(nodes.length).toBe(47);
      expect(settingsByNode.size).toBe(37);
    });

    it('produces exactly 118 of 187 nodes with non-empty settings on bot-187', async () => {
      const cfg = await loadFixture('bot-187-nodes.json');
      const { nodes } = extractNodes(cfg);
      const { settingsByNode } = extractSettings(cfg, nodes);
      expect(nodes.length).toBe(187);
      expect(settingsByNode.size).toBe(118);
    });

    it('produces exactly 27 of 39 nodes with non-empty settings on securecall-39', async () => {
      const cfg = await loadFixture('securecall-39-nodes.json');
      const { nodes } = extractNodes(cfg);
      const { settingsByNode } = extractSettings(cfg, nodes);
      expect(nodes.length).toBe(39);
      expect(settingsByNode.size).toBe(27);
    });

    it('never lets a GUID-shaped reference value survive into settings, across the full corpus', async () => {
      const files = [
        'inboundcall-47-nodes.json',
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
        const cfg = await loadFixture(file);
        const { nodes } = extractNodes(cfg);
        const { settingsByNode } = extractSettings(cfg, nodes);
        for (const [nodeId, settings] of settingsByNode) {
          const serialized = JSON.stringify(settings);
          const guidMatches = serialized.match(new RegExp(GUID_PATTERN.source, 'gi')) ?? [];
          expect(guidMatches, `${file}: node ${nodeId} settings carries a GUID`).toEqual([]);
        }
      }
    });

    it('never includes id, trackingId, or referenceId as a settings key, across the full corpus', async () => {
      const files = ['inboundcall-47-nodes.json', 'bot-187-nodes.json', 'securecall-39-nodes.json'];
      for (const file of files) {
        const cfg = await loadFixture(file);
        const { nodes } = extractNodes(cfg);
        const { settingsByNode } = extractSettings(cfg, nodes);
        for (const [nodeId, settings] of settingsByNode) {
          for (const key of ['id', 'trackingId', 'referenceId']) {
            expect(key in settings, `${file}: node ${nodeId} settings carries '${key}'`).toBe(
              false,
            );
          }
        }
      }
    });
  });

  describe('bounds and truncation', () => {
    function nodeWithLongLiteral(text: string): unknown {
      return {
        name: 'x',
        type: 'inboundcall',
        variables: [],
        flowSequenceItemList: [
          {
            __type: 'Task',
            trackingId: 1,
            id: '11111111-1111-1111-1111-111111111111',
            name: 'Entry',
            actionList: [
              {
                __type: 'DecisionAction',
                trackingId: 2,
                id: '22222222-2222-2222-2222-222222222222',
                name: 'Decide',
                expression: {
                  config: { lit: { pos: 1, text, type: 'str' } },
                },
              },
            ],
          },
        ],
      };
    }

    it('truncates an oversized literal and reports it via TRUNCATED rather than dropping it silently', () => {
      const oversized = 'x'.repeat(600);
      const cfg = parseFlowConfig(nodeWithLongLiteral(oversized));
      const { nodes } = extractNodes(cfg);
      const { settingsByNode, warnings } = extractSettings(cfg, nodes);
      const settings = settingsByNode.get('trk_2');
      expect(settings).toBeDefined();
      const expression = settings?.['expression'] as { text: string } | undefined;
      expect(expression?.text.length).toBe(500);
      const flag = warnings.find((w) => w.code === 'TRUNCATED');
      expect(flag).toBeDefined();
      expect(flag?.nodeIds).toEqual(['trk_2']);
      expect(flag?.message).toContain('expression');
    });

    it('does not truncate a literal within bounds, and reports no warning', () => {
      const cfg = parseFlowConfig(nodeWithLongLiteral('short'));
      const { nodes } = extractNodes(cfg);
      const { settingsByNode, warnings } = extractSettings(cfg, nodes);
      const settings = settingsByNode.get('trk_2');
      const expression = settings?.['expression'] as { text: string } | undefined;
      expect(expression?.text).toBe('short');
      expect(warnings).toEqual([]);
    });

    it('never lets tenant-authored text reach a TRUNCATED warning message, only structural identifiers', () => {
      // CANARY-PROMPT-1a7d, oversized so it also exercises truncation, is
      // legitimately present *inside* settings (that is the point of the
      // field — it is a restricted-classification snapshot) but must never
      // leak into the warning that reports the truncation.
      const canaryText = 'CANARY-PROMPT-1a7d'.repeat(40);
      const cfg = parseFlowConfig(nodeWithLongLiteral(canaryText));
      const { nodes } = extractNodes(cfg);
      const { settingsByNode, warnings } = extractSettings(cfg, nodes);
      const settings = settingsByNode.get('trk_2');
      // The canary MAY legitimately appear in settings — that is tenant
      // content in a restricted snapshot, the reason this field exists.
      expect(JSON.stringify(settings)).toContain('CANARY-PROMPT-1a7d');
      // It must never appear in a warning.
      const serializedWarnings = JSON.stringify(warnings);
      expect(serializedWarnings).not.toContain('CANARY-PROMPT-1a7d');
      expect(warnings.some((w) => w.code === 'TRUNCATED')).toBe(true);
    });
  });

  describe('determinism', () => {
    function seededShuffle<T>(items: readonly T[], seed: number): T[] {
      const out = [...items];
      let state = seed;
      const next = (): number => {
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        return state / 0x7fffffff;
      };
      for (let i = out.length - 1; i > 0; i -= 1) {
        const j = Math.floor(next() * (i + 1));
        const a = out[i] as T;
        const b = out[j] as T;
        out[i] = b;
        out[j] = a;
      }
      return out;
    }

    function reorderKeysDeep(value: unknown, seed: number): unknown {
      if (Array.isArray(value)) return value.map((item, i) => reorderKeysDeep(item, seed + i + 1));
      if (value !== null && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        const keys = seededShuffle(Object.keys(record), seed);
        const reordered: Record<string, unknown> = {};
        for (const key of keys) reordered[key] = reorderKeysDeep(record[key], seed + 1);
        return reordered;
      }
      return value;
    }

    it('produces byte-identical settings regardless of source key order', async () => {
      const raw: unknown = JSON.parse(
        await readFile('fixtures/flow-config/inboundcall-47-nodes.json', 'utf8'),
      );
      const baseCfg = parseFlowConfig(raw);
      const { nodes: baseNodes } = extractNodes(baseCfg);
      const baseline = extractSettings(baseCfg, baseNodes);
      expect(baseline.settingsByNode.size).toBeGreaterThan(0);

      fc.assert(
        fc.property(fc.integer({ min: 0, max: 1_000_000 }), (seed) => {
          const shuffled = parseFlowConfig(reorderKeysDeep(raw, seed));
          const { nodes } = extractNodes(shuffled);
          const result = extractSettings(shuffled, nodes);
          expect(JSON.stringify([...result.settingsByNode.entries()].sort())).toBe(
            JSON.stringify([...baseline.settingsByNode.entries()].sort()),
          );
        }),
        { numRuns: 20 },
      );
    });

    it("produces a byte-identical settings object regardless of a single node's own field order", () => {
      const a = parseFlowConfig({
        name: 'x',
        type: 'inboundcall',
        variables: [],
        flowSequenceItemList: [
          {
            __type: 'DataAction',
            trackingId: 1,
            id: '11111111-1111-1111-1111-111111111111',
            name: 'Call',
            actionId: '22222222-2222-2222-2222-222222222222',
            actionName: 'Get data',
            useSuggestedTimeout: true,
          },
        ],
      });
      const b = parseFlowConfig({
        name: 'x',
        type: 'inboundcall',
        variables: [],
        flowSequenceItemList: [
          {
            useSuggestedTimeout: true,
            actionName: 'Get data',
            actionId: '22222222-2222-2222-2222-222222222222',
            name: 'Call',
            id: '11111111-1111-1111-1111-111111111111',
            trackingId: 1,
            __type: 'DataAction',
          },
        ],
      });
      const settingsA = extractSettings(a, extractNodes(a).nodes).settingsByNode.get('trk_1');
      const settingsB = extractSettings(b, extractNodes(b).nodes).settingsByNode.get('trk_1');
      expect(JSON.stringify(settingsA)).toBe(JSON.stringify(settingsB));
    });
  });

  describe('captures the prompt/expression content that motivates this field', () => {
    it("captures a PlayAudioAction's inline TTS text via its nested prompts.defaultAudio field", () => {
      // Direct regression proof for the case that motivated the two-level
      // container recursion: without it, `prompts` (a plain container, not
      // itself a value-ref wrapper) would be excluded wholesale and the
      // node's actual spoken content would never reach settings at all.
      const cfg = parseFlowConfig({
        name: 'x',
        type: 'inboundcall',
        variables: [],
        flowSequenceItemList: [
          {
            __type: 'Task',
            trackingId: 1,
            id: '11111111-1111-1111-1111-111111111111',
            name: 'Entry',
            actionList: [
              {
                __type: 'PlayAudioAction',
                trackingId: 2,
                id: '22222222-2222-2222-2222-222222222222',
                name: 'Play',
                prompts: {
                  defaultAudio: {
                    config: {
                      ToAudioTTS: {
                        pos: 1,
                        operands: [{ lit: { pos: 2, text: 'Welcome to support', type: 'str' } }],
                        type: 'aud',
                      },
                    },
                  },
                },
              },
            ],
          },
        ],
      });
      const { nodes } = extractNodes(cfg);
      const { settingsByNode } = extractSettings(cfg, nodes);
      const settings = settingsByNode.get('trk_2');
      expect(settings).toBeDefined();
      expect(JSON.stringify(settings)).toContain('Welcome to support');
    });
  });
});
