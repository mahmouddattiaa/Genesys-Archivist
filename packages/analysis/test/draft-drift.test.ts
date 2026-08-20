// packages/analysis/test/draft-drift.test.ts
import { describe, expect, it } from 'vitest';
import { assessDraftDrift, type DraftDriftVersion } from '../src/draft-drift.js';

const published: DraftDriftVersion = { selected: '3', state: 'published', published: '3' };

describe('assessDraftDrift: docs/07 "Draft drift"', () => {
  it('is not-observable when policy forbids seeing anything beyond the published version', () => {
    const result = assessDraftDrift({ published, latestObserved: null });
    expect(result.status).toBe('not-observable');
    expect(result.publishedVersion).toEqual(published);
    expect(result.draftVersion).toBeUndefined();
  });

  it('reports no-drift when the latest observed version is the published version', () => {
    const result = assessDraftDrift({ published, latestObserved: published });
    expect(result.status).toBe('no-drift');
    expect(result.draftVersion).toBeUndefined();
  });

  it('reports drift-present-unknown-change when a newer version exists but graphChanged was not assessed', () => {
    const draft: DraftDriftVersion = { selected: '4', state: 'checked-in' };
    const result = assessDraftDrift({ published, latestObserved: draft });
    expect(result.status).toBe('draft-present-unknown-change');
    expect(result.draftVersion).toEqual(draft);
    // The caller-visible document must remain tied to the published version.
    expect(result.publishedVersion).toEqual(published);
  });

  it('reports drift-present-no-semantic-change: a version bump with no semantic graph change is its own category', () => {
    const draft: DraftDriftVersion = { selected: '4', state: 'checked-in' };
    const result = assessDraftDrift({ published, latestObserved: draft, graphChanged: false });
    expect(result.status).toBe('draft-present-no-semantic-change');
  });

  it('reports drift-present-semantic-change when the draft genuinely differs', () => {
    const draft: DraftDriftVersion = {
      selected: '4',
      state: 'working-copy',
      workingCopyPresent: true,
    };
    const result = assessDraftDrift({ published, latestObserved: draft, graphChanged: true });
    expect(result.status).toBe('draft-present-semantic-change');
    expect(result.draftVersion).toEqual(draft);
  });

  it('never reports a draft as current caller-visible behavior: publishedVersion is always the input published version', () => {
    const draft: DraftDriftVersion = { selected: '99', state: 'working-copy' };
    for (const graphChanged of [undefined, true, false]) {
      const result = assessDraftDrift({
        published,
        latestObserved: draft,
        ...(graphChanged !== undefined ? { graphChanged } : {}),
      });
      expect(result.publishedVersion).toEqual(published);
      expect(result.publishedVersion).not.toEqual(draft);
    }
  });

  it('a later publication that closes the drift falls out as no-drift once the published version catches up', () => {
    const caughtUp: DraftDriftVersion = { selected: '4', state: 'published', published: '4' };
    const result = assessDraftDrift({ published: caughtUp, latestObserved: caughtUp });
    expect(result.status).toBe('no-drift');
  });
});

describe('purity', () => {
  it('runs with fetch, Date.now, and Math.random stubbed to throw', () => {
    const originalFetch = globalThis.fetch;
    const originalNow = Date.now;
    const originalRandom = Math.random;
    globalThis.fetch = () => {
      throw new Error('assessDraftDrift must never call fetch');
    };
    Date.now = () => {
      throw new Error('assessDraftDrift must never call Date.now');
    };
    Math.random = () => {
      throw new Error('assessDraftDrift must never call Math.random');
    };
    try {
      expect(() =>
        assessDraftDrift({
          published,
          latestObserved: { selected: '4', state: 'checked-in' },
          graphChanged: true,
        }),
      ).not.toThrow();
    } finally {
      globalThis.fetch = originalFetch;
      Date.now = originalNow;
      Math.random = originalRandom;
    }
  });
});
