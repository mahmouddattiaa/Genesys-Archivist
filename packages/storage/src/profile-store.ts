// packages/storage/src/profile-store.ts
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  profileMetadataSchema,
  resolveWithinRootReal,
  safeSegment,
  UntrustedPathError,
  type ProfileMetadata,
} from '@genesys-archivist/security';
import { createStaging, promote, type StagingArea } from './atomic.js';
import { acquireLock } from './lock.js';

/**
 * One profile that exists on disk but could not be turned into a
 * `ProfileMetadata`. `reason` is a fixed classification string, never the
 * file's own content or the underlying parser's message verbatim -- a
 * corrupt or tampered profile file may itself carry attacker- or
 * customer-controlled bytes (see the `.strict()` comment on
 * `profileMetadataSchema`), and `list()` must never become a way to read
 * them back out through an error string.
 */
export interface UnreadableProfile {
  readonly profileId: string;
  readonly reason: string;
}

export interface ProfileListResult {
  readonly profiles: readonly ProfileMetadata[];
  readonly unreadable: readonly UnreadableProfile[];
}

/**
 * Persists non-secret profile metadata. The client secret never passes
 * through here -- see `SecretStore` -- so every method on this interface is
 * safe to back with plain JSON files, safe to log the shape of, and safe to
 * expose (through a thin CLI wrapper) without touching the credential store
 * at all.
 */
export interface ProfileStore {
  list(): Promise<ProfileListResult>;
  get(profileId: string): Promise<ProfileMetadata | null>;
  put(profile: ProfileMetadata): Promise<void>;
  remove(profileId: string): Promise<void>;
}

const PROFILES_DIR_SEGMENT = 'profiles';
const WRITE_LOCK_KEY = 'profile-store-write';
// Bounds how long put()/remove() will wait for another writer (same process
// or a different one) to finish before giving up. Generous relative to how
// fast a single-directory JSON rewrite actually takes, so that legitimate
// concurrent callers queue rather than fail, while a genuinely stuck holder
// (e.g. crashed mid-write, past the lock's own TTL reclaim window) does not
// hang a caller forever.
const WRITE_LOCK_WAIT_MS = 5_000;
const WRITE_LOCK_RETRY_MS = 20;

function jsonFileName(profileId: string): string {
  return `${safeSegment(profileId)}.json`;
}

/** Validates the raw candidate against the *shape* the schema requires of a
 * `profileId` alone -- without requiring a whole `ProfileMetadata` object --
 * so `get`/`remove`, which only ever receive an id, can reject a hostile
 * value before it influences any path. `safeSegment` is applied on top of
 * this in every path built afterward, as defense in depth: the regex already
 * forbids the characters that would matter (no `.`, `/`, or control bytes),
 * but path construction should never depend on a single layer holding. */
function validateProfileId(candidate: string): string {
  const result = profileMetadataSchema.shape.profileId.safeParse(candidate);
  if (!result.success) {
    // Deliberately generic: candidate may itself be attacker- or
    // customer-supplied, and UntrustedPathError's whole contract is that it
    // never echoes the value it rejected.
    throw new UntrustedPathError('profileId does not match the required pattern');
  }
  return result.data;
}

function describeParseFailure(error: unknown): string {
  if (error instanceof SyntaxError) return 'profile file is not valid JSON';
  // A Zod issue's `code` (e.g. "unrecognized_keys", "invalid_type") never
  // carries the offending value -- only issue *shape* -- so joining codes is
  // safe to surface, unlike error.message, which for some issue kinds can
  // quote the input.
  if (
    typeof error === 'object' &&
    error !== null &&
    'issues' in error &&
    Array.isArray((error as { issues: unknown[] }).issues)
  ) {
    const codes = [
      ...new Set(
        (error as { issues: readonly { code: string }[] }).issues.map((issue) => issue.code),
      ),
    ];
    return `profile file failed schema validation (${codes.join(', ')})`;
  }
  return 'profile file could not be read';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

/**
 * File-backed `ProfileStore`. Layout: `<configRoot>/profiles/<profileId>.json`,
 * one file per profile.
 *
 * Every write rebuilds and atomically replaces the entire `profiles`
 * directory via `createStaging`/`promote` from `atomic.ts`, rather than
 * writing the single changed file in place. `promote` swaps a whole
 * directory, not one file inside it, so the only way to reuse that hardened
 * primitive without inventing a second, unaudited atomic-write path is to
 * stage a full, correct snapshot of the directory (every existing file,
 * verbatim, plus the one change) and promote it as a unit. This is more I/O
 * than a single-file update, but profile counts are small (a handful per
 * operator), and it means a crash or a failed write can never leave the
 * `profiles` directory holding a torn file -- the same guarantee
 * `atomic.test.ts` already proves for `createStaging`/`promote` in general.
 * Existing files that fail to parse are still copied through byte-for-byte:
 * a write to profile A must never be the thing that silently deletes a
 * corrupt profile B, which would defeat the "reported, not dropped" contract
 * `list()` provides for exactly that case.
 *
 * `put`/`remove` additionally serialize through a single store-wide
 * `acquireLock` (not one lock per profile id): two writers touching
 * *different* ids still both rewrite the same shared directory, and without
 * a shared lock the second promote to complete would silently discard the
 * first writer's change. Retried with a short backoff up to
 * `WRITE_LOCK_WAIT_MS` rather than surfacing a single contended attempt as
 * failure, since legitimate concurrent `put`s are the expected case this
 * class is required to survive, not the exception.
 */
export class FileProfileStore implements ProfileStore {
  readonly #configRoot: string;

  constructor(configRoot: string) {
    this.#configRoot = configRoot;
  }

  async list(): Promise<ProfileListResult> {
    const profilesDir = await this.#profilesDir();
    let entries: string[];
    try {
      entries = await readdir(profilesDir);
    } catch {
      return { profiles: [], unreadable: [] };
    }

    const profiles: ProfileMetadata[] = [];
    const unreadable: UnreadableProfile[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const profileId = entry.slice(0, -'.json'.length);
      const parsed = await this.#readOne(join(profilesDir, entry));
      if (parsed.ok) {
        profiles.push(parsed.value);
      } else {
        unreadable.push({ profileId, reason: parsed.reason });
      }
    }
    profiles.sort((a, b) => (a.profileId < b.profileId ? -1 : a.profileId > b.profileId ? 1 : 0));
    unreadable.sort((a, b) => (a.profileId < b.profileId ? -1 : a.profileId > b.profileId ? 1 : 0));
    return { profiles, unreadable };
  }

  async get(profileId: string): Promise<ProfileMetadata | null> {
    const validated = validateProfileId(profileId);
    const profilesDir = await this.#profilesDir();
    const path = await resolveWithinRootReal(profilesDir, [jsonFileName(validated)]);
    const parsed = await this.#readOne(path);
    if (parsed.ok) return parsed.value;
    if (parsed.reason === 'profile file could not be read') return null;
    throw new Error(`Stored profile "${validated}" is unreadable: ${parsed.reason}`);
  }

  async put(profile: ProfileMetadata): Promise<void> {
    // Defense in depth: even though every caller in this codebase is typed
    // to pass an already-valid ProfileMetadata, this is the last point
    // before anything reaches disk, so a caller that bypassed the type
    // system (or a future one that does) cannot write an invalid file.
    const validated = profileMetadataSchema.parse(profile);
    const fileName = jsonFileName(validated.profileId);
    const serialized = `${JSON.stringify(validated, null, 2)}\n`;
    // Validate the exact bytes about to be promoted, not just the object
    // that produced them -- guards against a future bug in serialization
    // itself producing something `profileMetadataSchema` would reject.
    profileMetadataSchema.parse(JSON.parse(serialized) as unknown);

    await this.#withWriteLock(async () => {
      const profilesDir = await this.#profilesDir();
      const snapshot = await this.#readRawSnapshot(profilesDir);
      snapshot.set(fileName, Buffer.from(serialized, 'utf8'));
      await this.#replaceDirectory(profilesDir, snapshot);
    });
  }

  async remove(profileId: string): Promise<void> {
    const validated = validateProfileId(profileId);
    const fileName = jsonFileName(validated);

    await this.#withWriteLock(async () => {
      const profilesDir = await this.#profilesDir();
      const snapshot = await this.#readRawSnapshot(profilesDir);
      if (!snapshot.has(fileName)) return; // Idempotent: nothing to remove.
      snapshot.delete(fileName);
      await this.#replaceDirectory(profilesDir, snapshot);
    });
  }

  async #profilesDir(): Promise<string> {
    await mkdir(this.#configRoot, { recursive: true });
    const dir = await resolveWithinRootReal(this.#configRoot, [PROFILES_DIR_SEGMENT]);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  async #readOne(
    path: string,
  ): Promise<{ ok: true; value: ProfileMetadata } | { ok: false; reason: string }> {
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch {
      return { ok: false, reason: 'profile file could not be read' };
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch (error) {
      return { ok: false, reason: describeParseFailure(error) };
    }
    const result = profileMetadataSchema.safeParse(parsedJson);
    if (!result.success) return { ok: false, reason: describeParseFailure(result.error) };
    return { ok: true, value: result.data };
  }

  /** Reads every `*.json` file in `profilesDir` as raw bytes, unparsed. Used
   * only to reproduce untouched files verbatim in a rewritten snapshot --
   * parsing here would either normalize (defeating "verbatim") or drop a
   * corrupt sibling file entirely, which is exactly the silent-drop this
   * class must not do. */
  async #readRawSnapshot(profilesDir: string): Promise<Map<string, Buffer>> {
    const snapshot = new Map<string, Buffer>();
    let entries: string[];
    try {
      entries = await readdir(profilesDir);
    } catch {
      return snapshot;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      try {
        snapshot.set(entry, await readFile(join(profilesDir, entry)));
      } catch {
        // Vanished or became unreadable between readdir and read (e.g. a
        // concurrent remove). Excluding it from this write's snapshot is the
        // correct outcome: whatever removed it already owns that change.
      }
    }
    return snapshot;
  }

  async #replaceDirectory(
    profilesDir: string,
    snapshot: ReadonlyMap<string, Buffer>,
  ): Promise<void> {
    const staging: StagingArea = await createStaging(
      this.#configRoot,
      `profile-store-${randomUUID()}`,
    );
    try {
      for (const [name, contents] of snapshot) {
        await staging.write([name], contents);
        await this.#restrictMode(staging.dir, name);
      }
      await promote(staging, profilesDir);
    } catch (error) {
      await staging.discard();
      throw error;
    }
  }

  /** Best-effort 0600 on POSIX. `chmod` is a no-op that never throws on
   * Windows for this kind of permission narrowing, but wrapping it anyway
   * means a platform where it genuinely fails can never turn "restrict this
   * file's mode" into "the profile write itself failed". */
  async #restrictMode(stagingDir: string, name: string): Promise<void> {
    try {
      await chmod(join(stagingDir, name), 0o600);
    } catch {
      // Best-effort only; see comment above.
    }
  }

  async #withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + WRITE_LOCK_WAIT_MS;
    for (;;) {
      const lock = await acquireLock(this.#configRoot, WRITE_LOCK_KEY);
      if (lock !== null) {
        try {
          return await fn();
        } finally {
          await lock.release();
        }
      }
      if (Date.now() >= deadline) {
        throw new Error('Timed out waiting for the profile store write lock.');
      }
      await delay(WRITE_LOCK_RETRY_MS);
    }
  }
}
