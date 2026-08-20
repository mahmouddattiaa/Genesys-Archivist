// packages/analysis/test/change-detection.test.ts
import { describe, expect, it } from 'vitest';
import {
  decideFlowAction,
  type CurrentFlowDescriptor,
  type PreviousFlowManifestEntry,
} from '../src/change-detection.js';

function previous(overrides: Partial<PreviousFlowManifestEntry> = {}): PreviousFlowManifestEntry {
  return {
    flowId: 'flow-1',
    flowType: 'inboundcall',
    selectedVersion: '3',
    divisionId: 'div-1',
    ...overrides,
  };
}

function descriptor(overrides: Partial<CurrentFlowDescriptor> = {}): CurrentFlowDescriptor {
  return {
    name: 'Flow Name',
    type: 'inboundcall',
    divisionId: 'div-1',
    publishedVersion: '3',
    ...overrides,
  };
}

describe('decideFlowAction: docs/07 nine-step algorithm', () => {
  it('skips extraction when metadata is identical and no rebuild is required', () => {
    const action = decideFlowAction({
      flowId: 'flow-1',
      previous: previous(),
      current: { status: 'found', descriptor: descriptor() },
    });
    expect(action.action).toBe('skip-unchanged');
    expect(action.reason).toBe('METADATA_UNCHANGED');
  });

  it('proceeds to normalize when metadata changed and the graph hash is not yet known (first call of the pass)', () => {
    const action = decideFlowAction({
      flowId: 'flow-1',
      previous: previous({ selectedVersion: '3' }),
      current: { status: 'found', descriptor: descriptor({ publishedVersion: '4' }) },
    });
    expect(action.action).toBe('regenerate');
    expect(action.reason).toBe('METADATA_CHANGED_HASH_PENDING');
  });

  it('records metadata-only when the graph hash agrees, after normalization (second call of the pass)', () => {
    const action = decideFlowAction({
      flowId: 'flow-1',
      previous: previous({ selectedVersion: '3', snapshotHash: 'h1' }),
      current: { status: 'found', descriptor: descriptor({ publishedVersion: '4' }) },
      currentGraphHash: 'h1',
    });
    expect(action.action).toBe('metadata-only');
    expect(action.reason).toBe('GRAPH_HASH_UNCHANGED');
  });

  it('regenerates when the graph hash changed', () => {
    const action = decideFlowAction({
      flowId: 'flow-1',
      previous: previous({ selectedVersion: '3', snapshotHash: 'h1' }),
      current: { status: 'found', descriptor: descriptor({ publishedVersion: '4' }) },
      currentGraphHash: 'h2',
    });
    expect(action.action).toBe('regenerate');
    expect(action.reason).toBe('GRAPH_HASH_CHANGED');
  });

  it('forces a rebuild even when metadata and the graph hash both agree (generator/policy/template change)', () => {
    const action = decideFlowAction({
      flowId: 'flow-1',
      previous: previous({ snapshotHash: 'h1' }),
      current: { status: 'found', descriptor: descriptor() },
      currentGraphHash: 'h1',
      rebuild: { forced: true, reasons: ['TEMPLATE_VERSION_CHANGED'] },
    });
    expect(action.action).toBe('rebuild-forced');
    expect(action.reason).toBe('GENERATOR_OR_POLICY_REBUILD_FORCED');
  });

  it('a rebuild-forced flow is never silently skipped, even with metadata unchanged and no graph hash provided yet', () => {
    const action = decideFlowAction({
      flowId: 'flow-1',
      previous: previous(),
      current: { status: 'found', descriptor: descriptor() },
      rebuild: { forced: true, reasons: ['ANALYZER_VERSION_CHANGED'] },
    });
    expect(action.action).toBe('rebuild-forced');
  });

  it('a never-before-seen flow id is new-flow', () => {
    const action = decideFlowAction({
      flowId: 'flow-new',
      previous: null,
      current: { status: 'found', descriptor: descriptor() },
    });
    expect(action.action).toBe('new-flow');
    expect(action.reason).toBe('NEVER_SEEN_BEFORE');
  });

  it('permission loss is inaccessible, never treated as deletion', () => {
    const action = decideFlowAction({
      flowId: 'flow-1',
      previous: previous(),
      current: { status: 'forbidden' },
    });
    expect(action.action).toBe('inaccessible');
    expect(action.reason).toBe('ACCESS_FORBIDDEN');
  });

  it('a flow id absent from discovery is a retire-candidate, never an immediate deletion', () => {
    const action = decideFlowAction({
      flowId: 'flow-1',
      previous: previous(),
      current: { status: 'not-found' },
    });
    expect(action.action).toBe('retire-candidate');
    expect(action.reason).toBe('NOT_FOUND_IN_DISCOVERY');
  });

  it('a rename keeps the stable id: same flowId stays on the normal path, and the rename is recorded as a note', () => {
    const action = decideFlowAction({
      flowId: 'flow-1',
      previous: previous({ name: 'Old Display Name' }),
      current: { status: 'found', descriptor: descriptor({ name: 'New Display Name' }) },
    });
    expect(action.action).toBe('skip-unchanged');
    expect(action.notes).toContain('DISPLAY_NAME_CHANGED');
  });

  it('a division move preserves identity and records the move as a note', () => {
    const action = decideFlowAction({
      flowId: 'flow-1',
      previous: previous({ divisionId: 'div-old' }),
      current: { status: 'found', descriptor: descriptor({ divisionId: 'div-new' }) },
    });
    // A division-only change with the same version is still metadata-unchanged
    // for the purpose of skip/regenerate, but the move is not silently dropped.
    expect(action.action).toBe('regenerate');
    expect(action.notes).toContain('DIVISION_CHANGED');
  });

  it('a recreated flow with the same name but a new id is a new flow, never merged with the old one', () => {
    // Modeled as two independent calls, one per flow id -- exactly how the
    // composition layer (which matches by flow id, per docs/07 step 2) would
    // drive this function. Nothing about sharing a display name links them.
    const oldFlow = decideFlowAction({
      flowId: 'flow-old',
      previous: previous({ flowId: 'flow-old' }),
      current: { status: 'not-found' },
    });
    const newFlow = decideFlowAction({
      flowId: 'flow-new',
      previous: null,
      current: { status: 'found', descriptor: descriptor({ name: 'Same Display Name' }) },
    });
    expect(oldFlow.action).toBe('retire-candidate');
    expect(newFlow.action).toBe('new-flow');
  });

  it('duplicate names are never merged: two distinct flow ids with the same name each decide independently', () => {
    const flowA = decideFlowAction({
      flowId: 'flow-a',
      previous: null,
      current: { status: 'found', descriptor: descriptor({ name: 'Duplicate Name' }) },
    });
    const flowB = decideFlowAction({
      flowId: 'flow-b',
      previous: null,
      current: { status: 'found', descriptor: descriptor({ name: 'Duplicate Name' }) },
    });
    expect(flowA.action).toBe('new-flow');
    expect(flowB.action).toBe('new-flow');
    expect(flowA.flowId).not.toBe(flowB.flowId);
  });
});

describe('purity', () => {
  it('is a pure function over values -- documented, and demonstrated by two identical calls agreeing', () => {
    const input = {
      flowId: 'flow-1',
      previous: previous({ snapshotHash: 'h1' }),
      current: { status: 'found' as const, descriptor: descriptor({ publishedVersion: '4' }) },
      currentGraphHash: 'h2',
    };
    expect(decideFlowAction(input)).toEqual(decideFlowAction(input));
  });

  it('runs with fetch, Date.now, and Math.random stubbed to throw', () => {
    const originalFetch = globalThis.fetch;
    const originalNow = Date.now;
    const originalRandom = Math.random;
    globalThis.fetch = () => {
      throw new Error('decideFlowAction must never call fetch');
    };
    Date.now = () => {
      throw new Error('decideFlowAction must never call Date.now');
    };
    Math.random = () => {
      throw new Error('decideFlowAction must never call Math.random');
    };
    try {
      expect(() =>
        decideFlowAction({
          flowId: 'flow-1',
          previous: previous(),
          current: { status: 'found', descriptor: descriptor({ publishedVersion: '4' }) },
        }),
      ).not.toThrow();
    } finally {
      globalThis.fetch = originalFetch;
      Date.now = originalNow;
      Math.random = originalRandom;
    }
  });
});
