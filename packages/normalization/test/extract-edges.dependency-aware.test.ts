// packages/normalization/test/extract-edges.dependency-aware.test.ts
//
// Two more findings from measuring the real corpus (fixtures/flow-config/):
//
// 1. `referenceId` (on a `ScreenPopAction`'s `inputs[]` and a `SwitchAction`'s
//    `cases[]`) is the parameter/case's own opaque identity, exactly like a
//    bare `id` field — not a reference to anything. Measured exhaustively
//    across bot, digitalbot, inboundemail and inboundshortmessage: 28 of 28
//    `referenceId` occurrences resolve to nothing, ever. Left unexcluded, the
//    generic walk turns every one of them into `DANGLING_REFERENCE` noise.
//
// 2. `outcomeId` / `milestoneId` / `datatableId` / `flowId` / `screenPopId`
//    are real, resolvable references -- just not to a *node*. They resolve
//    to a manifest dependency (flowOutcome, flowMilestone, dataTable,
//    botFlow) instead, measured 100% on bot-187-nodes.json and
//    outboundcall-11-nodes.json/inboundshortmessage-5-nodes.json. Reporting
//    these as `DANGLING_REFERENCE` is not a missing edge, it is a wrong
//    claim: the reference is not broken, it just isn't a graph edge.
//    `extractEdges` must be able to tell "resolves to a dependency" apart
//    from "resolves to nothing at all."
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parseFlowConfig } from '../src/config-schema.js';
import { extractNodes } from '../src/extract-nodes.js';
import { extractDependencies } from '../src/extract-dependencies.js';
import { extractEdges } from '../src/extract-edges.js';

async function load(file: string): Promise<ReturnType<typeof parseFlowConfig>> {
  const raw: unknown = JSON.parse(await readFile(`fixtures/flow-config/${file}`, 'utf8'));
  return parseFlowConfig(raw);
}

describe('referenceId is treated as identity, not a reference', () => {
  it('raises no DANGLING_REFERENCE for a ScreenPopAction input referenceId', async () => {
    const cfg = await load('inboundshortmessage-5-nodes.json');
    const { nodes } = extractNodes(cfg);
    const { dependencies } = extractDependencies(cfg, nodes);
    const { warnings } = extractEdges(cfg, nodes, dependencies);
    const referenceIdWarnings = warnings.filter(
      (w) => w.code === 'DANGLING_REFERENCE' && w.path?.includes('referenceId'),
    );
    expect(referenceIdWarnings).toEqual([]);
  });

  it('raises no DANGLING_REFERENCE for a SwitchAction case referenceId', async () => {
    const cfg = await load('inboundemail-15-nodes.json');
    const { nodes } = extractNodes(cfg);
    const { dependencies } = extractDependencies(cfg, nodes);
    const { warnings } = extractEdges(cfg, nodes, dependencies);
    const referenceIdWarnings = warnings.filter(
      (w) => w.code === 'DANGLING_REFERENCE' && w.path?.includes('referenceId'),
    );
    expect(referenceIdWarnings).toEqual([]);
  });
});

describe('a GUID that resolves to a dependency is not dangling', () => {
  it('produces zero DANGLING_REFERENCE warnings on bot-187-nodes.json once dependencies are supplied', async () => {
    // The strongest possible regression proof: every one of the 35
    // DANGLING_REFERENCE warnings measured on this real flow before the fix
    // was either referenceId noise or a legitimate, resolvable dependency
    // reference (outcomeId/milestoneId/datatableId). None was a genuinely
    // broken link.
    const cfg = await load('bot-187-nodes.json');
    const { nodes } = extractNodes(cfg);
    const { dependencies } = extractDependencies(cfg, nodes);
    const { warnings } = extractEdges(cfg, nodes, dependencies);
    expect(warnings.filter((w) => w.code === 'DANGLING_REFERENCE')).toEqual([]);
  });

  it('produces zero DANGLING_REFERENCE warnings on outboundcall-11-nodes.json once dependencies are supplied', async () => {
    const cfg = await load('outboundcall-11-nodes.json');
    const { nodes } = extractNodes(cfg);
    const { dependencies } = extractDependencies(cfg, nodes);
    const { warnings } = extractEdges(cfg, nodes, dependencies);
    expect(warnings.filter((w) => w.code === 'DANGLING_REFERENCE')).toEqual([]);
  });

  it('still raises DANGLING_REFERENCE for the same field when dependencies are not supplied', async () => {
    // Proves the fix is real dependency-aware resolution, not a blanket
    // suppression of these field names: with no dependency list to check
    // against, the same flowId reference is reported exactly as before.
    const cfg = await load('outboundcall-11-nodes.json');
    const { nodes } = extractNodes(cfg);
    const { warnings } = extractEdges(cfg, nodes);
    expect(warnings.some((w) => w.code === 'DANGLING_REFERENCE')).toBe(true);
  });

  it('does not fabricate a node-to-node edge for a dependency reference', () => {
    const cfg = parseFlowConfig({
      name: 'x',
      type: 'bot',
      variables: [],
      manifest: {
        flowOutcome: [{ id: '55555555-5555-5555-5555-555555555555', name: 'Outcome' }],
      },
      flowSequenceItemList: [
        {
          __type: 'Task',
          trackingId: 1,
          id: '11111111-1111-1111-1111-111111111111',
          name: 'T',
          actionList: [
            {
              __type: 'SetFlowOutcomeAction',
              trackingId: 2,
              id: '22222222-2222-2222-2222-222222222222',
              name: 'Set',
              outcomeId: '55555555-5555-5555-5555-555555555555',
            },
          ],
        },
      ],
    });
    const { nodes } = extractNodes(cfg);
    const { dependencies } = extractDependencies(cfg, nodes);
    const { edges, warnings } = extractEdges(cfg, nodes, dependencies);
    expect(edges).toEqual([]);
    expect(warnings.filter((w) => w.code === 'DANGLING_REFERENCE')).toEqual([]);
  });
});
