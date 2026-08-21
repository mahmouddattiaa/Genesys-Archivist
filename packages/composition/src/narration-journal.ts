// packages/composition/src/narration-journal.ts
//
// A real, file-backed `NarrationJournal` (`@genesys-archivist/narrative`'s
// resumable-queue persistence port, packages/narrative/src/work-queue.ts)
// plus one thing that port deliberately does not carry: the actual
// validated narrative content for a completed job.
//
// `NarrationJournalEntry.summary` is content-free by design -- work-queue.ts's
// own comment is explicit that claim text never belongs in a log-like
// record. That is correct for the journal's own purpose (deciding whether to
// re-run a job), but it means a *skip* on a re-run has nothing to
// reconstruct `narrative.md` from. Without something else remembering the
// accepted content, a re-run over an unchanged flow would either re-narrate
// it (defeating the whole point of the resumable queue) or silently drop its
// narrative section -- exactly the "overwrite the last known-good output"
// AGENTS.md forbids, just for narration content instead of a document file.
// `NarrationContentJournal` adds a side-store for that content, keyed the
// same way (`jobKey`), so a caller (`document-bundle-to-disk.ts`) can
// re-emit the identical `narrative.md` for a skipped job without calling the
// model again.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { acquireLock, createStaging, promote } from '@genesys-archivist/storage';
import { safeSegment } from '@genesys-archivist/security';
import type {
  NarrationJournal,
  NarrationJournalEntry,
  NarrativeSections,
} from '@genesys-archivist/narrative';

export interface NarrationContentJournal extends NarrationJournal {
  /** The validated sections a prior, completed run of this exact job (same
   * flow id, version, and evidence-pack content hash -- see `jobKeyOf` in
   * packages/narrative/src/work-queue.ts) produced. `null` if nothing was
   * ever saved for this key, so a caller can tell "nothing to reuse" apart
   * from "reuse an empty draft". */
  loadSections(jobKey: string): Promise<NarrativeSections | null>;
  saveSections(jobKey: string, sections: NarrativeSections): Promise<void>;
}

interface JournalFile {
  readonly entries: readonly NarrationJournalEntry[];
}

const JOURNAL_ENTRY_SEGMENTS = ['.archivist', 'narration', 'journal.json'] as const;

/**
 * Each jobKey gets its own directory, not a shared one, because `promote`
 * (`@genesys-archivist/storage`) atomically swaps a whole target directory
 * for what was staged -- promoting several jobs' files into one shared
 * directory would make each `saveSections` call silently delete every
 * sibling job's previously saved content instead of adding to it. A
 * directory per key needs no merge step: two different jobs' writes never
 * touch the same target directory at all.
 */
function sectionsDirSegments(jobKey: string): readonly string[] {
  // jobKey is `${flowId}:${version}:${packContentHash}` -- none of the three
  // components are trusted to already be filesystem-safe (flowId and
  // version both ultimately originate at Genesys), so it is routed through
  // safeSegment exactly as every other id-derived path in this codebase is
  // before it reaches the filesystem.
  return ['.archivist', 'narration-sections', safeSegment(jobKey)];
}

function sectionsSegments(jobKey: string): readonly string[] {
  return [...sectionsDirSegments(jobKey), 'sections.json'];
}

export interface FileNarrationJournalOptions {
  /** The profile's own output root -- the same root captures and documents
   * are staged and promoted under, so narration state lives and travels
   * with the output tree it describes rather than in a separate,
   * easy-to-lose location. */
  readonly root: string;
}

async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Stages and promotes a single small file at `segments`, under its own
 * dedicated target directory (the parent of the file) -- `promote` swaps a
 * whole directory atomically, so giving each artifact its own directory
 * means concurrent writes to *different* jobKeys' section files, or to the
 * journal file, never contend with each other's promotion. */
async function writeFileAtomically(
  root: string,
  segments: readonly string[],
  contents: string,
): Promise<void> {
  const fileName = segments[segments.length - 1] ?? 'file.json';
  const dirSegments = segments.slice(0, -1);
  const stagingId = `narration-write-${String(Date.now())}-${Math.random().toString(36).slice(2)}`;
  const staging = await createStaging(root, stagingId);
  try {
    await staging.write([fileName], contents);
    await promote(staging, join(root, ...dirSegments));
  } catch (error) {
    await staging.discard();
    throw error;
  }
}

const WRITE_LOCK_WAIT_MS = 5_000;
const WRITE_LOCK_RETRY_MS = 20;

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

/**
 * Builds a `NarrationContentJournal` rooted at `options.root`.
 *
 * Every write goes through `createStaging`/`promote` (`@genesys-archivist/storage`),
 * the same atomic primitive every other staged writer in this codebase uses
 * (run-store.ts, bundle-writer.ts, profile-store.ts): a crash mid-write can
 * never leave either the journal or a sections file torn. Writes to the
 * shared journal file are additionally serialized through `acquireLock`,
 * mirroring run-store.ts's own reasoning: two legitimate concurrent writers
 * recording different jobs' outcomes is the expected case, not the
 * exception.
 */
export function createFileNarrationJournal(
  options: FileNarrationJournalOptions,
): NarrationContentJournal {
  const { root } = options;
  const journalPath = join(root, ...JOURNAL_ENTRY_SEGMENTS);

  async function withJournalLock<T>(fn: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + WRITE_LOCK_WAIT_MS;
    for (;;) {
      const lock = await acquireLock(root, 'narration-journal');
      if (lock !== null) {
        try {
          return await fn();
        } finally {
          await lock.release();
        }
      }
      if (Date.now() >= deadline) {
        throw new Error('Timed out waiting for the narration journal lock.');
      }
      await delay(WRITE_LOCK_RETRY_MS);
    }
  }

  return {
    async load(): Promise<readonly NarrationJournalEntry[]> {
      const parsed = await readJsonFile<JournalFile>(journalPath);
      // Not `Array.isArray(parsed.entries)`: TypeScript's own lib.d.ts types
      // `Array.isArray` as `(arg: any) => arg is any[]`, so calling it on an
      // already precisely-typed value here would *widen* `parsed.entries`
      // back down to `any[]` rather than narrow it. `readJsonFile` already
      // encodes the expected shape through its generic parameter; a missing
      // or corrupt file already returns `null` above, which the `??` below
      // handles.
      return parsed?.entries ?? [];
    },

    async record(entry: NarrationJournalEntry): Promise<void> {
      await withJournalLock(async () => {
        const parsed = await readJsonFile<JournalFile>(journalPath);
        const existing = parsed?.entries ?? [];
        const next: JournalFile = {
          entries: [...existing.filter((e) => e.jobKey !== entry.jobKey), entry],
        };
        await writeFileAtomically(
          root,
          JOURNAL_ENTRY_SEGMENTS,
          `${JSON.stringify(next, null, 2)}\n`,
        );
      });
    },

    async loadSections(jobKey: string): Promise<NarrativeSections | null> {
      const path = join(root, ...sectionsSegments(jobKey));
      return readJsonFile<NarrativeSections>(path);
    },

    async saveSections(jobKey: string, sections: NarrativeSections): Promise<void> {
      await writeFileAtomically(
        root,
        sectionsSegments(jobKey),
        `${JSON.stringify(sections, null, 2)}\n`,
      );
    },
  };
}

/**
 * An ephemeral, in-memory `NarrationContentJournal`. Used as
 * `documentBundleToDisk`'s own default when narration is requested but no
 * journal is injected -- always available, never touches disk, but does not
 * survive past the current process. A caller that wants narration state to
 * persist across separate CLI invocations supplies `createFileNarrationJournal`
 * explicitly (`apps/cli/src/bin.ts` always does).
 */
export function createInMemoryNarrationJournal(): NarrationContentJournal {
  const entries = new Map<string, NarrationJournalEntry>();
  const sections = new Map<string, NarrativeSections>();
  return {
    load: () => Promise.resolve([...entries.values()]),
    record: (entry) => {
      entries.set(entry.jobKey, entry);
      return Promise.resolve();
    },
    loadSections: (jobKey) => Promise.resolve(sections.get(jobKey) ?? null),
    saveSections: (jobKey, value) => {
      sections.set(jobKey, value);
      return Promise.resolve();
    },
  };
}
