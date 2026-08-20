// packages/narrative/test/narration-provider.test.ts
import { describe, expect, it } from 'vitest';
import { NullNarrationProvider, ScriptedNarrationProvider } from '../src/narration-provider.js';
import { buildEvidencePack } from '../src/evidence-pack.js';
import { buildNarrationPrompt } from '../src/prompt.js';
import { makeSnapshot } from './fixtures.js';

const request = { prompt: buildNarrationPrompt(buildEvidencePack(makeSnapshot(), [])) };

describe('NullNarrationProvider', () => {
  it('returns an empty draft that does not require review', async () => {
    const provider = new NullNarrationProvider();
    const draft = await provider.narrate(request);
    expect(draft).toEqual({ sections: [], unknowns: [], reviewRequired: false });
  });

  it('keeps deterministic-only mode a no-op regardless of the request', async () => {
    const provider = new NullNarrationProvider();
    const a = await provider.narrate(request);
    const b = await provider.narrate(request);
    expect(a).toEqual(b);
  });
});

describe('ScriptedNarrationProvider', () => {
  it('returns a fixed draft', async () => {
    const draft = { sections: [], unknowns: ['gap'], reviewRequired: true };
    const provider = new ScriptedNarrationProvider(draft);
    expect(await provider.narrate(request)).toEqual(draft);
  });

  it('computes a draft from the request via a responder function', async () => {
    const provider = new ScriptedNarrationProvider((req) => ({
      sections: [],
      unknowns: [req.prompt.nonce],
      reviewRequired: false,
    }));
    const draft = await provider.narrate(request);
    expect(draft.unknowns).toEqual([request.prompt.nonce]);
  });
});
