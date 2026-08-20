// packages/documentation/test/business-caller-audio.test.ts
//
// Dedicated coverage for the "what does the caller hear at this step"
// subsection `renderBusiness` added: the joined-prompt-library-display-name
// path (voicesurvey-16, which the normalization corpus measured to carry
// real prompt-library references), the inline-TTS path (inboundcall-47,
// already exercised by the golden file but asserted on explicitly here),
// the defensive unresolved-reference path, and the escaping of a
// tenant-controlled prompt display name. See
// packages/normalization/test/extract-prompts.test.ts for the underlying
// corpus measurements this file's fixture choices are based on.
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { normalizeFlow } from '@genesys-archivist/normalization';
import { analyzeFlow } from '@genesys-archivist/analysis';
import { renderBusiness, type BusinessSnapshot } from '../src/business.js';

async function renderFixture(name: string): Promise<{
  readonly doc: string;
  readonly snapshot: ReturnType<typeof normalizeFlow>;
}> {
  const config: unknown = JSON.parse(await readFile(`fixtures/flow-config/${name}`, 'utf8'));
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
      type: 'x',
      secure: false,
      version: { selected: '1', state: 'published' },
    },
  });
  const doc = renderBusiness(snapshot, analyzeFlow(asAnalysisSnapshot(snapshot)), {
    generatedAt: '2026-08-20T00:00:00Z',
  });
  return { doc, snapshot };
}

describe('renderBusiness: what callers hear', () => {
  it('joins a promptRefs entry to its dependency display name for voicesurvey-16 (measured to carry real prompt-library references)', async () => {
    const { doc, snapshot } = await renderFixture('voicesurvey-16-nodes.json');
    const promptBearingNode = snapshot.graph.nodes.find((n) => n.promptRefs.length > 0);
    expect(promptBearingNode).toBeDefined();

    const dependenciesById = new Map(
      snapshot.dependencies.map((d) => [d.dependencyId, d] as const),
    );
    const referencedDependency = dependenciesById.get(promptBearingNode!.promptRefs[0]!);
    expect(referencedDependency).toBeDefined();
    const displayName = referencedDependency!.displayName;
    expect(displayName).not.toBeNull();
    if (displayName === null) throw new Error('unreachable: asserted above');

    expect(doc).toContain('### What callers hear, step by step');
    expect(doc).toContain(`"${displayName}" prompt`);
    // The reference is joined by display name, never surfaced as a raw id.
    expect(doc).not.toContain(promptBearingNode!.promptRefs[0]!);
  });

  it('renders the inline-TTS case for inboundcall-47 (measured to carry zero promptRefs)', async () => {
    const { doc, snapshot } = await renderFixture('inboundcall-47-nodes.json');
    expect(snapshot.graph.nodes.every((n) => n.promptRefs.length === 0)).toBe(true);
    expect(doc).toContain("recorded inline in this step's own configuration");
    // Proof this is driven by real settings content, not a placeholder --
    // at least one literal TTS fragment from the fixture appears quoted.
    expect(doc).toMatch(/plays "[^"]+"/);
  });
});

/**
 * These hand-built snapshots are handed to two consumers with different node
 * shapes: `renderBusiness` (BusinessGraphNode, no `supportLevel`) and
 * `analyzeFlow` (FindingsGraphNode, which requires it). The fixtures satisfy
 * both structurally at runtime — analysis only reads `supportLevel` when
 * reporting coverage, and these fixtures declare no unsupported nodes — so the
 * gap is in the declared types, not the data.
 *
 * One narrow, named adapter, rather than four scattered casts at the call
 * sites, so the reason survives next to the workaround.
 */
function asAnalysisSnapshot(snapshot: unknown): Parameters<typeof analyzeFlow>[0] {
  return snapshot as Parameters<typeof analyzeFlow>[0];
}

describe('renderBusiness: defensive handling, hand-built snapshots', () => {
  // Returns the literal's own inferred type rather than BusinessSnapshot.
  //
  // These snapshots are handed to renderBusiness *and* analyzeFlow, and the two
  // declare different node shapes -- analysis requires `supportLevel`, the
  // business renderer does not declare it at all. Annotating the return as
  // BusinessSnapshot made the literal fail the excess-property check on one
  // side while still being too narrow for the other. Inferring keeps both
  // call sites honestly type-checked.
  function baseSnapshot(overrides: Partial<BusinessSnapshot> = {}) {
    return {
      snapshotId: 'snap-1',
      flow: {
        name: 'Test Flow',
        type: 'inboundcall',
        version: { selected: '1', state: 'published' },
      },
      source: { provider: 'fixture', region: 'eu_west_1', extractedAt: '2026-08-20T00:00:00Z' },
      graph: { entryNodeIds: [], nodes: [], edges: [] },
      variables: [],
      dependencies: [],
      evidence: [],
      ...overrides,
    };
  }

  it('reports a promptRefs entry that does not resolve to any dependency, rather than dropping it', () => {
    const snapshot = baseSnapshot({
      graph: {
        entryNodeIds: ['n1'],
        nodes: [
          {
            nodeId: 'n1',
            sourceType: 'PlayAudioAction',
            name: 'Play Step',
            evidenceIds: [],
            promptRefs: ['missing-prompt-id'],
            settings: {},
          },
        ],
        edges: [],
      },
      dependencies: [],
    });
    const doc = renderBusiness(snapshot, analyzeFlow(asAnalysisSnapshot(snapshot)), {
      generatedAt: '2026-08-20T00:00:00Z',
    });
    expect(doc).toContain('"Play Step" plays');
    expect(doc).toMatch(/does not resolve to any known prompt/);
    // Per business.md's own convention, the raw internal id is never shown.
    expect(doc).not.toContain('missing-prompt-id');
  });

  it('escapes a malicious prompt display name so it cannot break out of the surrounding Markdown, in the caller-audio subsection', () => {
    // Scoped to the "What callers hear" subsection this task added -- see
    // the comment on the sibling test below for why this does not assert
    // over the whole document.
    const malicious = '](javascript:alert(1))';
    const snapshot = baseSnapshot({
      graph: {
        entryNodeIds: ['n1'],
        nodes: [
          {
            nodeId: 'n1',
            sourceType: 'PlayAudioAction',
            name: 'Play Step',
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
          displayName: malicious,
          resolutionStatus: 'resolved',
          referencedByNodeIds: ['n1'],
          evidenceIds: [],
        },
      ],
    });
    const doc = renderBusiness(snapshot, analyzeFlow(asAnalysisSnapshot(snapshot)), {
      generatedAt: '2026-08-20T00:00:00Z',
    });
    const subsectionStart = doc.indexOf('### What callers hear, step by step');
    const nextHeadingStart = doc.indexOf('## 5.', subsectionStart);
    const subsection = doc.slice(subsectionStart, nextHeadingStart);
    expect(subsection).not.toContain(malicious);
    // A live, unescaped Markdown link/image construct must never survive.
    expect(subsection).not.toMatch(/\]\(javascript:/);
  });

  it('escapes a prompt display name containing an HTML/Mermaid comment-like sequence, in the caller-audio subsection', () => {
    // Scoped to the "What callers hear" subsection this task added, which
    // renders the display name through `escapeMarkdown` (see
    // `renderCallerAudioSubsection`). §6's dependency table renders the
    // same field through `escapeTableCell`, a pre-existing rendering path
    // this task did not touch and does not cover -- see the final report.
    const malicious = 'Welcome --> <script>alert(1)</script>';
    const snapshot = baseSnapshot({
      graph: {
        entryNodeIds: ['n1'],
        nodes: [
          {
            nodeId: 'n1',
            sourceType: 'PlayAudioAction',
            name: 'Play Step',
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
          displayName: malicious,
          resolutionStatus: 'resolved',
          referencedByNodeIds: ['n1'],
          evidenceIds: [],
        },
      ],
    });
    const doc = renderBusiness(snapshot, analyzeFlow(asAnalysisSnapshot(snapshot)), {
      generatedAt: '2026-08-20T00:00:00Z',
    });
    const subsectionStart = doc.indexOf('### What callers hear, step by step');
    const nextHeadingStart = doc.indexOf('## 5.', subsectionStart);
    const subsection = doc.slice(subsectionStart, nextHeadingStart);
    expect(subsection).not.toContain('-->');
    expect(subsection).not.toContain('<script>');
  });

  it('escapes inline TTS text carrying the same attack patterns', () => {
    const snapshot = baseSnapshot({
      graph: {
        entryNodeIds: ['n1'],
        nodes: [
          {
            nodeId: 'n1',
            sourceType: 'PlayAudioAction',
            name: 'Play Step',
            evidenceIds: [],
            promptRefs: [],
            settings: {
              prompts: {
                defaultAudio: {
                  kind: 'literal',
                  dataType: 'str',
                  text: '](javascript:alert(1)) --> <script>x</script>',
                },
              },
            },
          },
        ],
        edges: [],
      },
    });
    const doc = renderBusiness(snapshot, analyzeFlow(asAnalysisSnapshot(snapshot)), {
      generatedAt: '2026-08-20T00:00:00Z',
    });
    expect(doc).not.toContain('](javascript:alert(1))');
    expect(doc).not.toContain('-->');
    expect(doc).not.toContain('<script>');
  });
});
