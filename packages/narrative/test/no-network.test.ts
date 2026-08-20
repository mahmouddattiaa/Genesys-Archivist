// packages/narrative/test/no-network.test.ts
//
// Stage 2's entire suite must pass with no network available (CLAUDE.md).
// This package's contribution to that guarantee: stub `fetch` to throw,
// then run the package's whole happy path -- build a pack, build a
// prompt, run it through the (scripted, in-process) provider, validate
// the draft, and run it through the resumable queue -- and confirm none
// of it ever touches the network.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildEvidencePack } from '../src/evidence-pack.js';
import { buildNarrationPrompt } from '../src/prompt.js';
import { ScriptedNarrationProvider, NullNarrationProvider } from '../src/narration-provider.js';
import { validateNarration } from '../src/claim-validator.js';
import {
  runNarrationQueue,
  type NarrationJournal,
  type NarrationJournalEntry,
} from '../src/work-queue.js';
import { makeFinding, makeSnapshot } from './fixtures.js';

class MemoryJournal implements NarrationJournal {
  entries: NarrationJournalEntry[] = [];
  load(): Promise<readonly NarrationJournalEntry[]> {
    return Promise.resolve([...this.entries]);
  }
  record(entry: NarrationJournalEntry): Promise<void> {
    this.entries.push(entry);
    return Promise.resolve();
  }
}

let originalFetch: typeof fetch | undefined;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(() => {
    throw new Error('network access is not permitted in this package');
  });
});

afterEach(() => {
  if (originalFetch !== undefined) globalThis.fetch = originalFetch;
});

describe('packages/narrative with fetch stubbed to throw', () => {
  it('runs the entire happy path without ever calling fetch', async () => {
    const snapshot = makeSnapshot();
    const pack = buildEvidencePack(snapshot, [makeFinding()]);
    const prompt = buildNarrationPrompt(pack);
    expect(prompt.delimitedData.length).toBeGreaterThan(0);

    const provider = new ScriptedNarrationProvider({
      sections: [
        {
          id: 'purpose',
          markdown: '',
          claims: [
            {
              text: 'This flow is named "Test Flow".',
              kind: 'fact',
              evidenceIds: [pack.flow.name.evidenceId],
            },
          ],
        },
      ],
      unknowns: [],
      reviewRequired: true,
    } as unknown as Parameters<typeof validateNarration>[0]);

    const draft = await provider.narrate({ prompt });
    const outcome = validateNarration(draft, pack);
    expect(outcome.sections.sections[0]?.claims).toHaveLength(1);

    const journal = new MemoryJournal();
    const result = await runNarrationQueue({
      jobs: [{ flowId: 'f1', version: '1', pack }],
      provider,
      journal,
    });
    expect(result.processedCount).toBe(1);

    const nullProvider = new NullNarrationProvider();
    const nullDraft = await nullProvider.narrate({ prompt });
    expect(nullDraft.sections).toHaveLength(0);

    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
