// packages/storage/src/lock.ts
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
  let acquired = false;
  for (let attempt = 0; attempt < MAX_ATTEMPTS && !acquired; attempt += 1) {
    try {
      await writeFile(mutexPath, JSON.stringify({ at: Date.now() }), {
        encoding: 'utf8',
        flag: 'wx',
      });
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

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      await writeFile(path, JSON.stringify(record), { encoding: 'utf8', flag: 'wx' });
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
