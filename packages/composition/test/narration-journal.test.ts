// packages/composition/test/narration-journal.test.ts
//
// createFileNarrationJournal: the real, disk-backed NarrationJournal
// (packages/narrative's resumable-queue persistence port), plus the sections
// side-store that lets a *skipped* re-narration still reproduce the exact
// narrative.md a prior run produced -- see this file's own header comment
// for why that side-store exists.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { NarrativeSections } from '@genesys-archivist/narrative';
import { createFileNarrationJournal } from '../src/narration-journal.js';

const created: string[] = [];
async function freshDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'archivist-narration-journal-'));
  created.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const SECTIONS: NarrativeSections = {
  sections: [
    {
      id: 'purpose',
      claims: [
        {
          text: 'This flow greets the caller.',
          kind: 'fact',
          confidence: null,
          evidenceIds: ['sha256:' + 'a'.repeat(64)],
          subject: null,
        },
      ],
    },
  ],
  unknowns: [],
  reviewRequired: true,
};

describe('createFileNarrationJournal', () => {
  it('load() returns empty for a journal that has never been written', async () => {
    const root = await freshDir();
    const journal = createFileNarrationJournal({ root });
    expect(await journal.load()).toEqual([]);
  });

  it('record() persists an entry that a later load() (a fresh journal instance) can see', async () => {
    const root = await freshDir();
    await createFileNarrationJournal({ root }).record({
      jobKey: 'flow-1:1:sha256:' + 'b'.repeat(64),
      flowId: 'flow-1',
      version: '1',
      status: 'completed',
      summary: '1 claim(s) accepted, 0 rejected.',
    });

    const reopened = createFileNarrationJournal({ root });
    const entries = await reopened.load();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.jobKey).toBe('flow-1:1:sha256:' + 'b'.repeat(64));
    expect(entries[0]?.status).toBe('completed');
  });

  it('a second record() for the same jobKey replaces, rather than duplicates, the entry', async () => {
    const root = await freshDir();
    const journal = createFileNarrationJournal({ root });
    const jobKey = 'flow-1:1:sha256:' + 'c'.repeat(64);
    await journal.record({
      jobKey,
      flowId: 'flow-1',
      version: '1',
      status: 'failed',
      summary: 'Narration provider call failed.',
    });
    await journal.record({
      jobKey,
      flowId: 'flow-1',
      version: '1',
      status: 'completed',
      summary: '1 claim(s) accepted, 0 rejected.',
    });

    const entries = await journal.load();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.status).toBe('completed');
  });

  it('loadSections() returns null for a job that was never saved', async () => {
    const root = await freshDir();
    const journal = createFileNarrationJournal({ root });
    expect(await journal.loadSections('never-saved')).toBeNull();
  });

  it('saveSections() then loadSections() round-trips through a fresh journal instance', async () => {
    const root = await freshDir();
    const jobKey = 'flow-1:1:sha256:' + 'd'.repeat(64);
    await createFileNarrationJournal({ root }).saveSections(jobKey, SECTIONS);

    const reopened = createFileNarrationJournal({ root });
    const loaded = await reopened.loadSections(jobKey);
    expect(loaded).toEqual(SECTIONS);
  });

  it('a hostile jobKey is sanitized rather than escaping the journal root, and still round-trips', async () => {
    const root = await freshDir();
    const journal = createFileNarrationJournal({ root });
    const hostileKey = '../../escape:1:sha256:' + 'e'.repeat(64);
    await journal.saveSections(hostileKey, SECTIONS);

    // Round-trips under the same (sanitized) key.
    expect(await journal.loadSections(hostileKey)).toEqual(SECTIONS);
    // Nothing escaped to the parent of root -- a fresh journal rooted one
    // level up sees no trace of it under the un-prefixed remainder.
    const outside = createFileNarrationJournal({ root: join(root, '..') });
    expect(await outside.loadSections('escape:1:sha256:' + 'e'.repeat(64))).toBeNull();
  });
});
