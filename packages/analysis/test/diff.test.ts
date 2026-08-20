// packages/analysis/test/diff.test.ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { normalizeFlow, type FlowSnapshot } from '@genesys-archivist/normalization';
import {
  diffSnapshots,
  matchNodes,
  type DiffDependency,
  type DiffEdge,
  type DiffFlow,
  type DiffNode,
  type DiffSnapshot,
  type DiffVariable,
  type SemanticChange,
} from '../src/diff.js';

// ---------------------------------------------------------------------------
// Fixture builders. Every field a test does not care about gets a plain,
// valid default so each test can state only what it is actually exercising
// -- the same shape-minimizing approach cycles.test.ts and journeys.test.ts
// use for their own hand-built graphs.
// ---------------------------------------------------------------------------

function node(overrides: Partial<DiffNode> & { readonly nodeId: string }): DiffNode {
  return {
    trackingId: null,
    kind: 'action',
    sourceType: 'PlayAudioAction',
    name: 'Node',
    containerPath: [],
    supportLevel: 'full',
    variableReads: [],
    variableWrites: [],
    dependencyRefs: [],
    promptRefs: [],
    settings: {},
    evidenceIds: [],
    ...overrides,
  };
}

function edge(overrides: Partial<DiffEdge> & { readonly edgeId: string }): DiffEdge {
  return {
    from: 'from',
    to: 'to',
    role: 'next',
    condition: null,
    evidenceIds: [],
    ...overrides,
  };
}

function variable(
  overrides: Partial<DiffVariable> & { readonly variableId: string },
): DiffVariable {
  return {
    name: 'Variable',
    scope: 'flow',
    dataType: 'string',
    direction: 'none',
    secure: false,
    readNodeIds: [],
    writeNodeIds: [],
    evidenceIds: [],
    ...overrides,
  };
}

function dependency(
  overrides: Partial<DiffDependency> & { readonly dependencyId: string },
): DiffDependency {
  return {
    type: 'dataAction',
    displayName: 'Dependency',
    resolutionStatus: 'resolved',
    referencedByNodeIds: [],
    evidenceIds: [],
    ...overrides,
  };
}

function flow(overrides: Partial<DiffFlow> = {}): DiffFlow {
  return {
    id: 'flow-1',
    name: 'Test Flow',
    type: 'inboundcall',
    secure: false,
    version: { selected: '1', state: 'published' },
    ...overrides,
  };
}

function snapshot(input: {
  readonly flow?: Partial<DiffFlow>;
  readonly nodes?: readonly DiffNode[];
  readonly edges?: readonly DiffEdge[];
  readonly entryNodeIds?: readonly string[];
  readonly variables?: readonly DiffVariable[];
  readonly dependencies?: readonly DiffDependency[];
  readonly warnings?: DiffSnapshot['warnings'];
  readonly graphHash?: string;
}): DiffSnapshot {
  const nodes = input.nodes ?? [];
  const firstNodeId = nodes[0]?.nodeId;
  return {
    flow: flow(input.flow),
    graph: {
      entryNodeIds: input.entryNodeIds ?? (firstNodeId !== undefined ? [firstNodeId] : []),
      nodes,
      edges: input.edges ?? [],
    },
    variables: input.variables ?? [],
    dependencies: input.dependencies ?? [],
    ...(input.warnings !== undefined ? { warnings: input.warnings } : {}),
    hashes: { normalizedGraph: input.graphHash ?? 'sha256:base' },
  };
}

function categoriesOf(changes: readonly SemanticChange[]): readonly string[] {
  return changes.map((c) => c.category);
}

// ---------------------------------------------------------------------------
// One test per docs/07 semantic-diff category. All eleven.
// ---------------------------------------------------------------------------

describe('the eleven docs/07 semantic-diff categories', () => {
  it('1. flow metadata changed', () => {
    const before = snapshot({ flow: { name: 'Old Name' } });
    const after = snapshot({ flow: { name: 'New Name' } });
    const diff = diffSnapshots(before, after);
    const change = diff.changes.find((c) => c.category === 'flow-metadata-changed');
    expect(change).toBeDefined();
    expect(change?.category === 'flow-metadata-changed' && change.field).toBe('name');
  });

  it('2. entry point or start container changed', () => {
    const n1 = node({ nodeId: 'n1', trackingId: 't1', kind: 'container' });
    const n2 = node({ nodeId: 'n2', trackingId: 't2', kind: 'container' });
    const before = snapshot({ nodes: [n1, n2], entryNodeIds: ['n1'], graphHash: 'h1' });
    const after = snapshot({ nodes: [n1, n2], entryNodeIds: ['n2'], graphHash: 'h2' });
    const diff = diffSnapshots(before, after);
    const added = diff.changes.find(
      (c) => c.category === 'entry-point-changed' && c.operation === 'added',
    );
    const removed = diff.changes.find(
      (c) => c.category === 'entry-point-changed' && c.operation === 'removed',
    );
    expect(added).toBeDefined();
    expect(removed).toBeDefined();
    expect(added?.category === 'entry-point-changed' && added.nodeId).toBe('n2');
    expect(removed?.category === 'entry-point-changed' && removed.nodeId).toBe('n1');
  });

  it('3. menu choice added, removed, relabeled, or rerouted', () => {
    const menu = node({ nodeId: 'menu1', trackingId: 'tm', kind: 'container', sourceType: 'Menu' });
    const choiceA = node({ nodeId: 'choiceA', trackingId: 'ta', sourceType: 'PlayAudioAction' });
    const choiceB = node({ nodeId: 'choiceB', trackingId: 'tb', sourceType: 'PlayAudioAction' });

    // relabeled: same edgeId, label text differs.
    const relabelBefore = snapshot({
      nodes: [menu, choiceA],
      edges: [
        edge({ edgeId: 'e1', from: 'menu1', to: 'choiceA', role: 'menu-choice', label: '1: Old' }),
      ],
      graphHash: 'h1',
    });
    const relabelAfter = snapshot({
      nodes: [menu, choiceA],
      edges: [
        edge({ edgeId: 'e1', from: 'menu1', to: 'choiceA', role: 'menu-choice', label: '1: New' }),
      ],
      graphHash: 'h2',
    });
    const relabelChange = diffSnapshots(relabelBefore, relabelAfter).changes.find(
      (c) => c.category === 'menu-choice-changed',
    );
    expect(relabelChange?.category === 'menu-choice-changed' && relabelChange.aspect).toBe('label');

    // rerouted: same slot (menu1, menu-choice), different target.
    const rerouteBefore = snapshot({
      nodes: [menu, choiceA, choiceB],
      edges: [
        edge({ edgeId: 'e1', from: 'menu1', to: 'choiceA', role: 'menu-choice', label: '1: X' }),
      ],
      graphHash: 'h1',
    });
    const rerouteAfter = snapshot({
      nodes: [menu, choiceA, choiceB],
      edges: [
        edge({ edgeId: 'e2', from: 'menu1', to: 'choiceB', role: 'menu-choice', label: '1: X' }),
      ],
      graphHash: 'h2',
    });
    const rerouteChange = diffSnapshots(rerouteBefore, rerouteAfter).changes.find(
      (c) => c.category === 'menu-choice-changed',
    );
    expect(rerouteChange?.category === 'menu-choice-changed' && rerouteChange.aspect).toBe('route');

    // added: a new choice with no prior counterpart.
    const addBefore = snapshot({ nodes: [menu], edges: [], graphHash: 'h1' });
    const addAfter = snapshot({
      nodes: [menu, choiceA],
      edges: [
        edge({ edgeId: 'e1', from: 'menu1', to: 'choiceA', role: 'menu-choice', label: '1: X' }),
      ],
      graphHash: 'h2',
    });
    const addChange = diffSnapshots(addBefore, addAfter).changes.find(
      (c) => c.category === 'menu-choice-changed' && c.operation === 'added',
    );
    expect(addChange).toBeDefined();
  });

  it('4. action added, removed, moved, or materially reconfigured', () => {
    const a1 = node({ nodeId: 'a1', trackingId: 't1' });
    const a2 = node({ nodeId: 'a2', trackingId: 't2', dependencyRefs: ['dep-old'] });
    const a2After = { ...a2, dependencyRefs: ['dep-new'] };

    const before = snapshot({ nodes: [a1, a2], graphHash: 'h1' });
    const afterAdded = snapshot({
      nodes: [a1, a2, node({ nodeId: 'a3', trackingId: 't3' })],
      graphHash: 'h2',
    });
    const afterRemoved = snapshot({ nodes: [a1], graphHash: 'h3' });
    const afterReconfigured = snapshot({ nodes: [a1, a2After], graphHash: 'h4' });

    const addDiff = diffSnapshots(before, afterAdded);
    expect(
      addDiff.changes.some(
        (c) => c.category === 'action-changed' && c.operation === 'added' && c.nodeId === 'a3',
      ),
    ).toBe(true);

    const removeDiff = diffSnapshots(before, afterRemoved);
    expect(
      removeDiff.changes.some(
        (c) => c.category === 'action-changed' && c.operation === 'removed' && c.nodeId === 'a2',
      ),
    ).toBe(true);

    const reconfigureDiff = diffSnapshots(before, afterReconfigured);
    const reconfigured = reconfigureDiff.changes.find(
      (c) => c.category === 'action-changed' && c.nodeId === 'a2',
    );
    expect(reconfigured?.category === 'action-changed' && reconfigured.aspect).toBe('reconfigured');
  });

  it('5. condition/expression changed', () => {
    const dec = node({ nodeId: 'dec1', trackingId: 'td', sourceType: 'DecisionAction' });
    const target = node({ nodeId: 'target', trackingId: 'ttg' });
    const before = snapshot({
      nodes: [dec, target],
      edges: [
        edge({
          edgeId: 'c1',
          from: 'dec1',
          to: 'target',
          role: 'custom-branch',
          condition: 'OLD_CONDITION',
        }),
      ],
      graphHash: 'h1',
    });
    const after = snapshot({
      nodes: [dec, target],
      edges: [
        edge({
          edgeId: 'c2',
          from: 'dec1',
          to: 'target',
          role: 'custom-branch',
          condition: 'NEW_CONDITION',
        }),
      ],
      graphHash: 'h2',
    });
    const diff = diffSnapshots(before, after);
    const change = diff.changes.find((c) => c.category === 'condition-expression-changed');
    expect(change).toBeDefined();
    expect(change?.category === 'condition-expression-changed' && change.fromNodeId).toBe('dec1');
  });

  it('6. variable added, removed, type-changed, or read/write location changed', () => {
    const before = snapshot({
      variables: [variable({ variableId: 'v1', dataType: 'string', readNodeIds: ['n1'] })],
    });
    const afterTypeChanged = snapshot({
      variables: [variable({ variableId: 'v1', dataType: 'integer', readNodeIds: ['n1'] })],
    });
    const afterUsageChanged = snapshot({
      variables: [variable({ variableId: 'v1', dataType: 'string', readNodeIds: ['n1', 'n2'] })],
    });
    const afterAdded = snapshot({
      variables: [
        variable({ variableId: 'v1', dataType: 'string', readNodeIds: ['n1'] }),
        variable({ variableId: 'v2' }),
      ],
    });
    const afterRemoved = snapshot({ variables: [] });

    const typeChange = diffSnapshots(before, afterTypeChanged).changes.find(
      (c) => c.category === 'variable-changed',
    );
    expect(typeChange?.category === 'variable-changed' && typeChange.aspect).toBe('type');

    const usageChange = diffSnapshots(before, afterUsageChanged).changes.find(
      (c) => c.category === 'variable-changed',
    );
    expect(usageChange?.category === 'variable-changed' && usageChange.aspect).toBe(
      'usage-location',
    );

    expect(
      diffSnapshots(before, afterAdded).changes.some(
        (c) => c.category === 'variable-changed' && c.operation === 'added',
      ),
    ).toBe(true);
    expect(
      diffSnapshots(before, afterRemoved).changes.some(
        (c) => c.category === 'variable-changed' && c.operation === 'removed',
      ),
    ).toBe(true);
  });

  it('7. prompt/language reference changed', () => {
    const n1 = node({ nodeId: 'n1', trackingId: 't1', promptRefs: ['p1'] });
    const n1After = node({ nodeId: 'n1', trackingId: 't1', promptRefs: ['p1', 'p2'] });
    const nodeDiff = diffSnapshots(snapshot({ nodes: [n1] }), snapshot({ nodes: [n1After] }));
    const nodeChange = nodeDiff.changes.find(
      (c) => c.category === 'prompt-reference-changed' && c.subject.kind === 'node',
    );
    expect(nodeChange).toBeDefined();

    const langDiff = diffSnapshots(
      snapshot({ flow: { languages: ['en-us'] } }),
      snapshot({ flow: { languages: ['en-us', 'es-mx'] } }),
    );
    const langChange = langDiff.changes.find(
      (c) => c.category === 'prompt-reference-changed' && c.subject.kind === 'flow-languages',
    );
    expect(langChange).toBeDefined();
  });

  it('8. queue/flow/schedule/data-action dependency changed', () => {
    const before = snapshot({
      dependencies: [
        dependency({ dependencyId: 'd1', type: 'queue', resolutionStatus: 'resolved' }),
      ],
    });
    const afterResolution = snapshot({
      dependencies: [
        dependency({ dependencyId: 'd1', type: 'queue', resolutionStatus: 'not_found' }),
      ],
    });
    const afterAdded = snapshot({
      dependencies: [
        dependency({ dependencyId: 'd1', type: 'queue', resolutionStatus: 'resolved' }),
        dependency({ dependencyId: 'd2', type: 'dataAction' }),
      ],
    });
    const afterRemoved = snapshot({ dependencies: [] });

    const resolutionChange = diffSnapshots(before, afterResolution).changes.find(
      (c) => c.category === 'dependency-changed',
    );
    expect(resolutionChange?.category === 'dependency-changed' && resolutionChange.aspect).toBe(
      'resolution',
    );
    expect(
      diffSnapshots(before, afterAdded).changes.some(
        (c) => c.category === 'dependency-changed' && c.operation === 'added',
      ),
    ).toBe(true);
    expect(
      diffSnapshots(before, afterRemoved).changes.some(
        (c) => c.category === 'dependency-changed' && c.operation === 'removed',
      ),
    ).toBe(true);
  });

  it('9. success/failure/timeout/no-input/no-match path changed', () => {
    const dec = node({ nodeId: 'dec1', trackingId: 'td', sourceType: 'DataAction' });
    const x = node({ nodeId: 'x', trackingId: 'tx' });
    const y = node({ nodeId: 'y', trackingId: 'ty' });
    const before = snapshot({
      nodes: [dec, x, y],
      edges: [edge({ edgeId: 'e1', from: 'dec1', to: 'x', role: 'no_match' })],
      graphHash: 'h1',
    });
    const after = snapshot({
      nodes: [dec, x, y],
      edges: [edge({ edgeId: 'e2', from: 'dec1', to: 'y', role: 'no_match' })],
      graphHash: 'h2',
    });
    const diff = diffSnapshots(before, after);
    const change = diff.changes.find((c) => c.category === 'outcome-path-changed');
    expect(change).toBeDefined();
    expect(change?.category === 'outcome-path-changed' && change.outcomeKind).toBe('no_match');
  });

  it('10. published version changed without semantic graph change', () => {
    const before = snapshot({
      flow: { version: { selected: '3', state: 'published' } },
      graphHash: 'same-hash',
    });
    const after = snapshot({
      flow: { version: { selected: '4', state: 'published' } },
      graphHash: 'same-hash',
    });
    const diff = diffSnapshots(before, after);
    expect(categoriesOf(diff.changes)).toContain('published-version-only-changed');
    expect(diff.graphHashChanged).toBe(false);

    // Not reported when the graph also changed -- that is real content, not
    // "published version changed without semantic graph change".
    const afterWithGraphChange = snapshot({
      flow: { version: { selected: '4', state: 'published' } },
      graphHash: 'different-hash',
    });
    const withGraphChangeDiff = diffSnapshots(before, afterWithGraphChange);
    expect(categoriesOf(withGraphChangeDiff.changes)).not.toContain(
      'published-version-only-changed',
    );
  });

  it('11. unsupported/opaque source coverage changed', () => {
    const before = snapshot({
      nodes: [node({ nodeId: 'n1', trackingId: 't1', supportLevel: 'full' })],
    });
    const after = snapshot({
      nodes: [node({ nodeId: 'n1', trackingId: 't1', supportLevel: 'unsupported' })],
    });
    const diff = diffSnapshots(before, after);
    const change = diff.changes.find((c) => c.category === 'coverage-changed');
    expect(change).toBeDefined();
    expect(change?.category === 'coverage-changed' && change.direction).toBe('regressed');
    expect(change?.category === 'coverage-changed' && change.beforeSupportLevel).toBe('full');
    expect(change?.category === 'coverage-changed' && change.afterSupportLevel).toBe('unsupported');

    // The improving direction is reported too, distinctly.
    const improvedDiff = diffSnapshots(after, before);
    const improved = improvedDiff.changes.find((c) => c.category === 'coverage-changed');
    expect(improved?.category === 'coverage-changed' && improved.direction).toBe('improved');
  });
});

// ---------------------------------------------------------------------------
// `settings` comparison. `promptRefs` already had a comparison and a
// classification route before this task; `settings` did not -- this is the
// new field this task wires up end to end.
// ---------------------------------------------------------------------------

describe('settings comparison', () => {
  it('a settings-only change produces exactly one action-changed/reconfigured change', () => {
    const before = snapshot({
      nodes: [node({ nodeId: 'n1', trackingId: 't1', settings: { volume: 5 } })],
    });
    const after = snapshot({
      nodes: [node({ nodeId: 'n1', trackingId: 't1', settings: { volume: 9 } })],
    });
    const diff = diffSnapshots(before, after);
    expect(diff.nodes.changed).toHaveLength(1);
    expect(diff.nodes.changed[0]?.changedFields).toEqual(['settings']);

    const actionChanges = diff.changes.filter((c) => c.category === 'action-changed');
    expect(actionChanges).toHaveLength(1);
    expect(actionChanges[0]?.category === 'action-changed' && actionChanges[0].aspect).toBe(
      'reconfigured',
    );
    expect(actionChanges[0]?.category === 'action-changed' && actionChanges[0].nodeId).toBe('n1');
  });

  it('an identical settings pair produces no settings-related change', () => {
    const before = snapshot({
      nodes: [node({ nodeId: 'n1', trackingId: 't1', settings: { a: 1, b: 'x' } })],
    });
    const after = snapshot({
      nodes: [node({ nodeId: 'n1', trackingId: 't1', settings: { a: 1, b: 'x' } })],
    });
    const diff = diffSnapshots(before, after);
    expect(diff.nodes.changed).toHaveLength(0);
    expect(diff.changes).toHaveLength(0);
  });

  it('shuffled settings key order produces a byte-identical diff', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000_000 }), () => {
        const before = snapshot({
          nodes: [
            node({
              nodeId: 'n1',
              trackingId: 't1',
              settings: { alpha: 1, beta: 'two', gamma: { nested: true, other: 3 } },
            }),
          ],
        });
        const afterShuffled = snapshot({
          nodes: [
            node({
              nodeId: 'n1',
              trackingId: 't1',
              settings: { gamma: { other: 3, nested: true }, alpha: 1, beta: 'two' },
            }),
          ],
        });
        // The shuffled settings are structurally identical (only key order
        // differs) to `before`'s own settings, so this must diff as
        // "nothing changed" -- not merely "the same output twice".
        expect(JSON.stringify(diffSnapshots(before, afterShuffled))).toBe(
          JSON.stringify(diffSnapshots(before, before)),
        );
      }),
      { numRuns: 20 },
    );
  });

  it('reordering an expression operand array IS a real change, never masked as equal', () => {
    // Operand order is semantically meaningful (see diff.ts's own comment on
    // `sortObjectKeysDeep`): a canonical form that sorted array elements
    // the way it sorts object keys would wrongly treat this as unchanged.
    const before = snapshot({
      nodes: [
        node({
          nodeId: 'n1',
          trackingId: 't1',
          sourceType: 'DecisionAction',
          settings: {
            expression: {
              kind: 'expression',
              operator: '>',
              operands: [
                { kind: 'literal', dataType: 'int', text: '1' },
                { kind: 'literal', dataType: 'int', text: '2' },
              ],
            },
          },
        }),
      ],
    });
    const after = snapshot({
      nodes: [
        node({
          nodeId: 'n1',
          trackingId: 't1',
          sourceType: 'DecisionAction',
          settings: {
            expression: {
              kind: 'expression',
              operator: '>',
              operands: [
                { kind: 'literal', dataType: 'int', text: '2' },
                { kind: 'literal', dataType: 'int', text: '1' },
              ],
            },
          },
        }),
      ],
    });
    const diff = diffSnapshots(before, after);
    expect(diff.nodes.changed).toHaveLength(1);
    const change = diff.changes.find((c) => c.category === 'condition-expression-changed');
    expect(change).toBeDefined();
  });

  it('a settings change touching the `expression` key routes to condition-expression-changed', () => {
    const before = snapshot({
      nodes: [
        node({
          nodeId: 'n1',
          trackingId: 't1',
          sourceType: 'DecisionAction',
          settings: { expression: { kind: 'literal', dataType: 'bln', text: 'true' } },
        }),
      ],
    });
    const after = snapshot({
      nodes: [
        node({
          nodeId: 'n1',
          trackingId: 't1',
          sourceType: 'DecisionAction',
          settings: { expression: { kind: 'literal', dataType: 'bln', text: 'false' } },
        }),
      ],
    });
    const diff = diffSnapshots(before, after);
    const change = diff.changes.find((c) => c.category === 'condition-expression-changed');
    expect(change).toBeDefined();
    expect(change?.category === 'condition-expression-changed' && change.fromNodeId).toBe('n1');
    // Not also double-reported as a generic reconfiguration.
    expect(diff.changes.filter((c) => c.category === 'action-changed')).toHaveLength(0);
  });

  it('a settings change NOT touching `expression` routes to action-changed/reconfigured, never condition-expression-changed', () => {
    const before = snapshot({
      nodes: [node({ nodeId: 'n1', trackingId: 't1', settings: { timeout: 5 } })],
    });
    const after = snapshot({
      nodes: [node({ nodeId: 'n1', trackingId: 't1', settings: { timeout: 30 } })],
    });
    const diff = diffSnapshots(before, after);
    expect(diff.changes.some((c) => c.category === 'condition-expression-changed')).toBe(false);
    const change = diff.changes.find((c) => c.category === 'action-changed');
    expect(change?.category === 'action-changed' && change.aspect).toBe('reconfigured');
  });

  it('a settings change carrying tenant text never puts that text in a structural field', () => {
    const CANARY = 'CANARY-TENANT-TEXT-5d84';
    const before = snapshot({
      nodes: [
        node({
          nodeId: 'n1',
          trackingId: 't1',
          settings: {
            prompts: { defaultAudio: { kind: 'literal', dataType: 'str', text: 'Old' } },
          },
        }),
      ],
    });
    const after = snapshot({
      nodes: [
        node({
          nodeId: 'n1',
          trackingId: 't1',
          settings: {
            prompts: { defaultAudio: { kind: 'literal', dataType: 'str', text: CANARY } },
          },
        }),
      ],
    });
    const diff = diffSnapshots(before, after);
    // The canary must genuinely be present in the input somewhere reachable
    // -- proven via the raw node settings this test built -- but `changes`
    // is the classified, tenant-text-free layer this task's brief calls
    // out explicitly, and it alone must never contain it.
    expect(JSON.stringify(after)).toContain(CANARY);
    expect(JSON.stringify(diff.changes)).not.toContain(CANARY);
  });
});

// ---------------------------------------------------------------------------
// Identity edge cases.
// ---------------------------------------------------------------------------

describe('identity edge cases', () => {
  it('a node moved (edges reordered) with stable tracking ids produces zero behavioural change', () => {
    const menu = node({ nodeId: 'menu1', trackingId: 'tm', kind: 'container', sourceType: 'Menu' });
    const c1 = node({ nodeId: 'c1', trackingId: 't1' });
    const c2 = node({ nodeId: 'c2', trackingId: 't2' });
    const e1 = edge({ edgeId: 'e1', from: 'menu1', to: 'c1', role: 'menu-choice', label: '1: A' });
    const e2 = edge({ edgeId: 'e2', from: 'menu1', to: 'c2', role: 'menu-choice', label: '2: B' });

    const before = snapshot({ nodes: [menu, c1, c2], edges: [e1, e2], graphHash: 'h-order-1' });
    // Same edges, same identities, only the array order changed -- exactly
    // what reordering a menu's children in the source configuration does.
    // /edges is order-sensitive in canonical hashing (normalize.ts), so the
    // hash is allowed to differ even though nothing routed differently.
    const after = snapshot({ nodes: [menu, c1, c2], edges: [e2, e1], graphHash: 'h-order-2' });

    const diff = diffSnapshots(before, after);
    expect(diff.nodes.added).toHaveLength(0);
    expect(diff.nodes.removed).toHaveLength(0);
    expect(diff.nodes.changed).toHaveLength(0);
    expect(diff.edges.added).toHaveLength(0);
    expect(diff.edges.removed).toHaveLength(0);
    expect(diff.edges.changed).toHaveLength(0);
    expect(diff.changes).toHaveLength(0);
    expect(diff.graphHashChanged).toBe(true);
    expect(diff.positionalOnlyReorder).toBe(true);
  });

  it('a node deleted and a different node recreated with the same display name is not a rename', () => {
    const before = snapshot({
      nodes: [node({ nodeId: 'old-id', trackingId: 'trk-old', name: 'Collect Card Number' })],
    });
    const after = snapshot({
      nodes: [node({ nodeId: 'new-id', trackingId: 'trk-new', name: 'Collect Card Number' })],
    });
    const diff = diffSnapshots(before, after);
    expect(diff.nodes.added).toHaveLength(1);
    expect(diff.nodes.removed).toHaveLength(1);
    expect(diff.nodes.changed).toHaveLength(0);
    expect(diff.matching.matches).toHaveLength(0);
  });

  it('a rename with the tracking id intact is a rename, not add+remove', () => {
    const before = snapshot({
      nodes: [node({ nodeId: 'n1', trackingId: 'trk-1', name: 'Old Label' })],
    });
    const after = snapshot({
      nodes: [node({ nodeId: 'n1', trackingId: 'trk-1', name: 'New Label' })],
    });
    const diff = diffSnapshots(before, after);
    expect(diff.nodes.added).toHaveLength(0);
    expect(diff.nodes.removed).toHaveLength(0);
    expect(diff.nodes.changed).toHaveLength(1);
    expect(diff.nodes.changed[0]?.changedFields).toEqual(['name']);
    expect(diff.matching.overallBasis).toBe('trackingId');

    const classified = diff.changes.find((c) => c.category === 'action-changed');
    expect(classified?.category === 'action-changed' && classified.aspect).toBe('relabeled');
  });

  it('two nodes sharing a display name in one snapshot are never merged', () => {
    const nodeA = node({ nodeId: 'nodeA', trackingId: 'trk-a', name: 'Bravo' });
    const before = snapshot({ nodes: [nodeA] });
    const nodeB = node({ nodeId: 'nodeB', trackingId: 'trk-b', name: 'Bravo' });
    const after = snapshot({ nodes: [nodeA, nodeB] });

    const diff = diffSnapshots(before, after);
    // nodeA is untouched (matched, unchanged); nodeB is a genuine addition.
    // Nothing about sharing a name collapses them into one entity.
    expect(diff.nodes.added).toHaveLength(1);
    expect(diff.nodes.added[0]?.afterNodeId).toBe('nodeB');
    expect(diff.nodes.changed).toHaveLength(0);
  });

  it('reports the match basis, and a fully-derived id without tracking or source stability is not matched across a reorder', () => {
    // No trackingId on either side: nodeId here stands in for a fully
    // derived id (derive-node-id.ts), which genuinely is sensitive to
    // structural position. This is the ADR-016 tradeoff made visible: with
    // no trackingId and no source GUID, a node that moved loses its
    // identity across the diff rather than being silently assumed unchanged.
    const before = snapshot({
      nodes: [node({ nodeId: 'derived-pos0-Task', trackingId: null, name: 'Same Task' })],
    });
    const after = snapshot({
      nodes: [node({ nodeId: 'derived-pos1-Task', trackingId: null, name: 'Same Task' })],
    });
    const diff = diffSnapshots(before, after);
    expect(diff.nodes.added).toHaveLength(1);
    expect(diff.nodes.removed).toHaveLength(1);
    expect(diff.matching.overallBasis).toBe('none');
  });

  it('reports a mixed basis when some nodes matched by tracking id and others fell back', () => {
    const tracked = node({ nodeId: 'tracked', trackingId: 'trk-1' });
    const fallback = node({ nodeId: 'fallback-id', trackingId: null });
    const before = snapshot({ nodes: [tracked, fallback], entryNodeIds: ['tracked'] });
    const after = snapshot({
      nodes: [node({ ...tracked, name: 'Renamed' }), node({ ...fallback, name: 'Also Renamed' })],
      entryNodeIds: ['tracked'],
    });
    const diff = diffSnapshots(before, after);
    expect(diff.matching.overallBasis).toBe('mixed');
  });
});

// ---------------------------------------------------------------------------
// Coverage regression blocking (see also change-classification.test.ts for
// the review-level mapping and blocksApproval assertion).
// ---------------------------------------------------------------------------

describe('coverage regression', () => {
  it('a node that normalized cleanly before and now is UNSUPPORTED_NODE_TYPE regresses coverage', () => {
    const before = snapshot({
      nodes: [node({ nodeId: 'n1', trackingId: 't1', supportLevel: 'full' })],
    });
    const after = snapshot({
      nodes: [node({ nodeId: 'n1', trackingId: 't1', supportLevel: 'unsupported' })],
    });
    const diff = diffSnapshots(before, after);
    const coverage = diff.changes.find((c) => c.category === 'coverage-changed');
    expect(coverage?.category === 'coverage-changed' && coverage.direction).toBe('regressed');
  });

  it('a newly added coverage-flavoured warning also registers as a regression, independent of supportLevel', () => {
    const before = snapshot({ warnings: [] });
    const after = snapshot({
      warnings: [
        {
          code: 'UNSUPPORTED_NODE_TYPE',
          severity: 'warning',
          message: 'ignored -- untrusted, never asserted on',
          evidenceIds: ['ev1'],
        },
      ],
    });
    const diff = diffSnapshots(before, after);
    const coverage = diff.changes.find(
      (c) => c.category === 'coverage-changed' && c.evidenceIdsAfter.includes('ev1'),
    );
    expect(coverage).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Determinism.
// ---------------------------------------------------------------------------

describe('determinism', () => {
  const before = snapshot({
    nodes: [
      node({ nodeId: 'n1', trackingId: 't1' }),
      node({ nodeId: 'n2', trackingId: 't2', name: 'Two' }),
    ],
    edges: [edge({ edgeId: 'e1', from: 'n1', to: 'n2' })],
    variables: [variable({ variableId: 'v1' })],
    dependencies: [dependency({ dependencyId: 'd1' })],
    graphHash: 'h1',
  });
  const after = snapshot({
    nodes: [
      node({ nodeId: 'n1', trackingId: 't1', name: 'Renamed' }),
      node({ nodeId: 'n2', trackingId: 't2', name: 'Two' }),
    ],
    edges: [edge({ edgeId: 'e1', from: 'n1', to: 'n2' })],
    variables: [variable({ variableId: 'v1' })],
    dependencies: [dependency({ dependencyId: 'd1' })],
    graphHash: 'h2',
  });

  it('calling diffSnapshots twice on the same input is byte-identical', () => {
    expect(JSON.stringify(diffSnapshots(before, after))).toBe(
      JSON.stringify(diffSnapshots(before, after)),
    );
  });

  it('shuffling the input collections does not change the result', () => {
    const shuffledBefore: DiffSnapshot = {
      ...before,
      graph: { ...before.graph, nodes: [...before.graph.nodes].reverse() },
      variables: [...before.variables].reverse(),
      dependencies: [...before.dependencies].reverse(),
    };
    const shuffledAfter: DiffSnapshot = {
      ...after,
      graph: { ...after.graph, nodes: [...after.graph.nodes].reverse() },
      variables: [...after.variables].reverse(),
      dependencies: [...after.dependencies].reverse(),
    };
    expect(JSON.stringify(diffSnapshots(shuffledBefore, shuffledAfter))).toBe(
      JSON.stringify(diffSnapshots(before, after)),
    );
  });
});

// ---------------------------------------------------------------------------
// Self-diff property: diffSnapshots(a, a) is empty in every category, for
// randomly generated snapshots.
// ---------------------------------------------------------------------------

const nodeArb = fc
  .record({
    id: fc.stringMatching(/^[a-z][a-z0-9]{0,6}$/),
    trackingId: fc.option(fc.stringMatching(/^[0-9]{1,4}$/), { nil: null }),
    name: fc.stringMatching(/^[A-Za-z ]{1,12}$/),
    supportLevel: fc.constantFrom('full', 'partial', 'opaque', 'unsupported'),
  })
  .map(({ id, trackingId, name, supportLevel }) =>
    node({
      nodeId: trackingId !== null ? `trk_${trackingId}` : id,
      trackingId,
      name,
      supportLevel,
    }),
  );

const snapshotArb = fc
  .uniqueArray(nodeArb, { selector: (n) => n.nodeId, maxLength: 8 })
  .map((nodes) =>
    snapshot({
      nodes,
      entryNodeIds: nodes.length > 0 ? [nodes[0]?.nodeId ?? ''] : [],
    }),
  );

describe('self-diff property', () => {
  it('diffSnapshots(a, a) is empty in every category', () => {
    fc.assert(
      fc.property(snapshotArb, (s) => {
        const diff = diffSnapshots(s, s);
        expect(diff.nodes.added).toHaveLength(0);
        expect(diff.nodes.removed).toHaveLength(0);
        expect(diff.nodes.changed).toHaveLength(0);
        expect(diff.edges.added).toHaveLength(0);
        expect(diff.edges.removed).toHaveLength(0);
        expect(diff.edges.changed).toHaveLength(0);
        expect(diff.variables.added).toHaveLength(0);
        expect(diff.variables.removed).toHaveLength(0);
        expect(diff.variables.changed).toHaveLength(0);
        expect(diff.dependencies.added).toHaveLength(0);
        expect(diff.dependencies.removed).toHaveLength(0);
        expect(diff.dependencies.changed).toHaveLength(0);
        expect(diff.changes).toHaveLength(0);
        expect(diff.graphHashChanged).toBe(false);
        expect(diff.positionalOnlyReorder).toBe(false);
      }),
      { numRuns: 50 },
    );
  });
});

// ---------------------------------------------------------------------------
// Symmetry property: every change in diff(a, b) has a corresponding inverse
// in diff(b, a).
// ---------------------------------------------------------------------------

function invertOperation(op: 'added' | 'removed' | 'changed'): 'added' | 'removed' | 'changed' {
  if (op === 'added') return 'removed';
  if (op === 'removed') return 'added';
  return 'changed';
}

describe('symmetry property', () => {
  it('every change has a mirrored inverse when the snapshots are swapped', () => {
    fc.assert(
      fc.property(snapshotArb, snapshotArb, (a, b) => {
        const forward = diffSnapshots(a, b).changes;
        const backward = diffSnapshots(b, a).changes;
        // Same count, and every category+operation pairing in one direction
        // has its inverted counterpart in the other.
        expect(forward).toHaveLength(backward.length);
        const forwardShape = forward
          .map((c) => `${c.category} ${invertOperation(c.operation)}`)
          .sort();
        const backwardShape = backward.map((c) => `${c.category} ${c.operation}`).sort();
        expect(forwardShape).toEqual(backwardShape);
      }),
      { numRuns: 50 },
    );
  });

  it('a hand-built pair shows evidence swapping sides under inversion', () => {
    const before = snapshot({
      nodes: [node({ nodeId: 'n1', trackingId: 't1', evidenceIds: ['ev-before'] })],
    });
    const after = snapshot({ nodes: [] });
    const forward = diffSnapshots(before, after);
    const backward = diffSnapshots(after, before);
    expect(forward.nodes.removed[0]?.evidenceIdsBefore).toEqual(['ev-before']);
    expect(backward.nodes.added[0]?.evidenceIdsAfter).toEqual(['ev-before']);
  });
});

// ---------------------------------------------------------------------------
// Purity.
// ---------------------------------------------------------------------------

describe('purity', () => {
  it('runs the full happy path with fetch, Date.now, and Math.random stubbed to throw', () => {
    const originalFetch = globalThis.fetch;
    const originalNow = Date.now;
    const originalRandom = Math.random;
    globalThis.fetch = () => {
      throw new Error('diffSnapshots must never call fetch');
    };
    Date.now = () => {
      throw new Error('diffSnapshots must never call Date.now');
    };
    Math.random = () => {
      throw new Error('diffSnapshots must never call Math.random');
    };
    try {
      const before = snapshot({ nodes: [node({ nodeId: 'n1', trackingId: 't1' })] });
      const after = snapshot({
        nodes: [node({ nodeId: 'n1', trackingId: 't1', name: 'Changed' })],
      });
      expect(() => diffSnapshots(before, after)).not.toThrow();
    } finally {
      globalThis.fetch = originalFetch;
      Date.now = originalNow;
      Math.random = originalRandom;
    }
  });
});

// ---------------------------------------------------------------------------
// Canary: tenant-controlled text must never leak into a structural field.
// ---------------------------------------------------------------------------

describe('canary', () => {
  const CANARY_NAME = 'CANARY-TENANT-TEXT-5d84';
  const CANARY_PROMPT = 'CANARY-PROMPT-3f61';

  it('a canary flow/node name and a canary dependency display name never appear outside untrusted fields', () => {
    const before = snapshot({
      nodes: [node({ nodeId: 'n1', trackingId: 't1', name: 'Ordinary' })],
      dependencies: [dependency({ dependencyId: 'd1', displayName: 'Ordinary Dep' })],
    });
    const after = snapshot({
      flow: { name: CANARY_NAME },
      nodes: [node({ nodeId: 'n1', trackingId: 't1', name: CANARY_NAME })],
      dependencies: [dependency({ dependencyId: 'd1', displayName: CANARY_PROMPT })],
    });
    const diff = diffSnapshots(before, after);

    // The canary must show up somewhere -- otherwise this test would prove
    // nothing about where it does and does not leak.
    const fullJson = JSON.stringify(diff);
    expect(fullJson).toContain(CANARY_NAME);
    expect(fullJson).toContain(CANARY_PROMPT);

    // With every `untrusted*`-prefixed field stripped, neither canary may
    // remain anywhere in the result -- including inside `changes`, which
    // AGENTS.md requires to carry no tenant text at all.
    const stripped = JSON.stringify(diff, (key, value: unknown) =>
      key.startsWith('untrusted') ? undefined : value,
    );
    expect(stripped).not.toContain(CANARY_NAME);
    expect(stripped).not.toContain(CANARY_PROMPT);
  });
});

// ---------------------------------------------------------------------------
// matchNodes, directly.
// ---------------------------------------------------------------------------

describe('matchNodes', () => {
  it('never matches by name alone', () => {
    const before = [node({ nodeId: 'a', trackingId: null, name: 'Same Name' })];
    const after = [node({ nodeId: 'b', trackingId: null, name: 'Same Name' })];
    expect(matchNodes(before, after).matches).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Real captured fixtures. See fixtures/flow-config/ for the sanitized
// source configurations. Coverage against the single inbound-call fixture
// is exercised throughout the category tests above (via hand-built
// snapshots shaped like its output); these tests instead run the full
// normalizeFlow -> diffSnapshots pipeline against real, structurally
// diverse captures, per the coordinator's guidance.
// ---------------------------------------------------------------------------

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(`fixtures/flow-config/${name}`, 'utf8'));
}

function normalizeFixture(config: unknown, flowId: string): FlowSnapshot {
  return normalizeFlow({
    config,
    source: {
      provider: 'fixture',
      adapterVersion: '0.0.0',
      extractedAt: '2026-01-01T00:00:00Z',
      region: 'eu_west_1',
      organizationId: 'org_1',
      trackingIdsAvailable: true,
      redactionApplied: true,
    },
    flow: {
      id: flowId,
      name: 'Fixture Flow',
      type: 'x',
      secure: false,
      version: { selected: '1', state: 'published' },
    },
  });
}

describe('real fixtures', () => {
  it('dependency-changed fires across the diverse manifest types a real flow carries (inqueuecall-37, dataAction/userPrompt/systemPrompt)', () => {
    const config = loadFixture('inqueuecall-37-nodes.json') as Record<string, unknown>;
    const before = normalizeFixture(config, 'f-inqueue');

    const manifest = config['manifest'] as Record<string, unknown[]>;
    const dataActions = [...manifest['dataAction']!];
    const removedEntry = dataActions.shift();
    expect(removedEntry).toBeDefined();

    const userPrompts = manifest['userPrompt'] as Array<Record<string, unknown>> | undefined;
    if (userPrompts !== undefined && userPrompts[0] !== undefined) {
      userPrompts[0] = { ...userPrompts[0], name: 'Renamed Prompt' };
    }

    const mutatedConfig = { ...config, manifest: { ...manifest, dataAction: dataActions } };
    const after = normalizeFixture(mutatedConfig, 'f-inqueue');

    const diff = diffSnapshots(before, after);
    const removed = diff.changes.find(
      (c) => c.category === 'dependency-changed' && c.operation === 'removed',
    );
    expect(removed).toBeDefined();
    expect(removed?.category === 'dependency-changed' && removed.dependencyType).toBe('dataAction');

    if (userPrompts !== undefined) {
      const renamed = diff.changes.find(
        (c) =>
          c.category === 'dependency-changed' &&
          c.aspect === 'displayName' &&
          c.operation === 'changed',
      );
      expect(renamed).toBeDefined();
    }
  });

  it('prompt-reference-changed fires for real against a live capture (voicesurvey-16), not only the hand-built category test above', () => {
    // `promptRefs` was already wired into `NODE_FIELD_COMPARISONS` and
    // `buildSemanticChanges` before this task (see diff.ts's own comment on
    // section 7). This is the verification the task asked for: proof it
    // fires end to end through `normalizeFlow`, against a fixture measured
    // (packages/normalization/test/extract-prompts.test.ts) to carry real
    // prompt-library references, not only against a hand-built `DiffNode`.
    //
    // The mutation adds a manifest `context` entry pointing a userPrompt
    // dependency at a node that carries no prompt reference at all today
    // (measured directly against this fixture -- see the node-id survey
    // this test's own id constant is drawn from). Removing an *existing*
    // context entry instead would not reliably change anything:
    // extract-prompts.ts unions the manifest-context source with an
    // independent inline-reference scan (its own comment explains why --
    // never silently dropping a reference the manifest omits), so a node
    // whose inline configuration still points at that prompt keeps the
    // reference regardless of what the manifest's context array says.
    const config = loadFixture('voicesurvey-16-nodes.json') as Record<string, unknown>;
    const before = normalizeFixture(config, 'f-voicesurvey');
    expect(before.graph.nodes.some((n) => n.promptRefs.length > 0)).toBe(true);

    // A real EndTaskAction node in this fixture with zero manifest or inline
    // prompt reference today.
    const targetNodeGuid = '98575f6f-7d53-4329-a3be-3db821ec62ec';

    const manifest = config['manifest'] as Record<string, unknown[]>;
    const userPrompts = [...(manifest['userPrompt'] ?? [])] as Array<{
      readonly context: readonly unknown[];
    }>;
    const first = userPrompts[0];
    expect(first).toBeDefined();
    const mutatedFirst = {
      ...first,
      context: [
        ...first!.context,
        { id: targetNodeGuid, name: 'Injected', actionName: 'Injected Action' },
      ],
    };
    const mutatedUserPrompts = [mutatedFirst, ...userPrompts.slice(1)];

    const mutatedConfig = {
      ...config,
      manifest: { ...manifest, userPrompt: mutatedUserPrompts },
    };
    const after = normalizeFixture(mutatedConfig, 'f-voicesurvey');

    const diff = diffSnapshots(before, after);
    const change = diff.changes.find(
      (c) => c.category === 'prompt-reference-changed' && c.subject.kind === 'node',
    );
    expect(change).toBeDefined();
  });

  it('node matching holds up against a 187-node bot flow whose construct vocabulary shares almost nothing with an IVR', () => {
    // Per the coordinator: on this fixture, `outputId` carries a GUID rather
    // than the __YES__/__NO__/__DEFAULT__ literals an inbound-call flow
    // uses, and branchRole has not yet been fixed for that shape in
    // packages/normalization (not owned by this task). This test therefore
    // asserts only on node identity and coverage, never on edge role/
    // outcome-kind vocabulary, so it stays valid regardless of that fix.
    const config = loadFixture('bot-187-nodes.json') as Record<string, unknown>;
    const before = normalizeFixture(config, 'f-bot');
    expect(before.graph.nodes.length).toBe(187);

    // Self-diff over a real, large, non-IVR-shaped graph: zero behavioural
    // change, and matching succeeds for every node (trackingId is present
    // throughout this fixture).
    const selfDiff = diffSnapshots(before, before);
    expect(selfDiff.changes).toHaveLength(0);
    expect(selfDiff.matching.matches).toHaveLength(before.graph.nodes.length);
    expect(selfDiff.matching.overallBasis).toBe('trackingId');

    // Rename exactly one node's display name; tracking id is untouched. A
    // leaf action, not a container -- extractNodes.ts derives every child's
    // containerPath from its container's *current* name, so renaming a
    // container would cascade into every descendant's containerPath and
    // this test would no longer isolate a single change.
    const target = before.graph.nodes.find((n) => n.kind === 'action' && n.trackingId !== null);
    expect(target).toBeDefined();
    const mutatedConfig = structuredClone(config);
    const renameInPlace = (raw: unknown): boolean => {
      if (Array.isArray(raw)) return raw.some(renameInPlace);
      if (raw === null || typeof raw !== 'object') return false;
      const record = raw as Record<string, unknown>;
      if (String(record['trackingId']) === target?.trackingId) {
        record['name'] = 'Renamed For Test';
        return true;
      }
      return Object.values(record).some(renameInPlace);
    };
    renameInPlace(mutatedConfig);
    const after = normalizeFixture(mutatedConfig, 'f-bot');

    const diff = diffSnapshots(before, after);
    expect(diff.nodes.added).toHaveLength(0);
    expect(diff.nodes.removed).toHaveLength(0);
    expect(diff.nodes.changed).toHaveLength(1);
    expect(diff.nodes.changed[0]?.basis).toBe('trackingId');
  });

  it('a real fixture whose node type becomes unrecognised regresses coverage (securecall-39)', () => {
    const config = loadFixture('securecall-39-nodes.json') as Record<string, unknown>;
    const before = normalizeFixture(config, 'f-securecall');

    const mutatedConfig = structuredClone(config);
    let mutated = false;
    const breakOneType = (raw: unknown): boolean => {
      if (mutated) return true;
      if (Array.isArray(raw)) {
        for (const item of raw) if (breakOneType(item)) return true;
        return false;
      }
      if (raw === null || typeof raw !== 'object') return false;
      const record = raw as Record<string, unknown>;
      if (typeof record['__type'] === 'string' && record['__type'] === 'PlayAudioAction') {
        record['__type'] = 'TotallyUnrecognisedActionType';
        mutated = true;
        return true;
      }
      for (const value of Object.values(record)) if (breakOneType(value)) return true;
      return false;
    };
    breakOneType(mutatedConfig);
    expect(mutated).toBe(true);

    const after = normalizeFixture(mutatedConfig, 'f-securecall');
    const diff = diffSnapshots(before, after);
    const coverage = diff.changes.find((c) => c.category === 'coverage-changed');
    expect(coverage).toBeDefined();
    expect(coverage?.category === 'coverage-changed' && coverage.direction).toBe('regressed');
  });
});
