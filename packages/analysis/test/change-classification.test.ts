// packages/analysis/test/change-classification.test.ts
import { describe, expect, it } from 'vitest';
import { classifyChanges, type ChangeReviewCategory } from '../src/change-classification.js';
import { diffSnapshots, type SemanticChange, type SemanticDiff } from '../src/diff.js';

/** An otherwise-empty `SemanticDiff` carrying exactly the `changes` under
 * test -- `classifyChanges` only reads `diff.changes`, so the rest of the
 * shape is filled with valid-but-irrelevant defaults. */
function diffWithChanges(changes: readonly SemanticChange[]): SemanticDiff {
  return {
    matching: { overallBasis: 'none', matches: [] },
    nodes: { added: [], removed: [], changed: [] },
    edges: { added: [], removed: [], changed: [] },
    variables: { added: [], removed: [], changed: [] },
    dependencies: { added: [], removed: [], changed: [] },
    prompts: { added: [], removed: [], changed: [] },
    changes,
    graphHashChanged: false,
    positionalOnlyReorder: false,
  };
}

const commonFields = { evidenceIdsBefore: [], evidenceIdsAfter: [] } as const;

describe('classifyChanges: review-classification table', () => {
  it('a display-label-only flow metadata change is cosmetic / light review', () => {
    const result = classifyChanges(
      diffWithChanges([
        { category: 'flow-metadata-changed', operation: 'changed', field: 'name', ...commonFields },
      ]),
    );
    expect(result.classified[0]?.category).toBe('cosmetic');
    expect(result.classified[0]?.reviewLevel).toBe('light-review');
    expect(result.blocksApproval).toBe(false);
  });

  it('a secure-flow marker change is security-sensitive / security-lead-review', () => {
    const result = classifyChanges(
      diffWithChanges([
        {
          category: 'flow-metadata-changed',
          operation: 'changed',
          field: 'secure',
          ...commonFields,
        },
      ]),
    );
    expect(result.classified[0]?.category).toBe('security-sensitive');
    expect(result.classified[0]?.reviewLevel).toBe('security-lead-review');
  });

  it('a menu route/decision/queue/schedule/error path change is behavioral / human review required', () => {
    const menuRoute: SemanticChange = {
      category: 'menu-choice-changed',
      operation: 'changed',
      fromNodeId: 'menu1',
      aspect: 'route',
      ...commonFields,
    };
    const decision: SemanticChange = {
      category: 'condition-expression-changed',
      operation: 'changed',
      fromNodeId: 'dec1',
      ...commonFields,
    };
    const errorPath: SemanticChange = {
      category: 'outcome-path-changed',
      operation: 'changed',
      fromNodeId: 'dec1',
      outcomeKind: 'no_match',
      ...commonFields,
    };
    for (const change of [menuRoute, decision, errorPath]) {
      const result = classifyChanges(diffWithChanges([change]));
      expect(result.classified[0]?.category).toBe('behavioral');
      expect(result.classified[0]?.reviewLevel).toBe('human-review-required');
    }
  });

  it('a data action or integration reference change is dependency / engineer review required', () => {
    const result = classifyChanges(
      diffWithChanges([
        {
          category: 'dependency-changed',
          operation: 'changed',
          dependencyId: 'd1',
          dependencyType: 'dataAction',
          aspect: 'reference',
          ...commonFields,
        },
      ]),
    );
    expect(result.classified[0]?.category).toBe('dependency');
    expect(result.classified[0]?.reviewLevel).toBe('engineer-review-required');
  });

  it('an auth-related dependency change escalates to security-sensitive despite being a dependency', () => {
    const result = classifyChanges(
      diffWithChanges([
        {
          category: 'dependency-changed',
          operation: 'changed',
          dependencyId: 'd1',
          dependencyType: 'oauthCredential',
          aspect: 'reference',
          ...commonFields,
        },
      ]),
    );
    expect(result.classified[0]?.category).toBe('security-sensitive');
  });

  it('a secure variable change escalates to security-sensitive', () => {
    const result = classifyChanges(
      diffWithChanges([
        {
          category: 'variable-changed',
          operation: 'changed',
          variableId: 'v1',
          aspect: 'type',
          secure: true,
          ...commonFields,
        },
      ]),
    );
    expect(result.classified[0]?.category).toBe('security-sensitive');
  });

  it('a previously supported node becoming opaque/unsupported is coverage-regression and blocks approval', () => {
    const result = classifyChanges(
      diffWithChanges([
        {
          category: 'coverage-changed',
          operation: 'changed',
          nodeId: 'n1',
          basis: 'trackingId',
          direction: 'regressed',
          beforeSupportLevel: 'full',
          afterSupportLevel: 'unsupported',
          ...commonFields,
        },
      ]),
    );
    expect(result.classified[0]?.category).toBe('coverage-regression');
    expect(result.classified[0]?.reviewLevel).toBe('blocked');
    expect(result.blocksApproval).toBe(true);
    expect(result.highestReviewLevel).toBe('blocked');
  });

  it('blocksApproval is a hard flag, not implied by highestReviewLevel alone, for a non-blocking diff', () => {
    const result = classifyChanges(
      diffWithChanges([
        {
          category: 'flow-metadata-changed',
          operation: 'changed',
          field: 'secure',
          ...commonFields,
        },
      ]),
    );
    // security-lead-review is heavy, but it is not coverage-regression.
    expect(result.highestReviewLevel).toBe('security-lead-review');
    expect(result.blocksApproval).toBe(false);
  });

  it('an empty diff (e.g. a generator/template-only rebuild) classifies as documentation-only', () => {
    const result = classifyChanges(diffWithChanges([]));
    expect(result.classified).toHaveLength(0);
    expect(result.highestReviewLevel).toBe('automated-plus-spot-check');
    expect(result.blocksApproval).toBe(false);
    expect(result.counts['documentation-only']).toBe(1);
  });

  it('the strictest category across a mixed diff wins highestReviewLevel', () => {
    const result = classifyChanges(
      diffWithChanges([
        { category: 'flow-metadata-changed', operation: 'changed', field: 'name', ...commonFields },
        {
          category: 'dependency-changed',
          operation: 'changed',
          dependencyId: 'd1',
          dependencyType: 'queue',
          aspect: 'reference',
          ...commonFields,
        },
        {
          category: 'coverage-changed',
          operation: 'changed',
          nodeId: 'n1',
          basis: 'trackingId',
          direction: 'regressed',
          beforeSupportLevel: 'full',
          afterSupportLevel: 'opaque',
          ...commonFields,
        },
      ]),
    );
    expect(result.highestReviewLevel).toBe('blocked');
    expect(result.blocksApproval).toBe(true);
    expect(result.counts.cosmetic).toBe(1);
    expect(result.counts.dependency).toBe(1);
    expect(result.counts['coverage-regression']).toBe(1);
  });
});

describe('exhaustiveness', () => {
  // One minimal, valid instance of every member of the closed SemanticChange
  // union -- including `unclassified-change`, which diffSnapshots never
  // actually constructs but the type permits and classifyChanges must still
  // handle (AGENTS.md: never silently drop a change). The real enforcement
  // is `@typescript-eslint/switch-exhaustiveness-check` at build time: if a
  // thirteenth category is ever added to the union without a case in
  // classifyOne, `npm run lint` fails before this test would ever run. This
  // test is the runtime companion, proving every one of the twelve
  // currently produces a defined, valid classification.
  const oneOfEach: readonly SemanticChange[] = [
    { category: 'flow-metadata-changed', operation: 'changed', field: 'type', ...commonFields },
    {
      category: 'entry-point-changed',
      operation: 'added',
      nodeId: 'n1',
      basis: 'trackingId',
      ...commonFields,
    },
    {
      category: 'menu-choice-changed',
      operation: 'added',
      fromNodeId: 'm1',
      aspect: 'presence',
      ...commonFields,
    },
    {
      category: 'action-changed',
      operation: 'added',
      nodeId: 'n1',
      basis: 'trackingId',
      aspect: 'presence',
      ...commonFields,
    },
    {
      category: 'condition-expression-changed',
      operation: 'changed',
      fromNodeId: 'd1',
      ...commonFields,
    },
    {
      category: 'variable-changed',
      operation: 'added',
      variableId: 'v1',
      aspect: 'presence',
      secure: false,
      ...commonFields,
    },
    {
      category: 'prompt-reference-changed',
      operation: 'changed',
      subject: { kind: 'flow-languages' },
      ...commonFields,
    },
    {
      category: 'dependency-changed',
      operation: 'added',
      dependencyId: 'dep1',
      dependencyType: 'queue',
      aspect: 'presence',
      ...commonFields,
    },
    {
      category: 'outcome-path-changed',
      operation: 'added',
      fromNodeId: 'n1',
      outcomeKind: 'timeout',
      ...commonFields,
    },
    { category: 'published-version-only-changed', operation: 'changed', ...commonFields },
    {
      category: 'coverage-changed',
      operation: 'changed',
      nodeId: null,
      basis: null,
      direction: 'improved',
      beforeSupportLevel: null,
      afterSupportLevel: null,
      ...commonFields,
    },
    {
      category: 'unclassified-change',
      operation: 'changed',
      note: 'a shape this package did not recognise',
      ...commonFields,
    },
  ];

  const ALL_CATEGORIES: readonly SemanticChange['category'][] = [
    'flow-metadata-changed',
    'entry-point-changed',
    'menu-choice-changed',
    'action-changed',
    'condition-expression-changed',
    'variable-changed',
    'prompt-reference-changed',
    'dependency-changed',
    'outcome-path-changed',
    'published-version-only-changed',
    'coverage-changed',
    'unclassified-change',
  ];

  it('covers every SemanticChange category the type permits', () => {
    expect(oneOfEach.map((c) => c.category).sort()).toEqual([...ALL_CATEGORIES].sort());
  });

  it('classifies every category into a defined, valid review class with no exception', () => {
    const result = classifyChanges(diffWithChanges(oneOfEach));
    expect(result.classified).toHaveLength(oneOfEach.length);
    const validCategories: readonly ChangeReviewCategory[] = [
      'cosmetic',
      'documentation-only',
      'behavioral',
      'dependency',
      'security-sensitive',
      'coverage-regression',
    ];
    for (const c of result.classified) {
      expect(validCategories).toContain(c.category);
      expect(c.reviewLevel).toBeDefined();
    }
  });

  it('an unclassified-change is treated as requiring human judgment, not silently waved through', () => {
    const result = classifyChanges(
      diffWithChanges([
        {
          category: 'unclassified-change',
          operation: 'changed',
          note: 'unrecognised shape',
          ...commonFields,
        },
      ]),
    );
    expect(result.classified[0]?.category).toBe('behavioral');
    expect(result.classified[0]?.reviewLevel).toBe('human-review-required');
  });
});

describe('classifyChanges composed with diffSnapshots end to end', () => {
  it('a coverage regression produced by a real diff blocks approval', () => {
    const before = {
      flow: {
        id: 'f1',
        name: 'F',
        type: 'x',
        secure: false,
        version: { selected: '1', state: 'published' },
      },
      graph: {
        entryNodeIds: ['n1'],
        nodes: [
          {
            nodeId: 'n1',
            trackingId: 't1',
            kind: 'action',
            sourceType: 'DataAction',
            name: 'N',
            containerPath: [],
            supportLevel: 'full',
            variableReads: [],
            variableWrites: [],
            dependencyRefs: [],
            promptRefs: [],
            settings: {},
            evidenceIds: [],
          },
        ],
        edges: [],
      },
      variables: [],
      dependencies: [],
      hashes: { normalizedGraph: 'h1' },
    };
    const after = {
      ...before,
      graph: {
        ...before.graph,
        nodes: [{ ...before.graph.nodes[0]!, supportLevel: 'unsupported' }],
      },
      hashes: { normalizedGraph: 'h2' },
    };
    const diff = diffSnapshots(before, after);
    const result = classifyChanges(diff);
    expect(result.blocksApproval).toBe(true);
  });
});
