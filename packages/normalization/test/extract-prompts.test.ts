// packages/normalization/test/extract-prompts.test.ts
import { readFile, readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { parseFlowConfig, type RawFlowConfig } from '../src/config-schema.js';
import { extractNodes } from '../src/extract-nodes.js';
import { extractDependencies } from '../src/extract-dependencies.js';
import { extractPromptReferences } from '../src/extract-prompts.js';

async function loadFixture(name: string): Promise<RawFlowConfig> {
  const raw: unknown = JSON.parse(await readFile(`fixtures/flow-config/${name}`, 'utf8'));
  return parseFlowConfig(raw);
}

describe('extractPromptReferences', () => {
  describe('measured against the real corpus', () => {
    // Measured directly (see the task's own corpus): inboundcall-47,
    // bot-187, and securecall-39 all play every prompt via inline TTS
    // literal text (a ToAudioTTS/AudioPlaybackOptions expression carrying
    // the words to speak directly), never via a userPrompt/systemPrompt
    // prompt-library asset. bot-187's manifest carries zero prompt-type
    // entries at all; inboundcall-47 and securecall-39 each carry one
    // systemPrompt entry, but its context is the flow's own default
    // settings, not any node (see extract-dependencies.ts's own comment on
    // "defaultSettings" contexts). So all three genuinely produce zero
    // prompt-bearing nodes — this is a measured fact about these three
    // flows' content, not a gap in extraction. The two fixtures that do
    // reference real prompt-library assets are asserted below instead.
    it('produces zero prompt-bearing nodes for inboundcall-47, bot-187, and securecall-39', async () => {
      for (const fixture of [
        'inboundcall-47-nodes.json',
        'bot-187-nodes.json',
        'securecall-39-nodes.json',
      ]) {
        const cfg = await loadFixture(fixture);
        const { nodes } = extractNodes(cfg);
        const { dependencies } = extractDependencies(cfg, nodes);
        const { promptRefsByNode } = extractPromptReferences(cfg, nodes, dependencies);
        expect(promptRefsByNode.size, fixture).toBe(0);
      }
    });

    it('finds exactly 3 prompt-bearing nodes (5 node/prompt associations) in voicesurvey-16', async () => {
      // 3 nodes carry a promptRef: two carry two prompts each (a question
      // audio and an answer-confirmation audio both play from a prompt-
      // library asset), one carries one — 5 associations in total. Measured
      // directly against the fixture's manifest.userPrompt contexts and
      // cross-checked against each PlayAudioAction/AskSurveyQuestionAction's
      // own inline `ref type: 'pmt'` values.
      const cfg = await loadFixture('voicesurvey-16-nodes.json');
      const { nodes } = extractNodes(cfg);
      const { dependencies } = extractDependencies(cfg, nodes);
      const { promptRefsByNode, warnings } = extractPromptReferences(cfg, nodes, dependencies);
      expect(promptRefsByNode.size).toBe(3);
      const totalAssociations = [...promptRefsByNode.values()].reduce(
        (n, ids) => n + ids.length,
        0,
      );
      expect(totalAssociations).toBe(5);
      expect(warnings).toEqual([]);
    });

    it('finds exactly 1 prompt-bearing node in inqueuecall-37', async () => {
      const cfg = await loadFixture('inqueuecall-37-nodes.json');
      const { nodes } = extractNodes(cfg);
      const { dependencies } = extractDependencies(cfg, nodes);
      const { promptRefsByNode, warnings } = extractPromptReferences(cfg, nodes, dependencies);
      expect(promptRefsByNode.size).toBe(1);
      expect(warnings).toEqual([]);
    });

    it('every promptRefs entry resolves to a real dependency in the same snapshot, across the full corpus', async () => {
      const files = (await readdir('fixtures/flow-config')).filter((f) => f.endsWith('.json'));
      for (const file of files) {
        const cfg = await loadFixture(file);
        const { nodes } = extractNodes(cfg);
        const { dependencies } = extractDependencies(cfg, nodes);
        const { promptRefsByNode, warnings } = extractPromptReferences(cfg, nodes, dependencies);
        const dependencyIds = new Set(dependencies.map((d) => d.dependencyId));
        for (const [nodeId, promptIds] of promptRefsByNode) {
          for (const promptId of promptIds) {
            expect(
              dependencyIds.has(promptId),
              `${file}: node ${nodeId} promptRefs entry ${promptId} has no matching dependency`,
            ).toBe(true);
          }
        }
        // Every promptRefs entry above resolved; the corpus never exercises
        // the "does not resolve" path, which is exactly the fact the next
        // test asserts, and warnings must therefore be empty for this
        // extractor across every real fixture.
        expect(warnings, file).toEqual([]);
      }
    });
  });

  describe('an inline prompt reference that does not resolve', () => {
    function configWithDanglingPromptRef(): unknown {
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
                __type: 'PlayAudioAction',
                trackingId: 2,
                id: '22222222-2222-2222-2222-222222222222',
                name: 'Play',
                prompts: {
                  defaultAudio: {
                    config: {
                      ToAudio: {
                        pos: 1,
                        operands: [
                          {
                            ref: {
                              pos: 1,
                              text: 'unresolved',
                              type: 'pmt',
                              val: '99999999-9999-9999-9999-999999999999',
                            },
                          },
                        ],
                        type: 'aud',
                      },
                    },
                  },
                },
              },
            ],
          },
        ],
        // No manifest at all: the referenced prompt id has no dependency.
      };
    }

    it('raises DANGLING_REFERENCE rather than silently omitting the reference', () => {
      const cfg = parseFlowConfig(configWithDanglingPromptRef());
      const { nodes } = extractNodes(cfg);
      const { dependencies } = extractDependencies(cfg, nodes);
      const { promptRefsByNode, warnings } = extractPromptReferences(cfg, nodes, dependencies);
      expect(promptRefsByNode.size).toBe(0);
      const flag = warnings.find((w) => w.code === 'DANGLING_REFERENCE');
      expect(flag).toBeDefined();
      expect(flag?.severity).toBe('warning');
      expect(flag?.nodeIds).toEqual(['trk_2']);
    });

    it('never lets tenant-authored text reach the warning, only structural identifiers', () => {
      // CANARY-TENANT-TEXT-9c2e / CANARY-PROMPT-1a7d per the task brief: both
      // must never appear in a warning message. They are deliberately placed
      // on the flow name and the referencing node's own name — neither
      // participates in constructing the warning, which cites only the
      // node's already-resolved id and a fixed structural description.
      const base = configWithDanglingPromptRef() as {
        name: string;
        flowSequenceItemList: { name: string; actionList: { name: string }[] }[];
      };
      base.name = 'CANARY-TENANT-TEXT-9c2e';
      const firstItem = base.flowSequenceItemList[0];
      if (firstItem === undefined) throw new Error('fixture missing its first sequence item');
      const firstAction = firstItem.actionList[0];
      if (firstAction === undefined) throw new Error('fixture missing its first action');
      firstAction.name = 'CANARY-PROMPT-1a7d';

      const cfg = parseFlowConfig(base);
      const { nodes } = extractNodes(cfg);
      const { dependencies } = extractDependencies(cfg, nodes);
      const { warnings } = extractPromptReferences(cfg, nodes, dependencies);
      const serialized = JSON.stringify(warnings);
      expect(serialized).not.toContain('CANARY-TENANT-TEXT-9c2e');
      expect(serialized).not.toContain('CANARY-PROMPT-1a7d');
      expect(warnings.length).toBeGreaterThan(0);
    });
  });

  describe('determinism', () => {
    /** Shuffles an object's own key order (never array element order —
     * meaningful in this configuration shape) with a seeded PRNG, mirroring
     * extract-edges.generic-walk.test.ts's own shuffle helper. */
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

    it('produces byte-identical promptRefs regardless of source key order', async () => {
      const raw: unknown = JSON.parse(
        await readFile('fixtures/flow-config/voicesurvey-16-nodes.json', 'utf8'),
      );
      const baseCfg = parseFlowConfig(raw);
      const { nodes: baseNodes } = extractNodes(baseCfg);
      const { dependencies: baseDeps } = extractDependencies(baseCfg, baseNodes);
      const baseline = extractPromptReferences(baseCfg, baseNodes, baseDeps);
      expect(baseline.promptRefsByNode.size).toBeGreaterThan(0);

      fc.assert(
        fc.property(fc.integer({ min: 0, max: 1_000_000 }), (seed) => {
          const shuffled = parseFlowConfig(reorderKeysDeep(raw, seed));
          const { nodes } = extractNodes(shuffled);
          const { dependencies } = extractDependencies(shuffled, nodes);
          const result = extractPromptReferences(shuffled, nodes, dependencies);
          expect(JSON.stringify([...result.promptRefsByNode.entries()].sort())).toBe(
            JSON.stringify([...baseline.promptRefsByNode.entries()].sort()),
          );
          expect(result.warnings).toEqual(baseline.warnings);
        }),
        { numRuns: 20 },
      );
    });
  });
});
