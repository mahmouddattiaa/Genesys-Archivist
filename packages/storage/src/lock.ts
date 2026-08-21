// packages/storage/src/lock.ts
import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { safeSegment } from '@genesys-archivist/security';

export interface Lock {
  readonly key: string;
  release(): Promise<void>;
}

interface LockRecord {
  readonly key: string;
  readonly pid: number;
  readonly acquiredAt: number;
  readonly ttlMs: number;
}

const DEFAULT_TTL_MS = 30 * 60 * 1000;
// Bounds every retry loop below so a pathological situation -- heavy
// contention, or the lock file being recreated on every attempt -- fails
// closed (returns null) instead of spinning forever.
const MAX_ATTEMPTS = 100;
// How long a caller may hold the internal reclaim mutex (see below) before
// another caller assumes its holder crashed and treats it as abandoned.
// This guards a handful of local filesystem calls, not the user-facing lock
// itself, so a few seconds is an enormous margin, not a tunable TTL.
const RECLAIM_MUTEX_STALE_MS = 5_000;

function isLockRecord(value: unknown): value is LockRecord {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['key'] === 'string' &&
    typeof candidate['pid'] === 'number' &&
    typeof candidate['acquiredAt'] === 'number' &&
    typeof candidate['ttlMs'] === 'number'
  );
}

async function readLockRecord(path: string): Promise<LockRecord | null> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return isLockRecord(parsed) ? parsed : null;
  } catch {
    // Missing, unreadable, or not valid JSON. Every caller treats this the
    // same as "no record to trust" -- a corrupt lock file must never
    // deadlock the tool, so it is reclaimable exactly like a stale one.
    return null;
  }
}

function isCreateContention(err: unknown): boolean {
  if (typeof err !== 'object' || err === null || !('code' in err)) return false;
  const code = err.code;
  // EEXIST is the POSIX-correct signal for a losing exclusive create.
  // Windows has been observed to surface EPERM instead when two `wx` opens
  // race tightly on the same path (CreateFile/CREATE_NEW under contention);
  // it means the same thing operationally, so it is treated the same way.
  return code === 'EEXIST' || code === 'EPERM';
}

/**
 * Creates `path` holding `contents`, failing if it already exists -- and,
 * unlike `writeFile(..., { flag: 'wx' })`, never letting any other caller
 * observe the file in a partially written state.
 *
 * `wx` gives atomic *creation*, not atomic *content*: it is
 * `open(O_CREAT|O_EXCL)` followed by a separate `write`. Between those two
 * syscalls the file exists and is empty. That window is not theoretical --
 * measured on Windows, a concurrent reader saw a zero-length file on 7 of 67
 * successful reads across 4,000 trials.
 *
 * It mattered because of what the reader does next. `readLockRecord` cannot
 * distinguish "empty because the holder has not written yet" from "corrupt",
 * and returns null for both; the reclaim path reads null as *stale* and
 * removes the file. So a contender could delete a live holder's lock and then
 * win it, and `acquireLock` granted the same key twice -- reproduced at
 * roughly one overlap per 1,800 contested trials, which is exactly the rate
 * at which the mutual-exclusion probe failed under full-suite load.
 *
 * Writing the bytes first and then `link`ing the finished file into place
 * closes the window structurally rather than by timing: `link` is atomic and
 * fails with EEXIST if the target exists, so the file at `path` is complete
 * at the instant it becomes visible. Absence of a parseable record is
 * therefore once again real evidence of staleness rather than a race.
 *
 * The temp file is created in the same directory, so it is always on the same
 * volume -- a hard link cannot cross one.
 *
 * Staged once per `acquireLock` call rather than once per attempt, because
 * `link` does not consume its source: one finished file can be offered to the
 * target path as many times as the retry loop needs. Writing it per attempt
 * instead turned every retry from one syscall into three, and contended
 * acquisition slowed enough to push several tests past their timeouts -- a
 * correctness fix has no business costing that, and it does not have to.
 */
async function stageExclusivePayload(path: string, contents: string): Promise<string> {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, contents, 'utf8');
  return temp;
}

async function discardStagedPayload(temp: string): Promise<void> {
  // Cleanup failure must never become operation failure, for the same reason
  // release() swallows its own: this runs while a real error may already be
  // propagating. A leftover temp file is inert -- nothing ever reads one.
  await rm(temp, { force: true }).catch(() => undefined);
}

interface MutexRecord {
  readonly at: number;
}
function isMutexRecord(value: unknown): value is MutexRecord {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>)['at'] === 'number'
  );
}

/**
 * Serializes the "inspect the current lock, and clear it if it is actually
 * stale" decision, so at most one caller can be making that decision for a
 * given key at any moment.
 *
 * This exists because "read the lock, decide it's stale, then remove or
 * replace it" is not safe to do concurrently on its own: a caller's
 * decision can be based on a snapshot that a *different* caller has since
 * legitimately replaced with a fresh, live lock (its own successful `wx`
 * create). Acting on the outdated snapshot -- even briefly, even if later
 * "corrected" -- opens a vacancy window that a third caller's `wx` create
 * can win, and once that promise resolves as granted, no amount of later
 * filesystem bookkeeping un-resolves it. Concurrent reclaimers ended up
 * granting the same key to more than one caller before this existed.
 * Gating the decision behind a mutex means the read of the real lock file
 * is always current relative to every other reclaimer, not a stale
 * snapshot acted on late.
 */
async function withReclaimMutex<T>(
  mutexPath: string,
  fn: () => Promise<T>,
): Promise<T | 'contended'> {
  // `at` is stamped when the payload is staged rather than when it is finally
  // linked. The gap is the retry loop below, which is syscalls rather than
  // waits; and the value is only ever compared against RECLAIM_MUTEX_STALE_MS,
  // five whole seconds, so being a few milliseconds early cannot change a
  // verdict.
  const temp = await stageExclusivePayload(mutexPath, JSON.stringify({ at: Date.now() }));
  let acquired = false;
  try {
    for (let attempt = 0; attempt < MAX_ATTEMPTS && !acquired; attempt += 1) {
      try {
        await link(temp, mutexPath);
        acquired = true;
      } catch (err) {
        if (!isCreateContention(err)) throw err;

        const raw = await readFile(mutexPath, 'utf8').catch(() => null);
        let parsed: unknown = null;
        if (raw !== null) {
          try {
            parsed = JSON.parse(raw);
          } catch {
            parsed = null;
          }
        }
        const heldAt = isMutexRecord(parsed) ? parsed.at : null;
        const abandoned = heldAt === null || Date.now() - heldAt >= RECLAIM_MUTEX_STALE_MS;
        if (!abandoned) return 'contended';
        await rm(mutexPath, { force: true }).catch(() => undefined);
      }
    }
  } finally {
    await discardStagedPayload(temp);
  }
  if (!acquired) return 'contended';

  try {
    return await fn();
  } finally {
    // Cleanup failure must never become operation failure. `force: true`
    // swallows ENOENT but NOT the EPERM that Windows raises when this rm's
    // internal lstat races another caller's concurrent delete of the same
    // mutex file. Unguarded, that error escapes the finally and propagates
    // out of acquireLock, which is contractually supposed to return null on
    // contention rather than throw a raw filesystem error at its caller.
    // Leaving the file behind is harmless: the abandoned-mutex path above
    // reclaims it.
    await rm(mutexPath, { force: true }).catch(() => undefined);
  }
}

/**
 * Grants a single-writer lock scoped to `key` under `root`, or returns null
 * if a live holder already owns it.
 *
 * The fast path uses an exclusive create (`flag: 'wx'`), not a
 * read-then-write check: `wx` is a single filesystem syscall that
 * atomically fails if the file already exists, which is what actually makes
 * uncontested acquisition safe against several concurrent callers racing
 * for the same, previously-vacant key. A read-then-write sequence has a
 * window between the two steps where every caller can observe "no lock" and
 * every one of them proceeds to write.
 *
 * The slow path (something is already there) hands the stale/live decision
 * to `withReclaimMutex` rather than deciding inline, for the reason
 * documented on that function.
 */
export async function acquireLock(
  root: string,
  key: string,
  options: { ttlMs?: number; now?: () => number; pid?: number } = {},
): Promise<Lock | null> {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? Date.now;
  const pid = options.pid ?? process.pid;

  const dir = join(root, '.archivist', 'locks');
  await mkdir(dir, { recursive: true });
  // The key is tenant-influenced, so it is slugged before it reaches a path.
  const path = join(dir, `${safeSegment(key)}.lock`);
  const mutexPath = `${path}.reclaim-mutex`;
  const record: LockRecord = { key, pid, acquiredAt: now(), ttlMs };

  const temp = await stageExclusivePayload(path, JSON.stringify(record));
  try {
    return await acquireWithStagedRecord(path, mutexPath, temp, key, now);
  } finally {
    await discardStagedPayload(temp);
  }
}

/** The retry loop itself, split out only so the staged payload above has a
 * single, obvious lifetime: staged before, discarded after, whichever way this
 * returns. */
async function acquireWithStagedRecord(
  path: string,
  mutexPath: string,
  temp: string,
  key: string,
  now: () => number,
): Promise<Lock | null> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      await link(temp, path);
      return makeLock(path, key);
    } catch (err) {
      if (!isCreateContention(err)) throw err;
    }

    const outcome = await withReclaimMutex(mutexPath, async () => {
      // Read fresh, while holding exclusive rights to decide: no other
      // caller can be clearing `path` at the same time this runs.
      const existing = await readLockRecord(path);
      const stale = existing === null || now() - existing.acquiredAt >= existing.ttlMs;
      if (!stale) return 'live' as const;
      await rm(path, { force: true }).catch(() => undefined);
      return 'cleared' as const;
    });

    if (outcome === 'live') return null;
    // 'cleared'   -> loop back and retry the exclusive create; it now races
    //                fairly against any other legitimate acquirer.
    // 'contended' -> another caller is deciding right now; loop back and
    //                retry from the top, by which point they will have
    //                resolved it one way or another.
  }
  return null;
}

function makeLock(path: string, key: string): Lock {
  let released = false;
  return {
    key,
    async release() {
      if (released) return;
      released = true;
      // release() is overwhelmingly called from a `finally`. If it throws,
      // it replaces whatever error was already propagating with a
      // filesystem error from cleanup, and the original cause is lost. A
      // lock file that outlives its holder is not a deadlock either: the TTL
      // reclaim path exists precisely for the holder that never got to
      // release at all.
      await rm(path, { force: true }).catch(() => undefined);
    },
  };
}
