// packages/composition/src/run-store.ts
//
// Durable persistence for the MCP-level documentation run docs/03 describes
// -- distinct from `packages/capture/src/capture-run.ts`'s own internal run
// manifest, which lives under the *bundle's* root purely for Stage 1's own
// resumability. Both conform to the same published
// `schemas/run-manifest.schema.json` (its `stage` discriminator is exactly
// what lets one schema serve two owners at two different granularities --
// see the schema's own comment on that field), but they are separate files
// with separate lifecycles. This store always writes `stage: 'document'`:
// it represents the whole plan-to-promotion pipeline the MCP tools expose,
// even though "extracting" -- one coarse phase from this store's point of
// view -- is implemented by calling `runCapture`, which has many phases of
// its own (`discovering`, `fetching_definitions`, `walking_resources`,
// `downloading_assets`, `sealing`) that this manifest deliberately does not
// mirror. Folding the two vocabularies into one enum would have made this
// store's `state` field dishonest about which machine actually emitted it --
// see this task's final report for the longer version of that argument.
//
// This is composition's job, not application's, because it does real I/O:
// atomic file writes (`@genesys-archivist/storage`) and JSON Schema
// validation.
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Options, ValidateFunction } from 'ajv';
import { acquireLock, createStaging, promote, type StagingArea } from '@genesys-archivist/storage';
import { safeSegment } from '@genesys-archivist/security';

// packages/composition/src/run-store.ts -> <repo>/schemas/run-manifest.schema.json.
// The build output (packages/composition/dist/run-store.js) sits at the same
// depth below the repo root as this source file does, so the same relative
// walk resolves correctly whether this runs from src (via the test runner)
// or from a compiled dist/ -- the identical reasoning
// packages/capture/src/bundle-verifier.ts already documents for its own
// schema path.
const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(HERE, '..', '..', '..', 'schemas', 'run-manifest.schema.json');

interface AjvInstance {
  compile(schema: unknown): ValidateFunction;
}
interface Ajv2020Constructor {
  new (opts?: Options): AjvInstance;
}
type AddFormatsFn = (ajv: AjvInstance) => void;

// ajv's compiled CJS output does not play well with this project's
// NodeNext/verbatimModuleSyntax static-import interop; createRequire
// sidesteps it entirely. Identical fix, for the identical reason, as
// packages/capture/src/bundle-verifier.ts and
// packages/testing/src/schema-validator.ts.
const requireCjs = createRequire(import.meta.url);
const Ajv2020 = requireCjs('ajv/dist/2020.js') as Ajv2020Constructor;
const addFormats = requireCjs('ajv-formats') as AddFormatsFn;

let cachedValidator: Promise<ValidateFunction> | undefined;
async function getValidator(): Promise<ValidateFunction> {
  cachedValidator ??= (async () => {
    const schema: unknown = JSON.parse(await readFile(SCHEMA_PATH, 'utf8'));
    const ajv = new Ajv2020({ strict: true, allowUnionTypes: true });
    addFormats(ajv);
    return ajv.compile(schema);
  })();
  return cachedValidator;
}

// ---------------------------------------------------------------------------
// The manifest shape -- mirrors schemas/run-manifest.schema.json exactly.
// Ajv validates every instance against the published schema at the actual
// I/O boundary (save/load); these types exist so a caller in
// archivist-port.ts gets compile-time help building one, not as a second
// source of truth for what is legal.
// ---------------------------------------------------------------------------

export interface RunManifestIssue {
  readonly code: string;
  readonly category: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly flowId?: string | null;
}

export interface RunManifestArtifact {
  readonly kind: string;
  readonly uri: string;
  readonly hash: string;
  readonly classification?: 'internal' | 'confidential' | 'restricted';
}

export interface RunManifestSelectionEntry {
  readonly flowId: string;
  readonly flowType: string;
  readonly selectedVersion: string | number;
  readonly expectedAction: 'create' | 'update' | 'skip' | 'archive' | 'inspect';
}

export interface RunManifestProgress {
  readonly total: number;
  readonly queued: number;
  readonly running: number;
  readonly completed: number;
  readonly skipped: number;
  readonly failed: number;
}

export interface RunManifestFlowResult {
  readonly flowId: string;
  readonly selectedVersion: string | number;
  readonly status:
    | 'queued'
    | 'running'
    | 'completed'
    | 'completed_with_warnings'
    | 'skipped'
    | 'failed'
    | 'stale'
    | 'cancelled';
  readonly sourceChanged: boolean;
  readonly generatorChanged: boolean;
  readonly snapshotHash?: string;
  readonly warnings: readonly RunManifestIssue[];
  readonly errors: readonly RunManifestIssue[];
  readonly artifacts: readonly RunManifestArtifact[];
}

export interface RunManifestPolicy {
  readonly versionSelection: 'published' | 'checked-in' | 'working-copy' | 'published-and-latest';
  readonly allowPartialPromotion: boolean;
  readonly dataProcessingMode?: 'deterministic-only' | 'interactive-client' | 'approved-provider';
  readonly maxFlows?: number;
  readonly mode?: 'context' | 'migration';
}

export interface RunManifestVersions {
  readonly application?: string;
  readonly adapter?: string;
  readonly normalizer?: string;
  readonly analyzer?: string;
  readonly redactor?: string;
  readonly generator?: string;
  readonly template?: string;
  readonly genesysSdk?: string;
  readonly mcpSdk?: string;
}

/**
 * One MCP-level documentation run, as persisted. `state` is deliberately
 * typed as `string`, not `RunState` from `@genesys-archivist/application`:
 * this is the I/O boundary, and ajv (validating against the published
 * schema's `state` enum, a superset covering both stages) is the actual
 * source of truth for which values are legal here, not a second TypeScript
 * union that could drift from it.
 */
export interface RunManifest {
  readonly schemaVersion: '1.1';
  readonly stage: 'capture' | 'document';
  readonly runId: string;
  readonly planId: string;
  readonly planHash: string;
  readonly idempotencyKey: string;
  readonly profileId: string;
  readonly organization: { readonly id: string; readonly region: string; readonly name?: string };
  readonly state: string;
  readonly createdAt?: string;
  readonly startedAt?: string | null;
  readonly finishedAt?: string | null;
  readonly policy: RunManifestPolicy;
  readonly versions: RunManifestVersions;
  readonly selection: readonly RunManifestSelectionEntry[];
  readonly progress: RunManifestProgress;
  readonly flowResults: readonly RunManifestFlowResult[];
  readonly warnings: readonly RunManifestIssue[];
  readonly errors: readonly RunManifestIssue[];
  readonly artifacts: readonly RunManifestArtifact[];
}

export type LoadRunResult =
  | { readonly status: 'found'; readonly manifest: RunManifest }
  | { readonly status: 'absent' }
  /** A run manifest exists on disk but failed schema validation or JSON
   * parsing. Reported, never silently treated the same as `'absent'` -- a
   * corrupt record is evidence of a real problem (a torn write outside this
   * store's own atomic path, disk corruption, manual tampering) and an
   * operator needs to be able to tell it apart from "this run never ran". */
  | { readonly status: 'corrupt'; readonly reason: string };

export interface RunStoreOptions {
  readonly root: string;
}

export interface RunStore {
  save(manifest: RunManifest): Promise<void>;
  load(runId: string): Promise<LoadRunResult>;
}

function runDir(root: string, runId: string): string {
  return join(root, '.archivist', 'runs', safeSegment(runId));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

// Mirrors packages/storage/src/profile-store.ts's own write-lock retry
// constants and reasoning: legitimate concurrent writers to the same run
// (e.g. a checkpoint write racing a cancellation write) are the expected
// case this store must survive, not the exception, so contention is retried
// with a short backoff rather than surfaced as failure on the first miss.
const WRITE_LOCK_WAIT_MS = 5_000;
const WRITE_LOCK_RETRY_MS = 20;

function describeAjvErrors(validate: ValidateFunction): string {
  return (validate.errors ?? [])
    .map((e) => `${e.instancePath || '/'} ${e.message ?? 'is invalid'}`)
    .join('; ');
}

/**
 * Builds a `RunStore` rooted at `options.root` -- the same output root a
 * profile's captures and documents are staged and promoted under.
 *
 * Every write goes through `createStaging`/`promote`
 * (`@genesys-archivist/storage`), the same atomic primitive
 * `packages/storage/src/profile-store.ts` and `packages/capture/src/
 * capture-run.ts` already use: a failed or interrupted write can never leave
 * `manifest.json` torn, and a crash between the two renames `promote`
 * performs is exactly what `recoverPendingPromotions` (storage's own,
 * already-tested primitive) reconciles on next use -- this store adds no
 * second recovery mechanism of its own.
 *
 * Writes to the *same* run are serialized through `acquireLock`, keyed per
 * run rather than per store, so two runs never contend with each other's
 * writes.
 */
export function createRunStore(options: RunStoreOptions): RunStore {
  const { root } = options;

  async function withRunLock<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + WRITE_LOCK_WAIT_MS;
    for (;;) {
      const lock = await acquireLock(root, `run-store:${safeSegment(runId)}`);
      if (lock !== null) {
        try {
          return await fn();
        } finally {
          await lock.release();
        }
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for the run-store lock for run "${runId}".`);
      }
      await delay(WRITE_LOCK_RETRY_MS);
    }
  }

  return {
    async save(manifest: RunManifest): Promise<void> {
      // Captured before the ajv call: `ValidateFunction` is a type predicate,
      // and TypeScript narrows `manifest` itself (not just a local) inside
      // the `!validate(manifest)` branch -- reading `runId` off the original
      // reference afterward keeps its type honest.
      const runId = manifest.runId;
      const validate = await getValidator();
      if (!validate(manifest)) {
        // A manifest this store's own caller built failing schema validation
        // is a programming error, not a recoverable I/O condition -- this is
        // what "validated ... before promotion" means in practice: the bad
        // manifest never reaches disk at all.
        throw new Error(
          `Refusing to persist an invalid run manifest for run "${runId}": ` +
            describeAjvErrors(validate),
        );
      }

      await withRunLock(runId, async () => {
        const staging: StagingArea = await createStaging(
          root,
          `run-manifest-${safeSegment(runId)}`,
        );
        try {
          await staging.write(['manifest.json'], `${JSON.stringify(manifest, null, 2)}\n`);
          await promote(staging, runDir(root, runId));
        } catch (error) {
          await staging.discard();
          throw error;
        }
      });
    },

    async load(runId: string): Promise<LoadRunResult> {
      const path = join(runDir(root, runId), 'manifest.json');
      let raw: string;
      try {
        raw = await readFile(path, 'utf8');
      } catch {
        return { status: 'absent' };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return { status: 'corrupt', reason: 'manifest.json is not valid JSON.' };
      }

      const validate = await getValidator();
      if (!validate(parsed)) {
        return {
          status: 'corrupt',
          reason:
            'manifest.json does not satisfy the published run-manifest schema: ' +
            describeAjvErrors(validate),
        };
      }
      return { status: 'found', manifest: parsed as RunManifest };
    },
  };
}
