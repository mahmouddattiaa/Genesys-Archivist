// packages/storage/src/atomic.ts
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { resolveWithinRootReal, UntrustedPathError } from '@genesys-archivist/security';

export type PromotionPhase = 'staging' | 'promoting' | 'completed' | 'rolled_back';

export interface RecoveryAction {
  readonly runId: string;
  readonly phase: PromotionPhase;
  readonly target: string;
  readonly at: string;
}

export interface StagingArea {
  readonly dir: string;
  readonly runId: string;
  write(segments: readonly string[], contents: string | Uint8Array): Promise<void>;
  markPromoting(target: string): Promise<void>;
  discard(): Promise<void>;
}

export interface PromotionResult {
  readonly target: string;
  readonly previousArchived: boolean;
}

const journalPath = (root: string): string => join(root, '.archivist', 'journal.ndjson');

function nowIso(): string {
  return new Date().toISOString();
}

async function appendJournal(root: string, action: RecoveryAction): Promise<void> {
  const path = journalPath(root);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(action) + '\n', 'utf8');
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function assertWithinRoot(root: string, target: string): void {
  const canonicalRoot = resolve(root);
  const canonicalTarget = resolve(target);
  if (canonicalTarget !== canonicalRoot && !canonicalTarget.startsWith(canonicalRoot + sep)) {
    throw new UntrustedPathError('promotion target is outside the approved output root');
  }
}

function isPromotionPhase(value: unknown): value is PromotionPhase {
  return (
    value === 'staging' || value === 'promoting' || value === 'completed' || value === 'rolled_back'
  );
}

function isRecoveryAction(value: unknown): value is RecoveryAction {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['runId'] === 'string' &&
    typeof candidate['target'] === 'string' &&
    typeof candidate['at'] === 'string' &&
    isPromotionPhase(candidate['phase'])
  );
}

/**
 * Creates a staging area for one capture/documentation run. Nothing written
 * here is visible to a reader of the target directory until `promote`
 * succeeds -- that is the entire point of staging.
 */
export async function createStaging(root: string, runId: string): Promise<StagingArea> {
  const dir = join(root, '.archivist', 'staging', runId);
  await mkdir(dir, { recursive: true });
  await appendJournal(root, { runId, phase: 'staging', target: '', at: nowIso() });

  return {
    dir,
    runId,
    async write(segments, contents) {
      // resolveWithinRootReal, not the lexical-only guard: a symlink planted
      // inside the staging directory must not be able to steer a write
      // outside the approved output root.
      const path = await resolveWithinRootReal(dir, segments);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, contents);
    },
    async markPromoting(target) {
      await appendJournal(root, { runId, phase: 'promoting', target, at: nowIso() });
    },
    async discard() {
      await rm(dir, { recursive: true, force: true });
      await appendJournal(root, { runId, phase: 'rolled_back', target: '', at: nowIso() });
    },
  };
}

/**
 * Atomically swaps staged content into place.
 *
 * The two-rename sequence below is deliberate and is what makes this safe on
 * Windows as well as POSIX. `fs.rename` on Windows (MoveFileEx under the
 * hood) refuses to replace a non-empty existing directory the way POSIX
 * rename sometimes tolerates -- so the implementation never attempts that.
 * Instead the existing target is renamed out of the way first (to a
 * runId-scoped `.previous-<runId>` sibling), which makes the target path
 * momentarily *absent* rather than *partially written*, and only then is the
 * staged directory renamed into the now-vacant target path. A reader can
 * observe "old content" or "ENOENT" or "new content" -- never a mix.
 *
 * Both renames are single filesystem operations, so a crash can only land
 * between them, not inside one. `recoverPendingPromotions` knows how to
 * finish or unwind whichever of those two renames it finds evidence of.
 */
export async function promote(
  staging: StagingArea,
  targetDir: string,
  options: { keepPrevious?: boolean } = {},
): Promise<PromotionResult> {
  // staging.dir === <root>/.archivist/staging/<runId>
  const root = resolve(staging.dir, '..', '..', '..');
  const target = resolve(targetDir);
  assertWithinRoot(root, target);

  await staging.markPromoting(target);

  const previous = `${target}.previous-${staging.runId}`;
  let archived = false;
  try {
    await rename(target, previous);
    archived = true;
  } catch {
    // No existing target. A first run has nothing to preserve.
  }

  try {
    await mkdir(dirname(target), { recursive: true });
    await rename(staging.dir, target);
  } catch (err) {
    // Restore last known good before surfacing the failure -- this is the
    // release gate: a failed run must leave the previous output intact.
    if (archived) await rename(previous, target).catch(() => undefined);
    await appendJournal(root, {
      runId: staging.runId,
      phase: 'rolled_back',
      target,
      at: nowIso(),
    });
    throw err;
  }

  if (archived && options.keepPrevious !== true) {
    // Past the commit point. The rename above already made this run's content
    // live, so deleting the archived copy is housekeeping on a now-redundant
    // directory. If it fails -- and on Windows it can, with EPERM or EBUSY,
    // whenever a virus scanner or indexer momentarily holds a handle inside
    // the tree -- the promotion has still succeeded. Letting that escape
    // would report a successful promotion as a failure, and a caller that
    // believes promotion failed may roll back content that is already live.
    // A stray archive directory is harmless; recovery cleans it up.
    await rm(previous, { recursive: true, force: true }).catch(() => undefined);
  }
  await appendJournal(root, { runId: staging.runId, phase: 'completed', target, at: nowIso() });
  return { target, previousArchived: archived };
}

/**
 * Reports the latest known phase per run, purely by reading the journal.
 * Performs no filesystem mutation -- it is a report, not a recovery action.
 * Use `recoverPendingPromotions` to actually reconcile the filesystem.
 *
 * Unparseable lines are skipped rather than thrown on: `appendFile` is not
 * guaranteed atomic against a hard crash mid-write, so the last line of the
 * journal may be torn. A torn line is evidence of nothing recoverable and
 * must not crash the caller.
 */
export async function recoverJournal(root: string): Promise<readonly RecoveryAction[]> {
  let raw: string;
  try {
    raw = await readFile(journalPath(root), 'utf8');
  } catch {
    return [];
  }

  const latestByRun = new Map<string, RecoveryAction>();
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecoveryAction(parsed)) continue;
    // Later lines are later in time (the journal is append-only), so the
    // last one written for a runId wins.
    latestByRun.set(parsed.runId, parsed);
  }
  return [...latestByRun.values()];
}

/**
 * Actively reconciles every run whose latest journal phase is still
 * 'promoting' -- i.e. a run that was interrupted between `markPromoting` and
 * the terminal 'completed' or 'rolled_back' entry, most plausibly by a
 * process crash or power loss.
 *
 * Idempotent: once a run is reconciled it gets a terminal journal entry, so
 * a second call finds nothing left to do for it and performs no further
 * filesystem operations.
 */
export async function recoverPendingPromotions(root: string): Promise<readonly RecoveryAction[]> {
  const pending = (await recoverJournal(root)).filter((action) => action.phase === 'promoting');
  const results: RecoveryAction[] = [];
  for (const entry of pending) {
    results.push(await reconcilePendingPromotion(root, entry));
  }
  return results;
}

async function reconcilePendingPromotion(
  root: string,
  entry: RecoveryAction,
): Promise<RecoveryAction> {
  const { runId, target } = entry;
  const stagingDir = join(root, '.archivist', 'staging', runId);
  const previous = `${target}.previous-${runId}`;

  const [stagingExists, targetExists, previousExists] = await Promise.all([
    pathExists(stagingDir),
    pathExists(target),
    pathExists(previous),
  ]);

  if (stagingExists) {
    // The rename that would make this run's content live never happened.
    // Restore the last known good copy if it was moved aside, then abandon
    // the incomplete staging area.
    if (!targetExists && previousExists) {
      await rename(previous, target);
    } else if (targetExists && previousExists) {
      // Anomalous, but safe to resolve: target already holds valid content,
      // so the archived copy is a stray backup rather than the source of
      // truth.
      await rm(previous, { recursive: true, force: true }).catch(() => undefined);
    }
    // Same reasoning as promote(): the target is already correct at this
    // point, so failing to delete leftovers must not turn a completed
    // rollback into a thrown error. Recovery has to be safe to re-run, and a
    // recovery that throws on cleanup is one a caller cannot finish.
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    const action: RecoveryAction = { runId, phase: 'rolled_back', target, at: nowIso() };
    await appendJournal(root, action);
    return action;
  }

  // Staging is gone: the rename that makes this run's content live already
  // succeeded. Finish the cleanup a crash interrupted.
  if (previousExists) {
    await rm(previous, { recursive: true, force: true }).catch(() => undefined);
  }
  const action: RecoveryAction = { runId, phase: 'completed', target, at: nowIso() };
  await appendJournal(root, action);
  return action;
}
