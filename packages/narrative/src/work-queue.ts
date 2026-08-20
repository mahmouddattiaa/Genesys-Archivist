// packages/narrative/src/work-queue.ts
//
// Narrating every flow in an organization can be hundreds of model calls;
// a crashed or cancelled run must not have to start over, and a retried
// run must not re-narrate work that already succeeded. This module is the
// resumable, idempotent queue that makes that true, and it is pure -- no
// filesystem, no network, no clock. Persistence is an injected
// `NarrationJournal` port the caller implements, matching AGENTS.md's
// dependency-injection rule ("clock, IDs, filesystem, secrets, network
// clients, and model provider").
//
// A job's identity is its evidence pack's own content hash
// (`EvidencePack.contentHash`), folded together with the flow id and
// version it belongs to. `evidence-pack.ts` is deterministic -- an
// unchanged flow always produces a byte-identical pack -- so re-running a
// plan that includes an already-narrated, unchanged flow is a guaranteed
// skip, not a coincidence of timing.

import type { EvidencePack } from './evidence-pack.js';
import type { NarrationProvider, NarrationRequest } from './narration-provider.js';
import { buildNarrationPrompt } from './prompt.js';
import {
  validateNarration,
  DEFAULT_VALIDATION_POLICY,
  type ValidationOutcome,
  type ValidationPolicy,
} from './claim-validator.js';

export interface NarrationJob {
  readonly flowId: string;
  readonly version: string | number;
  readonly pack: EvidencePack;
}

export type NarrationJobStatus = 'completed' | 'failed';

export interface NarrationJournalEntry {
  readonly jobKey: string;
  readonly flowId: string;
  readonly version: string | number;
  readonly status: NarrationJobStatus;
  /** A bounded, content-free description -- a fixed phrase plus counts.
   * Never the claim text, a rejection reason's source material, or any
   * pack field. See test/canaries.test.ts's assertion that a planted
   * secret-shaped string never reaches a journal entry. */
  readonly summary: string;
}

/** The persistence port this module needs. The caller supplies a concrete
 * implementation (a file, a database row, whatever fits the host
 * application); this module never touches disk or the network itself. */
export interface NarrationJournal {
  load(): Promise<readonly NarrationJournalEntry[]>;
  record(entry: NarrationJournalEntry): Promise<void>;
}

export interface RunNarrationQueueOptions {
  readonly jobs: readonly NarrationJob[];
  readonly provider: NarrationProvider;
  readonly journal: NarrationJournal;
  readonly policy?: ValidationPolicy;
}

export interface NarrationQueueJobResult {
  readonly jobKey: string;
  readonly flowId: string;
  readonly version: string | number;
  readonly skipped: boolean;
  readonly status: NarrationJobStatus | 'skipped';
  readonly outcome?: ValidationOutcome;
}

export interface NarrationQueueResult {
  readonly results: readonly NarrationQueueJobResult[];
  /** Jobs this invocation actually ran (called the provider), whether they
   * completed or failed -- never counts a skip. */
  readonly processedCount: number;
  readonly skippedCount: number;
}

function jobKeyOf(job: NarrationJob): string {
  return `${job.flowId}:${String(job.version)}:${job.pack.contentHash}`;
}

function summarize(outcome: ValidationOutcome): string {
  const acceptedCount = outcome.sections.sections.reduce((n, s) => n + s.claims.length, 0);
  return `${String(acceptedCount)} claim(s) accepted, ${String(outcome.rejections.length)} rejected.`;
}

/**
 * Runs every job in `options.jobs` whose key is not already recorded
 * `completed` in `options.journal.load()`, in order, journalling the
 * outcome of each one it runs. Call this again with the same job list and
 * the same journal after a crash: it resumes exactly where it left off,
 * re-narrating nothing that already succeeded and never double-counting a
 * job that was already completed.
 */
export async function runNarrationQueue(
  options: RunNarrationQueueOptions,
): Promise<NarrationQueueResult> {
  const policy = options.policy ?? DEFAULT_VALIDATION_POLICY;
  const priorEntries = await options.journal.load();
  const completedKeys = new Set(
    priorEntries.filter((e) => e.status === 'completed').map((e) => e.jobKey),
  );

  const results: NarrationQueueJobResult[] = [];
  let processedCount = 0;
  let skippedCount = 0;

  for (const job of options.jobs) {
    const jobKey = jobKeyOf(job);

    if (completedKeys.has(jobKey)) {
      results.push({
        jobKey,
        flowId: job.flowId,
        version: job.version,
        skipped: true,
        status: 'skipped',
      });
      skippedCount += 1;
      continue;
    }

    const request: NarrationRequest = { prompt: buildNarrationPrompt(job.pack) };

    try {
      const draft = await options.provider.narrate(request);
      const outcome = validateNarration(draft, job.pack, policy);
      await options.journal.record({
        jobKey,
        flowId: job.flowId,
        version: job.version,
        status: 'completed',
        summary: summarize(outcome),
      });
      results.push({
        jobKey,
        flowId: job.flowId,
        version: job.version,
        skipped: false,
        status: 'completed',
        outcome,
      });
      completedKeys.add(jobKey);
    } catch {
      // A provider failure (an injected model call throwing) is never
      // journalled as `completed` -- the next `runNarrationQueue` call
      // picks this job up again. The thrown error's own message is not
      // journalled: it originates outside this package's control (a
      // provider implementation, which may echo upstream text) and this
      // module cannot itself guarantee it is content-free.
      await options.journal.record({
        jobKey,
        flowId: job.flowId,
        version: job.version,
        status: 'failed',
        summary: 'Narration provider call failed.',
      });
      results.push({
        jobKey,
        flowId: job.flowId,
        version: job.version,
        skipped: false,
        status: 'failed',
      });
    }

    processedCount += 1;
  }

  return { results, skippedCount, processedCount };
}
