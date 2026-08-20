// packages/normalization/test/extract-edges.branch-role.test.ts
//
// A concrete bug found by measuring the real corpus (fixtures/flow-config/
// bot-187-nodes.json, digitalbot-69-nodes.json, inboundemail-15-nodes.json),
// not guessed at: on these flow types, a `paths[].outputId` can be a GUID —
// either a dynamically-generated NLU-intent output (`isDynamicBranch: true`
// on `AskForNLUIntentAction`) or a `SwitchAction` case identifier — rather
// than one of the `__YES__` / `__NO__` / `__DEFAULT__` literals the original
// `branchRole` was written against. Measured exhaustively: none of the 24
// GUID-shaped `outputId` values across these three fixtures resolves to any
// id-bearing object anywhere in their configuration, so this is not a
// reference to node or dependency at all — it is the branch's own opaque
// identity. `branchRole` must never let that raw GUID become the edge's
// `role`, per the coordinator's explicit requirement.
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parseFlowConfig } from '../src/config-schema.js';
import { extractNodes } from '../src/extract-nodes.js';
import { extractEdges } from '../src/extract-edges.js';

const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function load(file: string): Promise<ReturnType<typeof parseFlowConfig>> {
  const raw: unknown = JSON.parse(await readFile(`fixtures/flow-config/${file}`, 'utf8'));
  return parseFlowConfig(raw);
}

describe.each(['bot-187-nodes.json', 'digitalbot-69-nodes.json', 'inboundemail-15-nodes.json'])(
  'branch role safety on %s',
  (file) => {
    it('never lets a GUID-shaped outputId become an edge role', async () => {
      const cfg = await load(file);
      const { nodes } = extractNodes(cfg);
      const { edges } = extractEdges(cfg, nodes);
      const guidRoles = edges.filter((e) => GUID_PATTERN.test(e.role));
      expect(guidRoles).toEqual([]);
    });

    it('still preserves the raw discriminator on the edge condition', async () => {
      // The fact is not lost -- only kept out of the semantic `role` slot.
      // `condition` already carries the raw outputId for every branch, per
      // the existing `ExtractedEdge` contract; a GUID is exactly as safe
      // there as `__YES__` is, since it is a Genesys-assigned structural
      // identifier, never tenant-authored text.
      const cfg = await load(file);
      const { nodes } = extractNodes(cfg);
      const { edges } = extractEdges(cfg, nodes);
      const guidConditions = edges.filter(
        (e) => e.condition !== null && GUID_PATTERN.test(e.condition),
      );
      expect(guidConditions.length).toBeGreaterThan(0);
      for (const e of guidConditions) expect(GUID_PATTERN.test(e.role)).toBe(false);
    });
  },
);

describe('branch role safety (regression, direct)', () => {
  it('gives a dynamic NLU-intent branch a stable, non-GUID role', () => {
    const cfg = parseFlowConfig({
      name: 'x',
      type: 'bot',
      variables: [],
      flowSequenceItemList: [
        {
          __type: 'Task',
          trackingId: 1,
          id: '11111111-1111-1111-1111-111111111111',
          name: 'T',
          actionList: [
            {
              __type: 'AskForNLUIntentAction',
              trackingId: 2,
              id: '22222222-2222-2222-2222-222222222222',
              name: 'Ask',
              paths: [
                {
                  nextActionId: '33333333-3333-3333-3333-333333333333',
                  isDynamicBranch: true,
                  label: 'X',
                  outputId: '44444444-4444-4444-4444-444444444444',
                },
              ],
            },
            {
              __type: 'PlayAudioAction',
              trackingId: 3,
              id: '33333333-3333-3333-3333-333333333333',
              name: 'Target',
            },
          ],
        },
      ],
    });
    const { nodes } = extractNodes(cfg);
    const { edges } = extractEdges(cfg, nodes);
    const edge = edges.find((e) => e.condition === '44444444-4444-4444-4444-444444444444');
    expect(edge).toBeDefined();
    expect(edge?.role).toBe('dynamic-branch');
  });

  it('does not misreport a dynamic branch as a dangling reference', () => {
    // outputId is not a reference at all (measured: it never resolves to
    // anything, anywhere, in the real corpus) -- it must not raise
    // DANGLING_REFERENCE just because it happens to be GUID-shaped and
    // fails to resolve against node identity.
    const cfg = parseFlowConfig({
      name: 'x',
      type: 'bot',
      variables: [],
      flowSequenceItemList: [
        {
          __type: 'Task',
          trackingId: 1,
          id: '11111111-1111-1111-1111-111111111111',
          name: 'T',
          actionList: [
            {
              __type: 'AskForNLUIntentAction',
              trackingId: 2,
              id: '22222222-2222-2222-2222-222222222222',
              name: 'Ask',
              paths: [
                {
                  nextActionId: '33333333-3333-3333-3333-333333333333',
                  isDynamicBranch: true,
                  label: 'X',
                  outputId: '44444444-4444-4444-4444-444444444444',
                },
              ],
            },
            {
              __type: 'PlayAudioAction',
              trackingId: 3,
              id: '33333333-3333-3333-3333-333333333333',
              name: 'Target',
            },
          ],
        },
      ],
    });
    const { nodes } = extractNodes(cfg);
    const { warnings } = extractEdges(cfg, nodes);
    expect(warnings.some((w) => w.code === 'DANGLING_REFERENCE')).toBe(false);
  });
});
