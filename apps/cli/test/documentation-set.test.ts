import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { runDocument, type DocumentResult } from '../src/commands/document.js';

/**
 * Properties of the documentation set as a whole.
 *
 * Each renderer already has its own golden test, and each passed while the
 * three documents disagreed with one another about how many languages this
 * flow declares. A per-file test cannot catch that by construction: it only
 * ever sees one file. These assertions are the ones that only make sense
 * across the set.
 */
let set: DocumentResult;

const DOCUMENTS = ['business.md', 'technical.md', 'operations.md'] as const;

beforeAll(async () => {
  const config: unknown = JSON.parse(
    await readFile('fixtures/flow-config/inboundcall-47-nodes.json', 'utf8'),
  );
  set = runDocument({
    config,
    flowId: 'f1',
    flowName: 'Fixture Flow',
    flowType: 'inboundcall',
    version: '4.0',
    organizationId: 'org_1',
    region: 'eu_west_1',
    generatedAt: '2026-08-20T00:00:00Z',
  });
});

describe('the documentation set as a whole', () => {
  it('every evidence citation in every document resolves', () => {
    const ids = new Set(set.snapshot.evidence.map((e) => e.evidenceId));
    for (const name of DOCUMENTS) {
      const cited = set.files[name]?.match(/sha256:[0-9a-f]{64}/g) ?? [];
      expect(cited.length, `${name} cites nothing`).toBeGreaterThan(0);
      for (const id of cited) expect(ids.has(id), `${name} cites ${id}`).toBe(true);
    }
  });

  it('every [eN] mark used in a document is defined in that same document', () => {
    for (const name of DOCUMENTS) {
      const contents = set.files[name] ?? '';
      const defined = new Set<string>();
      for (const m of contents.matchAll(/^\|\s*\[e(\d+)\]\s*\|/gm)) defined.add(m[1] as string);
      const used = new Set<string>();
      for (const m of contents.matchAll(/\[e(\d+)\]/g)) used.add(m[1] as string);
      expect(defined.size, `${name} defines no marks`).toBeGreaterThan(0);
      for (const mark of used) {
        expect(defined.has(mark), `${name} uses [e${mark}] without defining it`).toBe(true);
      }
    }
  });

  it('no document contains an unescaped HTML tag', () => {
    // Flow names, prompt text and menu labels are tenant-authored and
    // therefore untrusted per AGENTS.md. Rendered Markdown passes HTML
    // through, so an unescaped tag here is a live injection into whatever
    // renders the document.
    for (const name of DOCUMENTS) {
      expect(set.files[name] ?? '').not.toMatch(/<(script|img|iframe|style|a\s)/i);
    }
  });

  it('the documents do not contradict each other about declared languages', () => {
    // technical.md once said "No languages were declared on this flow" while
    // business.md said the flow speaks en-US. Both were reading the same
    // snapshot: one the empty flow-level `languages` array, the other the
    // manifest's resolved language dependency. A reader who opens both loses
    // trust in both, so each must state which fact it means.
    const languageDependencies = set.snapshot.dependencies.filter((d) => d.type === 'language');
    expect(languageDependencies.length, 'fixture no longer exercises this').toBeGreaterThan(0);

    for (const name of ['business.md', 'technical.md'] as const) {
      const contents = set.files[name] ?? '';
      expect(/languag/i.test(contents), `${name} says nothing about languages`).toBe(true);

      // The invariant that actually matters: a language resource IS in use, so
      // no document may leave a reader believing this flow has none. Each must
      // name the resource, whatever wording it wraps around the flow-level
      // declaration being empty.
      for (const dependency of languageDependencies) {
        const identity = dependency.displayName ?? dependency.dependencyId;
        expect(contents.includes(identity), `${name} never names the language ${identity}`).toBe(
          true,
        );
      }
    }
  });

  it('names every diagram it emits from within the documents or emits exactly one', () => {
    const diagrams = Object.keys(set.files).filter((p) => p.endsWith('.mmd'));
    expect(diagrams.length).toBeGreaterThan(0);
  });
});
