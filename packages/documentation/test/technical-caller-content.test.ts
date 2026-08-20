// packages/documentation/test/technical-caller-content.test.ts
//
// Dedicated coverage for the two new bounded `settings` facts this task
// added to `technical.md`: §6's prompt "Content" column (joined
// prompt-library display name, or inline TTS text) and §8's decision-node
// "Expression" column. Both cite evidence via the existing `[eN]` scheme,
// and both must escape tenant-authored text through `escapeTableCell`
// before it reaches a table cell -- the same boundary every other cell in
// this module already crosses.
import { describe, expect, it } from 'vitest';
import { analyzeFlow } from '@genesys-archivist/analysis';
import { renderTechnical, type TechnicalSnapshot } from '../src/technical.js';

function baseSnapshot(overrides: Partial<TechnicalSnapshot> = {}): TechnicalSnapshot {
  return {
    schemaVersion: '1.1',
    snapshotId: 'snap-1',
    source: {
      provider: 'fixture',
      adapterVersion: '0.0.0',
      extractedAt: '2026-08-20T00:00:00Z',
      region: 'eu_west_1',
      organizationId: 'org_1',
      trackingIdsAvailable: true,
      redactionApplied: true,
    },
    flow: {
      id: 'f1',
      name: 'Test Flow',
      type: 'inboundcall',
      secure: false,
      version: { selected: '1', state: 'published' },
    },
    graph: { entryNodeIds: [], nodes: [], edges: [] },
    variables: [],
    dependencies: [],
    evidence: [],
    hashes: { canonicalizerVersion: '1.0.0', normalizedGraph: 'sha256:test' },
    ...overrides,
  };
}

function render(snapshot: TechnicalSnapshot): string {
  return renderTechnical(snapshot, analyzeFlow(snapshot), { generatedAt: '2026-08-20T00:00:00Z' });
}

function section(doc: string, startHeading: string, endHeading: string): string {
  const start = doc.indexOf(startHeading);
  const end = doc.indexOf(endHeading, start);
  return doc.slice(start, end === -1 ? undefined : end);
}

describe('renderTechnical: prompt content column (§6)', () => {
  it('joins a resolved promptRefs entry to its dependency display name', () => {
    const snapshot = baseSnapshot({
      graph: {
        entryNodeIds: ['n1'],
        nodes: [
          {
            nodeId: 'n1',
            kind: 'action',
            sourceType: 'PlayAudioAction',
            name: 'Play Step',
            containerPath: [],
            supportLevel: 'full',
            evidenceIds: [],
            promptRefs: ['p1'],
            settings: {},
          },
        ],
        edges: [],
      },
      dependencies: [
        {
          dependencyId: 'p1',
          type: 'userPrompt',
          displayName: 'Welcome Prompt',
          resolutionStatus: 'resolved',
          referencedByNodeIds: ['n1'],
          evidenceIds: [],
        },
      ],
    });
    const doc = render(snapshot);
    const promptSection = section(
      doc,
      '### Prompt-playing nodes',
      '### Text-to-speech and prompt-related dependencies',
    );
    expect(promptSection).toContain('Welcome Prompt');
  });

  it('reports an unresolved promptRefs entry by id rather than dropping it (engineer audience, unlike business.md)', () => {
    const snapshot = baseSnapshot({
      graph: {
        entryNodeIds: ['n1'],
        nodes: [
          {
            nodeId: 'n1',
            kind: 'action',
            sourceType: 'PlayAudioAction',
            name: 'Play Step',
            containerPath: [],
            supportLevel: 'full',
            evidenceIds: [],
            promptRefs: ['missing-prompt'],
            settings: {},
          },
        ],
        edges: [],
      },
    });
    const doc = render(snapshot);
    const promptSection = section(
      doc,
      '### Prompt-playing nodes',
      '### Text-to-speech and prompt-related dependencies',
    );
    expect(promptSection).toContain('missing-prompt (unresolved in this capture)');
  });

  it('renders inline TTS text when there is no prompt-library reference', () => {
    const snapshot = baseSnapshot({
      graph: {
        entryNodeIds: ['n1'],
        nodes: [
          {
            nodeId: 'n1',
            kind: 'action',
            sourceType: 'Menu',
            name: 'Main Menu',
            containerPath: [],
            supportLevel: 'full',
            evidenceIds: [],
            promptRefs: [],
            settings: {
              prompts: {
                defaultAudio: { kind: 'literal', dataType: 'str', text: 'Press one for sales' },
              },
            },
          },
        ],
        edges: [],
      },
    });
    const doc = render(snapshot);
    const promptSection = section(
      doc,
      '### Prompt-playing nodes',
      '### Text-to-speech and prompt-related dependencies',
    );
    expect(promptSection).toContain('inline TTS: "Press one for sales"');
  });

  it('escapes a pipe character in a prompt display name so it cannot inject a table column', () => {
    const snapshot = baseSnapshot({
      graph: {
        entryNodeIds: ['n1'],
        nodes: [
          {
            nodeId: 'n1',
            kind: 'action',
            sourceType: 'PlayAudioAction',
            name: 'Play Step',
            containerPath: [],
            supportLevel: 'full',
            evidenceIds: [],
            promptRefs: ['p1'],
            settings: {},
          },
        ],
        edges: [],
      },
      dependencies: [
        {
          dependencyId: 'p1',
          type: 'userPrompt',
          displayName: 'Evil | Injected | Columns',
          resolutionStatus: 'resolved',
          referencedByNodeIds: ['n1'],
          evidenceIds: [],
        },
      ],
    });
    const doc = render(snapshot);
    const promptSection = section(
      doc,
      '### Prompt-playing nodes',
      '### Text-to-speech and prompt-related dependencies',
    );
    const dataRow = promptSection.split('\n').find((line) => line.includes('Play Step'));
    expect(dataRow).toBeDefined();
    // A raw `|` would add a table column; `escapeTableCell` backslash-
    // escapes it instead, so a real Markdown/GFM table parser (which
    // recognises `\|` as a literal pipe, not a separator) still sees one
    // column here, even though a naive split on `|` cannot tell the
    // difference -- this asserts on the escaped form directly instead.
    expect(dataRow).toContain('Evil \\| Injected \\| Columns');
    expect(dataRow).not.toContain('Evil | Injected | Columns');
  });

  it('collapses a newline in inline TTS text so it cannot break the table row', () => {
    const snapshot = baseSnapshot({
      graph: {
        entryNodeIds: ['n1'],
        nodes: [
          {
            nodeId: 'n1',
            kind: 'action',
            sourceType: 'PlayAudioAction',
            name: 'Play Step',
            containerPath: [],
            supportLevel: 'full',
            evidenceIds: [],
            promptRefs: [],
            settings: {
              prompts: {
                defaultAudio: { kind: 'literal', dataType: 'str', text: 'Line one\nLine two' },
              },
            },
          },
        ],
        edges: [],
      },
    });
    const doc = render(snapshot);
    const promptSection = section(
      doc,
      '### Prompt-playing nodes',
      '### Text-to-speech and prompt-related dependencies',
    );
    expect(promptSection).not.toContain('Line one\nLine two');
    expect(promptSection).toContain('Line one Line two');
  });
});

describe('renderTechnical: decision expression column (§8)', () => {
  it('renders a DecisionAction expression structurally and cites evidence', () => {
    const snapshot = baseSnapshot({
      graph: {
        entryNodeIds: ['n1'],
        nodes: [
          {
            nodeId: 'n1',
            kind: 'action',
            sourceType: 'DecisionAction',
            name: 'Check Balance',
            containerPath: [],
            supportLevel: 'full',
            evidenceIds: ['sha256:' + 'a'.repeat(64)],
            promptRefs: [],
            settings: {
              expression: {
                kind: 'expression',
                operator: '==',
                operands: [
                  { kind: 'variableRef', dataType: 'bln' },
                  { kind: 'literal', dataType: 'bln', text: 'true' },
                ],
              },
            },
          },
        ],
        edges: [],
      },
      evidence: [
        {
          evidenceId: 'sha256:' + 'a'.repeat(64),
          sourcePointer: '/x',
          field: 'name',
          classification: 'internal',
          redacted: false,
        },
      ],
    });
    const doc = render(snapshot);
    const decisionSection = section(doc, '### Decision points', '### Loops and retries');
    expect(decisionSection).toContain('==(&lt;variable:bln&gt;, true)');
    expect(decisionSection).toMatch(/\[e\d+\]/);
  });

  it('does not render an Expression cell for a node with no expression setting', () => {
    const snapshot = baseSnapshot({
      graph: {
        entryNodeIds: ['n1'],
        nodes: [
          {
            nodeId: 'n1',
            kind: 'action',
            sourceType: 'DecisionAction',
            name: 'Empty Decision',
            containerPath: [],
            supportLevel: 'full',
            evidenceIds: [],
            promptRefs: [],
            settings: {},
          },
        ],
        edges: [],
      },
    });
    const doc = render(snapshot);
    const decisionSection = section(doc, '### Decision points', '### Loops and retries');
    const dataRow = decisionSection.split('\n').find((line) => line.includes('Empty Decision'));
    expect(dataRow).toBeDefined();
    expect(dataRow).toContain('—');
  });

  it('escapes a pipe character embedded in an expression literal', () => {
    const snapshot = baseSnapshot({
      graph: {
        entryNodeIds: ['n1'],
        nodes: [
          {
            nodeId: 'n1',
            kind: 'action',
            sourceType: 'DecisionAction',
            name: 'Pipe Decision',
            containerPath: [],
            supportLevel: 'full',
            evidenceIds: [],
            promptRefs: [],
            settings: {
              expression: { kind: 'literal', dataType: 'str', text: 'a | b' },
            },
          },
        ],
        edges: [],
      },
    });
    const doc = render(snapshot);
    const decisionSection = section(doc, '### Decision points', '### Loops and retries');
    const dataRow = decisionSection.split('\n').find((line) => line.includes('Pipe Decision'));
    expect(dataRow).toBeDefined();
    // See the sibling §6 test for why this asserts on the escaped form
    // directly rather than a naive `|`-split column count.
    expect(dataRow).toContain('"a \\| b"');
    expect(dataRow).not.toContain('"a | b"');
  });
});
