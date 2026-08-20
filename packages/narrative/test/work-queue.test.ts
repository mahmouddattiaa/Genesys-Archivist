// packages/narrative/test/work-queue.test.ts
import { describe, expect, it } from 'vitest';
import { buildEvidencePack, type EvidencePack } from '../src/evidence-pack.js';
import { ScriptedNarrationProvider } from '../src/narration-provider.js';
import {
  runNarrationQueue,
  type NarrationJob,
  type NarrationJournal,
  type NarrationJournalEntry,
} from '../src/work-queue.js';
import { makeSnapshot } from './fixtures.js';

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

function packFor(flowName: string): EvidencePack {
  return buildEvidencePack(makeSnapshot({ flow: { ...makeSnapshot().flow, name: flowName } }), []);
}

function jobsOf(count: number): NarrationJob[] {
  return Array.from({ length: count }, (_, i) => ({
    flowId: `flow-${String(i)}`,
    version: '1',
    pack: packFor(`Flow ${String(i)}`),
  }));
}

describe('runNarrationQueue', () => {
  it('runs every job and journals a completed entry for each', async () => {
    const journal = new MemoryJournal();
    const provider = new ScriptedNarrationProvider({
      sections: [],
      unknowns: [],
      reviewRequired: false,
    });
    const result = await runNarrationQueue({ jobs: jobsOf(3), provider, journal });

    expect(result.processedCount).toBe(3);
    expect(result.skippedCount).toBe(0);
    expect(journal.entries).toHaveLength(3);
    expect(journal.entries.every((e) => e.status === 'completed')).toBe(true);
  });

  it('resumes after an interruption: 3 of 5 already completed means exactly 2 more run', async () => {
    const jobs = jobsOf(5);
    const journal = new MemoryJournal();
    let calls = 0;
    const provider = new ScriptedNarrationProvider(() => {
      calls += 1;
      return { sections: [], unknowns: [], reviewRequired: false };
    });

    // Simulate a first run that crashed after journalling jobs 0-2.
    for (const job of jobs.slice(0, 3)) {
      journal.entries.push({
        jobKey: `${job.flowId}:${String(job.version)}:${job.pack.contentHash}`,
        flowId: job.flowId,
        version: job.version,
        status: 'completed',
        summary: '0 claim(s) accepted, 0 rejected.',
      });
    }

    const result = await runNarrationQueue({ jobs, provider, journal });

    expect(calls).toBe(2);
    expect(result.processedCount).toBe(2);
    expect(result.skippedCount).toBe(3);
    expect(journal.entries).toHaveLength(5);
    expect(journal.entries.filter((e) => e.status === 'completed')).toHaveLength(5);
  });

  it('does not double-count a job that is already completed', async () => {
    const jobs = jobsOf(2);
    const journal = new MemoryJournal();
    const provider = new ScriptedNarrationProvider({
      sections: [],
      unknowns: [],
      reviewRequired: false,
    });

    const first = await runNarrationQueue({ jobs, provider, journal });
    expect(first.processedCount).toBe(2);

    const second = await runNarrationQueue({ jobs, provider, journal });
    expect(second.processedCount).toBe(0);
    expect(second.skippedCount).toBe(2);
    expect(journal.entries).toHaveLength(2);
  });

  it('does not skip an unchanged flow ID whose pack changed: the job key includes the content hash', async () => {
    const journal = new MemoryJournal();
    const provider = new ScriptedNarrationProvider({
      sections: [],
      unknowns: [],
      reviewRequired: false,
    });
    const v1: NarrationJob = { flowId: 'flow-x', version: '1', pack: packFor('Version One') };
    await runNarrationQueue({ jobs: [v1], provider, journal });

    const v2: NarrationJob = { flowId: 'flow-x', version: '1', pack: packFor('Version Two') };
    const result = await runNarrationQueue({ jobs: [v2], provider, journal });

    expect(result.processedCount).toBe(1);
    expect(result.skippedCount).toBe(0);
  });

  it('journals a failure without marking the job completed, so it is retried next run', async () => {
    const journal = new MemoryJournal();
    let attempts = 0;
    const provider = new ScriptedNarrationProvider(() => {
      attempts += 1;
      throw new Error('provider unavailable');
    });

    const job = jobsOf(1);
    const first = await runNarrationQueue({ jobs: job, provider, journal });
    expect(first.results[0]?.status).toBe('failed');
    expect(journal.entries[0]?.status).toBe('failed');

    const second = await runNarrationQueue({ jobs: job, provider, journal });
    expect(second.skippedCount).toBe(0);
    expect(attempts).toBe(2);
  });
});
