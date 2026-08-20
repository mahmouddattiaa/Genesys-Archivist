# Genesys Archivist — Plan 2: Storage, Capture Pipeline, and CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the entire Stage 1 capture pipeline — asset store, resource-graph walker, bundle writer, sealer, verifier, run state machine — plus the local infrastructure it sits on (OS credential store, atomic promotion, locking, symlink containment) and a runnable CLI. All of it against `FakeSourceProvider`, so none of it waits on Phase 0.

**Architecture:** The capture pipeline is written against the `GenesysSourceProvider` interface delivered in Plan 1, never against a real SDK. When spike S1 picks a source path, the only new code is the adapter behind that interface — the pipeline above it is already built and tested. Every test in this plan runs with no network.

**Tech Stack:** TypeScript 5.6 strict, Node 22 LTS, npm workspaces, Vitest, fast-check, Zod, Ajv 2020. One new runtime dependency, chosen in Task 1.

**Spec:** [docs/superpowers/specs/2026-08-20-genesys-archivist-design.md](../specs/2026-08-20-genesys-archivist-design.md)

**Predecessor:** [Plan 1: Foundation](2026-08-20-01-foundation.md) — complete. This plan assumes `identity`, `canonical`, `source-provider`, `redaction`, `paths`, `secret-store`, `profiles`, `logger`, `canaries`, and `FakeSourceProvider` all exist and are green.

## Global Constraints

Every task inherits these. They come from `AGENTS.md` and the design spec; none is negotiable.

- Node `>=22.15.0 <23`. TypeScript strict, plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `verbatimModuleSyntax`.
- Dependency direction, enforced by ESLint: `domain` imports nothing from this repo and performs no I/O (`node:crypto` excepted). `application` imports `domain` only. `apps/*` import `application` and `composition` only. Adapters import `domain`.
- **No credential may appear in any MCP tool argument, log line, manifest, snapshot, generated document, fixture, exception message, or telemetry field.**
- No `console.*` outside tests and `scripts/`. Use the logger from `@genesys-archivist/observability`.
- Runtime validation at every external boundary. A file read from disk is an external boundary.
- Redaction tokens are `[REDACTED:<category>]`. Hashes are `sha256:<64 lowercase hex>`.
- **Never overwrite last known-good output in place.** Stage, validate, atomically promote. A failed run must leave prior output intact — this is a release gate, not a best effort.
- **Never silently drop an unsupported node or unresolved reference.** Preserve it with an explicit status.
- Never commit `bundles/`, `derived/`, `documentation/`, `spike-evidence/`, `.env.phase0`, or any `.wav` / `.mp3`.
- Run `npm run verify` before every commit. It must pass.
- Tests that touch the real filesystem use `node:os` `tmpdir()` and clean up after themselves. No test writes inside the repository.

---

## File Structure

| File                                       | Responsibility                                                                |
| ------------------------------------------ | ----------------------------------------------------------------------------- |
| `packages/security/src/keyring.ts`         | `KeyringBackend` interface — the injectable seam over the OS credential store |
| `packages/security/src/secret-store-os.ts` | `OsSecretStore`, and the factory that wires the real backend                  |
| `packages/security/src/paths-real.ts`      | Symlink-aware containment: resolve, then `realpath`, then re-check            |
| `packages/storage/src/atomic.ts`           | Staging, validation, atomic promotion, recovery journal                       |
| `packages/storage/src/lock.ts`             | Single-writer lock per organization and output root                           |
| `packages/storage/src/asset-store.ts`      | Content-addressed binary store with deduplication                             |
| `packages/capture/src/resource-graph.ts`   | Worklist walk to closure over the reference graph                             |
| `packages/capture/src/bundle-writer.ts`    | Writes and seals the bundle layout                                            |
| `packages/capture/src/bundle-verifier.ts`  | Recomputes the seal; detects tampering                                        |
| `packages/capture/src/capture-run.ts`      | Capture run state machine with resumable progress                             |
| `apps/cli/src/bin.ts`                      | The `archivist` executable and argument parsing                               |
| `apps/cli/src/commands/capture.ts`         | `archivist capture` wired to the pipeline                                     |
| `scripts/spike/`                           | Phase 0 harness. Reads `.env.phase0`, never prints it                         |

---

### Task 1: OS credential store

**Files:**

- Create: `packages/security/src/keyring.ts`
- Create: `packages/security/src/secret-store-os.ts`
- Modify: `packages/security/src/index.ts`
- Modify: `packages/security/package.json` (one new dependency)
- Create: `docs/adr/ADR-013-credential-store.md`
- Test: `packages/security/test/secret-store-os.test.ts`

**Interfaces:**

- Consumes: `SecretStore` and `ProfileId` from Plan 1.
- Produces:
  - `interface KeyringBackend { getPassword(service, account): Promise<string | null>; setPassword(service, account, password): Promise<void>; deletePassword(service, account): Promise<boolean> }`
  - `class OsSecretStore implements SecretStore` taking a `KeyringBackend`
  - `createOsSecretStore(): OsSecretStore` — wires the real backend

**The design decision:** the OS keyring is injected behind `KeyringBackend`, so the store is unit-testable with an in-memory fake and needs no keyring daemon in CI. Linux CI runners have no `gnome-keyring`, so a store that talked to the OS directly would be untestable there.

- [ ] **Step 1: Choose the backend and record the decision**

Evaluate in this order and stop at the first that works on Windows, macOS, and Linux without a compiler toolchain:

1. `@napi-rs/keyring` — prebuilt native binaries, no `node-gyp`.
2. Shelling out to platform tools: PowerShell `CredentialManager` on Windows, `security` on macOS, `secret-tool` on Linux. Zero dependencies, more code, no build step.

Do NOT use `keytar` — it is archived and unmaintained.

Prove the choice by round-tripping a value on this machine before writing any production code:

```bash
npm install --workspace @genesys-archivist/security @napi-rs/keyring
node --input-type=module -e "import{Entry}from'@napi-rs/keyring';const e=new Entry('archivist-probe','probe');e.setPassword('ok');console.log('roundtrip:',e.getPassword()==='ok');e.deletePassword();"
```

Write `docs/adr/ADR-013-credential-store.md` using the template in `docs/adr/README.md`, recording what you chose, what you rejected, and why. If option 1 fails to install or round-trip, uninstall it and implement option 2 instead — the `KeyringBackend` interface is identical either way.

- [ ] **Step 2: Write the failing test**

```ts
// packages/security/test/secret-store-os.test.ts
import { describe, expect, it } from 'vitest';
import { asProfileId } from '@genesys-archivist/domain';
import { OsSecretStore, type KeyringBackend } from '../src/secret-store-os.js';

function fakeKeyring(): KeyringBackend & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    getPassword: (s, a) => Promise.resolve(store.get(`${s}:${a}`) ?? null),
    setPassword: (s, a, p) => {
      store.set(`${s}:${a}`, p);
      return Promise.resolve();
    },
    deletePassword: (s, a) => Promise.resolve(store.delete(`${s}:${a}`)),
  };
}

describe('OsSecretStore', () => {
  it('round-trips a secret for a profile', async () => {
    const store = new OsSecretStore(fakeKeyring());
    await store.set(asProfileId('acme'), 'shhh');
    expect(await store.get(asProfileId('acme'))).toBe('shhh');
  });

  it('returns null for an unknown profile rather than throwing', async () => {
    expect(await new OsSecretStore(fakeKeyring()).get(asProfileId('missing'))).toBeNull();
  });

  it('isolates profiles from one another', async () => {
    const store = new OsSecretStore(fakeKeyring());
    await store.set(asProfileId('a'), 'secret-a');
    await store.set(asProfileId('b'), 'secret-b');
    expect(await store.get(asProfileId('a'))).toBe('secret-a');
  });

  it('namespaces entries under a fixed service so it cannot collide with other apps', async () => {
    const keyring = fakeKeyring();
    await new OsSecretStore(keyring).set(asProfileId('acme'), 'shhh');
    expect([...keyring.store.keys()][0]).toMatch(/^genesys-archivist:/);
  });

  it('reports presence without returning the value', async () => {
    const store = new OsSecretStore(fakeKeyring());
    await store.set(asProfileId('acme'), 'shhh');
    expect(await store.has(asProfileId('acme'))).toBe(true);
    expect(await store.has(asProfileId('nope'))).toBe(false);
  });

  it('never exposes a secret through its own serialization', async () => {
    const store = new OsSecretStore(fakeKeyring());
    await store.set(asProfileId('acme'), 'CANARY-STORE-LEAK');
    expect(JSON.stringify(store)).not.toContain('CANARY-STORE-LEAK');
    expect(String(store)).not.toContain('CANARY-STORE-LEAK');
  });

  it('surfaces a backend failure as a structured error without the secret', async () => {
    const broken: KeyringBackend = {
      getPassword: () => Promise.reject(new Error('keyring locked')),
      setPassword: () => Promise.reject(new Error('keyring locked')),
      deletePassword: () => Promise.reject(new Error('keyring locked')),
    };
    await expect(new OsSecretStore(broken).get(asProfileId('acme'))).rejects.toThrow(
      /credential store/i,
    );
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run packages/security/test/secret-store-os.test.ts`
Expected: FAIL — cannot resolve `../src/secret-store-os.js`.

- [ ] **Step 4: Write the implementation**

```ts
// packages/security/src/keyring.ts
/**
 * The seam over the OS credential store. Injected rather than imported
 * directly so the secret store is unit-testable without a keyring daemon —
 * Linux CI runners have none.
 */
export interface KeyringBackend {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
}
```

```ts
// packages/security/src/secret-store-os.ts
import type { ProfileId } from '@genesys-archivist/domain';
import type { KeyringBackend } from './keyring.js';
import type { SecretStore } from './secret-store.js';

export type { KeyringBackend };

const SERVICE = 'genesys-archivist';

export class CredentialStoreError extends Error {
  constructor(operation: string) {
    // The underlying error is deliberately not chained into the message: OS
    // keyring errors have been observed to echo the value being stored.
    super(`The credential store failed during ${operation}. Run: archivist doctor`);
    this.name = 'CredentialStoreError';
  }
}

export class OsSecretStore implements SecretStore {
  readonly #backend: KeyringBackend;
  readonly #service: string;

  constructor(backend: KeyringBackend, service: string = SERVICE) {
    this.#backend = backend;
    this.#service = service;
  }

  async get(profileId: ProfileId): Promise<string | null> {
    try {
      return await this.#backend.getPassword(this.#service, profileId);
    } catch {
      throw new CredentialStoreError('read');
    }
  }

  async set(profileId: ProfileId, secret: string): Promise<void> {
    try {
      await this.#backend.setPassword(this.#service, profileId, secret);
    } catch {
      throw new CredentialStoreError('write');
    }
  }

  async has(profileId: ProfileId): Promise<boolean> {
    return (await this.get(profileId)) !== null;
  }

  toJSON(): Record<string, string> {
    return { type: 'OsSecretStore', service: this.#service };
  }

  toString(): string {
    return '[OsSecretStore]';
  }
}
```

Then add the real backend factory in the same file, wired to whatever Step 1 selected.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run packages/security/test/secret-store-os.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
npm run verify
git add packages/security docs/adr
git commit -m "feat(security): OS credential store behind an injectable keyring seam"
```

---

### Task 2: Symlink-aware path containment

**Files:**

- Create: `packages/security/src/paths-real.ts`
- Modify: `packages/security/src/index.ts`
- Test: `packages/security/test/paths-real.test.ts`

**Interfaces:**

- Consumes: `resolveWithinRoot`, `UntrustedPathError` from Plan 1.
- Produces: `resolveWithinRootReal(root: string, segments: readonly string[]): Promise<string>` — lexical containment, then `realpath` on the deepest existing ancestor, then containment re-check.

**Why this is a separate task:** Plan 1's `resolveWithinRoot` guards the _lexical_ path only. A symlink planted inside the output root defeats it entirely — `root/flows` can point at `C:\Windows` and the lexical check passes. Every real filesystem write goes through this function instead.

- [ ] **Step 1: Write the failing test**

```ts
// packages/security/test/paths-real.test.ts
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UntrustedPathError } from '../src/paths.js';
import { resolveWithinRootReal } from '../src/paths-real.js';

let root = '';
let outside = '';

beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), 'archivist-paths-'));
  root = join(base, 'root');
  outside = join(base, 'outside');
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, 'secret.txt'), 'other customer data');
});

afterEach(async () => {
  await rm(join(root, '..'), { recursive: true, force: true });
});

describe('resolveWithinRootReal', () => {
  it('resolves a path that stays inside the root', async () => {
    const p = await resolveWithinRootReal(root, ['flows', 'f1', 'business.md']);
    expect(p).toContain('business.md');
  });

  it('rejects lexical traversal, same as the lexical guard', async () => {
    await expect(resolveWithinRootReal(root, ['..', 'outside'])).rejects.toThrow(
      UntrustedPathError,
    );
  });

  it('rejects a directory symlink that escapes the root', async () => {
    // The lexical check passes here. Only realpath catches it.
    await symlink(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(resolveWithinRootReal(root, ['escape', 'secret.txt'])).rejects.toThrow(
      UntrustedPathError,
    );
  });

  it('allows a symlink that stays inside the root', async () => {
    await mkdir(join(root, 'real'), { recursive: true });
    await symlink(
      join(root, 'real'),
      join(root, 'link'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await expect(resolveWithinRootReal(root, ['link', 'x.md'])).resolves.toContain('x.md');
  });

  it('resolves correctly when the leaf does not exist yet', async () => {
    await expect(resolveWithinRootReal(root, ['not', 'created', 'yet.md'])).resolves.toContain(
      'yet.md',
    );
  });

  it('does not echo the attempted path into the error', async () => {
    await symlink(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(resolveWithinRootReal(root, ['escape', 'secret-customer'])).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('secret-customer') }),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/security/test/paths-real.test.ts`
Expected: FAIL — cannot resolve `../src/paths-real.js`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/security/src/paths-real.ts
import { realpath } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { resolveWithinRoot, UntrustedPathError } from './paths.js';

async function deepestExistingRealPath(candidate: string): Promise<string> {
  let current = candidate;
  for (;;) {
    try {
      return await realpath(current);
    } catch {
      const parent = dirname(current);
      // dirname of a filesystem root returns itself; stop rather than loop.
      if (parent === current) return candidate;
      current = parent;
    }
  }
}

/**
 * Lexical containment, then physical containment.
 *
 * resolveWithinRoot alone is not sufficient: a symlink planted inside the
 * output root can point anywhere, and the lexical check will happily approve
 * it. Every real filesystem write must go through this function.
 */
export async function resolveWithinRootReal(
  root: string,
  segments: readonly string[],
): Promise<string> {
  const lexical = resolveWithinRoot(root, segments);
  const realRoot = await realpath(resolve(root));
  const realCandidate = await deepestExistingRealPath(lexical);

  if (realCandidate !== realRoot && !realCandidate.startsWith(realRoot + sep)) {
    throw new UntrustedPathError('resolved outside the approved output root after link resolution');
  }
  return lexical;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/security/test/paths-real.test.ts`
Expected: PASS, 6 tests.

> If the symlink tests fail on Windows with `EPERM`, the `'junction'` type is required for directories and is what the test already uses. Junctions do not need administrator rights; file symlinks do. Do not weaken the test to a file symlink.

- [ ] **Step 5: Commit**

```bash
npm run verify
git add packages/security
git commit -m "feat(security): symlink-aware path containment"
```

---

### Task 3: Atomic promotion with a recovery journal

**Files:**

- Create: `packages/storage/src/atomic.ts`
- Modify: `packages/storage/src/index.ts`
- Modify: `packages/storage/package.json` (depend on security)
- Modify: `packages/storage/tsconfig.json` (reference security)
- Test: `packages/storage/test/atomic.test.ts`

**Interfaces:**

- Consumes: `resolveWithinRootReal` from Task 2.
- Produces:
  - `createStaging(root: string, runId: string): Promise<StagingArea>` where `StagingArea = { readonly dir: string; write(segments, contents): Promise<void>; discard(): Promise<void> }`
  - `promote(staging: StagingArea, targetDir: string, options?: { keepPrevious?: boolean }): Promise<PromotionResult>`
  - `recoverJournal(root: string): Promise<readonly RecoveryAction[]>`

**The invariant this task exists to guarantee:** _a failed or interrupted run leaves the previous output byte-identical._ This is a release gate in `docs/13-acceptance-criteria.md`, not an aspiration.

- [ ] **Step 1: Write the failing test**

```ts
// packages/storage/test/atomic.test.ts
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStaging, promote, recoverJournal } from '../src/atomic.js';

let root = '';
let target = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'archivist-atomic-'));
  target = join(root, 'documentation', 'acme');
  await mkdir(target, { recursive: true });
  await writeFile(join(target, 'business.md'), 'LAST KNOWN GOOD');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('atomic promotion', () => {
  it('promotes staged content into the target', async () => {
    const staging = await createStaging(root, 'run_1');
    await staging.write(['business.md'], 'NEW CONTENT');
    await promote(staging, target);
    expect(await readFile(join(target, 'business.md'), 'utf8')).toBe('NEW CONTENT');
  });

  it('leaves last known good intact when staging is discarded', async () => {
    const staging = await createStaging(root, 'run_2');
    await staging.write(['business.md'], 'HALF WRITTEN');
    await staging.discard();
    expect(await readFile(join(target, 'business.md'), 'utf8')).toBe('LAST KNOWN GOOD');
  });

  it('leaves last known good intact when promotion throws', async () => {
    const staging = await createStaging(root, 'run_3');
    await staging.write(['business.md'], 'NEW CONTENT');
    await expect(promote(staging, join(root, 'nonexistent', 'deeply', 'nested'))).rejects.toThrow();
    expect(await readFile(join(target, 'business.md'), 'utf8')).toBe('LAST KNOWN GOOD');
  });

  it('writes a journal entry before touching the target', async () => {
    const staging = await createStaging(root, 'run_4');
    await staging.write(['business.md'], 'NEW');
    await promote(staging, target);
    const journal = await recoverJournal(root);
    expect(journal.some((a) => a.runId === 'run_4' && a.phase === 'completed')).toBe(true);
  });

  it('reports an interrupted promotion as recoverable', async () => {
    const staging = await createStaging(root, 'run_5');
    await staging.write(['business.md'], 'NEW');
    // Simulate a crash after the journal is written but before promotion runs.
    await staging.markPromoting(target);
    const journal = await recoverJournal(root);
    const pending = journal.find((a) => a.runId === 'run_5');
    expect(pending?.phase).toBe('promoting');
  });

  it('refuses a target outside the approved root', async () => {
    const staging = await createStaging(root, 'run_6');
    await staging.write(['business.md'], 'NEW');
    await expect(promote(staging, join(root, '..', 'escape'))).rejects.toThrow();
  });

  it('removes the staging directory once promotion succeeds', async () => {
    const staging = await createStaging(root, 'run_7');
    await staging.write(['business.md'], 'NEW');
    const dir = staging.dir;
    await promote(staging, target);
    await expect(readdir(dir)).rejects.toThrow();
  });

  it('rejects a staged path that escapes the staging directory', async () => {
    const staging = await createStaging(root, 'run_8');
    await expect(staging.write(['..', '..', 'escape.md'], 'x')).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/storage/test/atomic.test.ts`
Expected: FAIL — cannot resolve `../src/atomic.js`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/storage/src/atomic.ts
import { mkdir, rename, rm, readFile, writeFile, appendFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { resolveWithinRootReal } from '@genesys-archivist/security';

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

async function appendJournal(root: string, action: RecoveryAction): Promise<void> {
  const path = journalPath(root);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(action) + '\n', 'utf8');
}

export async function createStaging(root: string, runId: string): Promise<StagingArea> {
  const dir = join(root, '.archivist', 'staging', runId);
  await mkdir(dir, { recursive: true });
  await appendJournal(root, { runId, phase: 'staging', target: '', at: new Date().toISOString() });

  return {
    dir,
    runId,
    async write(segments, contents) {
      const path = await resolveWithinRootReal(dir, segments);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, contents);
    },
    async markPromoting(target) {
      await appendJournal(root, {
        runId,
        phase: 'promoting',
        target,
        at: new Date().toISOString(),
      });
    },
    async discard() {
      await rm(dir, { recursive: true, force: true });
      await appendJournal(root, {
        runId,
        phase: 'rolled_back',
        target: '',
        at: new Date().toISOString(),
      });
    },
  };
}

export async function promote(
  staging: StagingArea,
  targetDir: string,
  options: { keepPrevious?: boolean } = {},
): Promise<PromotionResult> {
  const root = resolve(staging.dir, '..', '..', '..');
  const target = resolve(targetDir);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error('OUTPUT_ROOT_VIOLATION: promotion target is outside the approved root');
  }

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
    // Restore last known good before surfacing the failure.
    if (archived) await rename(previous, target).catch(() => undefined);
    await appendJournal(root, {
      runId: staging.runId,
      phase: 'rolled_back',
      target,
      at: new Date().toISOString(),
    });
    throw err;
  }

  if (archived && options.keepPrevious !== true) {
    await rm(previous, { recursive: true, force: true });
  }
  await appendJournal(root, {
    runId: staging.runId,
    phase: 'completed',
    target,
    at: new Date().toISOString(),
  });
  return { target, previousArchived: archived };
}

export async function recoverJournal(root: string): Promise<readonly RecoveryAction[]> {
  try {
    const raw = await readFile(journalPath(root), 'utf8');
    return raw
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as RecoveryAction);
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/storage/test/atomic.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
npm run verify
git add packages/storage
git commit -m "feat(storage): atomic promotion with a recovery journal"
```

---

### Task 4: Single-writer lock

**Files:**

- Create: `packages/storage/src/lock.ts`
- Modify: `packages/storage/src/index.ts`
- Test: `packages/storage/test/lock.test.ts`

**Interfaces:**

- Produces: `acquireLock(root: string, key: string, options?: { ttlMs?: number; now?: () => number; pid?: number }): Promise<Lock | null>` where `Lock = { readonly key: string; release(): Promise<void> }`. Returns `null` when another live holder owns it.

**Why a TTL and a PID:** a crashed process leaves its lock file behind. Without staleness detection the next run deadlocks forever on a holder that no longer exists.

- [ ] **Step 1: Write the failing test**

```ts
// packages/storage/test/lock.test.ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireLock } from '../src/lock.js';

let root = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'archivist-lock-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('acquireLock', () => {
  it('grants a lock when none is held', async () => {
    expect(await acquireLock(root, 'org_1')).not.toBeNull();
  });

  it('refuses a second holder for the same key', async () => {
    await acquireLock(root, 'org_1');
    expect(await acquireLock(root, 'org_1')).toBeNull();
  });

  it('allows different keys to proceed concurrently', async () => {
    await acquireLock(root, 'org_1');
    expect(await acquireLock(root, 'org_2')).not.toBeNull();
  });

  it('grants the lock again after release', async () => {
    const first = await acquireLock(root, 'org_1');
    await first!.release();
    expect(await acquireLock(root, 'org_1')).not.toBeNull();
  });

  it('reclaims a lock whose TTL has expired, so a crash cannot deadlock', async () => {
    let clock = 1_000;
    await acquireLock(root, 'org_1', { ttlMs: 100, now: () => clock });
    clock += 500;
    expect(await acquireLock(root, 'org_1', { ttlMs: 100, now: () => clock })).not.toBeNull();
  });

  it('does not reclaim a lock that is still within its TTL', async () => {
    let clock = 1_000;
    await acquireLock(root, 'org_1', { ttlMs: 10_000, now: () => clock });
    clock += 500;
    expect(await acquireLock(root, 'org_1', { ttlMs: 10_000, now: () => clock })).toBeNull();
  });

  it('is idempotent on release', async () => {
    const lock = await acquireLock(root, 'org_1');
    await lock!.release();
    await expect(lock!.release()).resolves.toBeUndefined();
  });

  it('does not let a key influence the lock file path', async () => {
    const lock = await acquireLock(root, '../../escape');
    expect(lock).not.toBeNull();
    await expect(acquireLock(root, '../../escape')).resolves.toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/storage/test/lock.test.ts`
Expected: FAIL — cannot resolve `../src/lock.js`.

- [ ] **Step 3: Write the implementation**

```ts
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

  const existing = await readFile(path, 'utf8').then(
    (raw) => JSON.parse(raw) as LockRecord,
    () => null,
  );

  if (existing !== null && now() - existing.acquiredAt < existing.ttlMs) {
    return null;
  }

  const record: LockRecord = { key, pid, acquiredAt: now(), ttlMs };
  await writeFile(path, JSON.stringify(record), 'utf8');

  let released = false;
  return {
    key,
    async release() {
      if (released) return;
      released = true;
      await rm(path, { force: true });
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/storage/test/lock.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
npm run verify
git add packages/storage
git commit -m "feat(storage): single-writer lock with stale-holder reclamation"
```

---

### Task 5: Content-addressed asset store

**Files:**

- Create: `packages/storage/src/asset-store.ts`
- Modify: `packages/storage/src/index.ts`
- Test: `packages/storage/test/asset-store.test.ts`

**Interfaces:**

- Produces:
  - `class AssetStore` with `put(bytes: Uint8Array, meta: AssetMeta): Promise<AssetHash>`, `writeIndex(): Promise<void>`, `readIndex(dir): Promise<AssetIndex>`
  - `AssetMeta = { readonly originalName: string; readonly mimeType: string; readonly usedBy: AssetUsage }`
  - `AssetUsage = { readonly type: string; readonly id: string; readonly language?: string }`

**Two properties that are the whole point:** identical audio referenced by twelve prompts is stored once, and the tenant-supplied filename never reaches the filesystem — it survives only as a string inside `index.json`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/storage/test/asset-store.test.ts
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AssetStore } from '../src/asset-store.js';

let dir = '';
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
const meta = (name: string, id = 'p1') => ({
  originalName: name,
  mimeType: 'audio/wav',
  usedBy: { type: 'prompt', id, language: 'en-US' },
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'archivist-assets-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('AssetStore', () => {
  it('returns a sha256-prefixed hash', async () => {
    expect(await new AssetStore(dir).put(bytes('audio'), meta('greeting.wav'))).toMatch(
      /^sha256:[0-9a-f]{64}$/,
    );
  });

  it('stores identical content exactly once', async () => {
    const store = new AssetStore(dir);
    await store.put(bytes('same audio'), meta('greeting.wav', 'p1'));
    await store.put(bytes('same audio'), meta('welcome.wav', 'p2'));
    await store.writeIndex();
    const files = (await readdir(dir)).filter((f) => f !== 'index.json');
    expect(files).toHaveLength(1);
  });

  it('records every usage of a deduplicated asset', async () => {
    const store = new AssetStore(dir);
    await store.put(bytes('same audio'), meta('greeting.wav', 'p1'));
    await store.put(bytes('same audio'), meta('welcome.wav', 'p2'));
    await store.writeIndex();
    const index = await AssetStore.readIndex(dir);
    expect(Object.values(index)[0]!.usedBy).toHaveLength(2);
  });

  it('stores differing content separately', async () => {
    const store = new AssetStore(dir);
    await store.put(bytes('audio one'), meta('a.wav'));
    await store.put(bytes('audio two'), meta('b.wav'));
    await store.writeIndex();
    expect((await readdir(dir)).filter((f) => f !== 'index.json')).toHaveLength(2);
  });

  it('never lets the tenant filename reach the filesystem', async () => {
    const store = new AssetStore(dir);
    await store.put(bytes('x'), meta('../../../etc/passwd'));
    await store.writeIndex();
    const files = (await readdir(dir)).filter((f) => f !== 'index.json');
    expect(files[0]).toMatch(/^[0-9a-f]{64}\.\w+$/);
    expect(files.join()).not.toContain('passwd');
  });

  it('preserves the original name in the index for migration', async () => {
    const store = new AssetStore(dir);
    await store.put(bytes('x'), meta('Greeting Prompt.wav'));
    await store.writeIndex();
    const index = await AssetStore.readIndex(dir);
    expect(Object.values(index)[0]!.originalName).toBe('Greeting Prompt.wav');
  });

  it('records byte length so bundle size is auditable', async () => {
    const store = new AssetStore(dir);
    await store.put(bytes('12345'), meta('a.wav'));
    await store.writeIndex();
    expect(Object.values(await AssetStore.readIndex(dir))[0]!.byteLength).toBe(5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/storage/test/asset-store.test.ts`
Expected: FAIL — cannot resolve `../src/asset-store.js`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/storage/src/asset-store.ts
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface AssetUsage {
  readonly type: string;
  readonly id: string;
  readonly language?: string;
}

export interface AssetMeta {
  readonly originalName: string;
  readonly mimeType: string;
  readonly usedBy: AssetUsage;
}

export interface AssetIndexEntry {
  readonly originalName: string;
  readonly mimeType: string;
  readonly byteLength: number;
  readonly usedBy: readonly AssetUsage[];
}

export type AssetIndex = Record<string, AssetIndexEntry>;

const EXTENSIONS: Record<string, string> = {
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'application/pdf': 'pdf',
};

export class AssetStore {
  readonly #dir: string;
  readonly #index = new Map<string, { entry: AssetIndexEntry; usages: AssetUsage[] }>();

  constructor(dir: string) {
    this.#dir = dir;
  }

  async put(bytes: Uint8Array, meta: AssetMeta): Promise<string> {
    const digest = createHash('sha256').update(bytes).digest('hex');
    const existing = this.#index.get(digest);

    if (existing !== undefined) {
      existing.usages.push(meta.usedBy);
      return `sha256:${digest}`;
    }

    // The filename is derived entirely from the content hash. The tenant-supplied
    // name never touches a path, which removes filename-driven traversal by
    // construction rather than by validation.
    const extension = EXTENSIONS[meta.mimeType] ?? 'bin';
    await mkdir(this.#dir, { recursive: true });
    await writeFile(join(this.#dir, `${digest}.${extension}`), bytes);

    this.#index.set(digest, {
      entry: {
        originalName: meta.originalName,
        mimeType: meta.mimeType,
        byteLength: bytes.byteLength,
        usedBy: [],
      },
      usages: [meta.usedBy],
    });
    return `sha256:${digest}`;
  }

  async writeIndex(): Promise<void> {
    const index: AssetIndex = Object.fromEntries(
      [...this.#index.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([digest, { entry, usages }]) => [digest, { ...entry, usedBy: usages }]),
    );
    await mkdir(this.#dir, { recursive: true });
    await writeFile(join(this.#dir, 'index.json'), JSON.stringify(index, null, 2), 'utf8');
  }

  static async readIndex(dir: string): Promise<AssetIndex> {
    return JSON.parse(await readFile(join(dir, 'index.json'), 'utf8')) as AssetIndex;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/storage/test/asset-store.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
npm run verify
git add packages/storage
git commit -m "feat(storage): content-addressed asset store with deduplication"
```

---

### Task 6: Resource reference-graph walker

**Files:**

- Create: `packages/capture/src/resource-graph.ts`
- Modify: `packages/capture/src/index.ts`
- Test: `packages/capture/test/resource-graph.test.ts`

**Interfaces:**

- Consumes: `DependencyRef`, `DependencyResolution`, `DependencyResolutionStatus` from `@genesys-archivist/domain`.
- Produces:
  - `interface ResourceResolver { resolve(refs: readonly DependencyRef[]): Promise<readonly DependencyResolution[]>; outwardRefs(resolution: DependencyResolution): readonly DependencyRef[] }`
  - `buildResourceGraph(seeds: readonly SeedRef[], resolver: ResourceResolver, options?: { maxRequests?: number }): Promise<ResourceGraph>` conforming to `schemas/resource-graph.schema.json`

**The three properties that matter:** the walk terminates on cyclic references, a `forbidden` node is preserved rather than dropped, and orphans are detectable. This is the code that answers "what breaks if we retire this queue".

- [ ] **Step 1: Write the failing test**

```ts
// packages/capture/test/resource-graph.test.ts
import { describe, expect, it } from 'vitest';
import type { DependencyRef, DependencyResolution } from '@genesys-archivist/domain';
import { buildResourceGraph, type ResourceResolver } from '../src/resource-graph.js';

/** Resolver over a static adjacency map. Anything absent resolves not_found. */
function resolverFrom(
  graph: Record<string, readonly string[]>,
  forbidden: readonly string[] = [],
): ResourceResolver {
  const parse = (key: string): DependencyRef => {
    const [type = '', id = ''] = key.split(':');
    return { type, id: id as DependencyRef['id'] };
  };
  return {
    resolve: (refs) =>
      Promise.resolve(
        refs.map((ref): DependencyResolution => {
          const key = `${ref.type}:${ref.id}`;
          if (forbidden.includes(key)) {
            return { ref, status: 'forbidden', displayName: null, safeMetadata: {} };
          }
          if (!(key in graph)) {
            return { ref, status: 'not_found', displayName: null, safeMetadata: {} };
          }
          return { ref, status: 'resolved', displayName: key, safeMetadata: {} };
        }),
      ),
    outwardRefs: (resolution) =>
      (graph[`${resolution.ref.type}:${resolution.ref.id}`] ?? []).map(parse),
  };
}

const seed = (key: string) => {
  const [type = '', id = ''] = key.split(':');
  return { type, id: id as DependencyRef['id'] };
};

describe('buildResourceGraph', () => {
  it('walks to closure across second-order references', async () => {
    const resolver = resolverFrom({
      'flow:f1': ['dataaction:da1'],
      'dataaction:da1': ['integration:i1'],
      'integration:i1': [],
    });
    const graph = await buildResourceGraph([seed('flow:f1')], resolver);
    expect(graph.nodes.map((n) => n.key).sort()).toEqual([
      'dataaction:da1',
      'flow:f1',
      'integration:i1',
    ]);
  });

  it('terminates on a cyclic reference', async () => {
    const resolver = resolverFrom({ 'flow:a': ['flow:b'], 'flow:b': ['flow:a'] });
    const graph = await buildResourceGraph([seed('flow:a')], resolver);
    expect(graph.nodes).toHaveLength(2);
  });

  it('records an edge for a repeated reference without duplicating the node', async () => {
    const resolver = resolverFrom({
      'flow:f1': ['queue:q1'],
      'flow:f2': ['queue:q1'],
      'queue:q1': [],
    });
    const graph = await buildResourceGraph([seed('flow:f1'), seed('flow:f2')], resolver);
    expect(graph.nodes.filter((n) => n.key === 'queue:q1')).toHaveLength(1);
    expect(graph.edges.filter((e) => e.to === 'queue:q1')).toHaveLength(2);
  });

  it('preserves a forbidden node instead of dropping it', async () => {
    const resolver = resolverFrom({ 'flow:f1': ['queue:q1'] }, ['queue:q1']);
    const graph = await buildResourceGraph([seed('flow:f1')], resolver);
    const node = graph.nodes.find((n) => n.key === 'queue:q1');
    expect(node?.resolutionStatus).toBe('forbidden');
  });

  it('preserves a not_found reference so a broken link stays visible', async () => {
    const resolver = resolverFrom({ 'flow:f1': ['queue:gone'] });
    const graph = await buildResourceGraph([seed('flow:f1')], resolver);
    expect(graph.nodes.find((n) => n.key === 'queue:gone')?.resolutionStatus).toBe('not_found');
  });

  it('reports orphans that nothing references', async () => {
    const resolver = resolverFrom({ 'flow:f1': [], 'queue:unused': [] });
    const graph = await buildResourceGraph([seed('flow:f1'), seed('queue:unused')], resolver);
    expect(graph.orphans).toContain('queue:unused');
  });

  it('stops at the request budget rather than running unbounded', async () => {
    const chain: Record<string, readonly string[]> = {};
    for (let i = 0; i < 200; i += 1) chain[`flow:f${String(i)}`] = [`flow:f${String(i + 1)}`];
    const graph = await buildResourceGraph([seed('flow:f0')], resolverFrom(chain), {
      maxRequests: 10,
    });
    expect(graph.nodes.length).toBeLessThanOrEqual(11);
  });

  it('produces output that validates against the published schema', async () => {
    const { default: Ajv2020 } = await import('ajv/dist/2020.js');
    const { readFile } = await import('node:fs/promises');
    const schema: unknown = JSON.parse(
      await readFile('schemas/resource-graph.schema.json', 'utf8'),
    );
    const validate = new Ajv2020({ strict: true }).compile(schema);
    const graph = await buildResourceGraph([seed('flow:f1')], resolverFrom({ 'flow:f1': [] }));
    expect(validate({ ...graph, schemaVersion: '1.0', captureId: 'c1' })).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/capture/test/resource-graph.test.ts`
Expected: FAIL — cannot resolve `../src/resource-graph.js`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/capture/src/resource-graph.ts
import type {
  DependencyRef,
  DependencyResolution,
  DependencyResolutionStatus,
} from '@genesys-archivist/domain';

export interface ResourceResolver {
  resolve(refs: readonly DependencyRef[]): Promise<readonly DependencyResolution[]>;
  outwardRefs(resolution: DependencyResolution): readonly DependencyRef[];
}

export interface ResourceGraphNode {
  readonly key: string;
  readonly type: string;
  readonly id: string;
  readonly displayName: string | null;
  readonly resolutionStatus: DependencyResolutionStatus;
}

export interface ResourceGraphEdge {
  readonly from: string;
  readonly to: string;
  readonly viaNodeId: string;
  readonly viaField: string;
}

export interface ResourceGraph {
  readonly nodes: readonly ResourceGraphNode[];
  readonly edges: readonly ResourceGraphEdge[];
  readonly orphans: readonly string[];
  readonly budgetExhausted: boolean;
}

const keyOf = (ref: DependencyRef): string => `${ref.type}:${ref.id}`;

const DEFAULT_MAX_REQUESTS = 10_000;

/**
 * Worklist walk to closure over the reference graph.
 *
 * A visited set makes cyclic references terminate; IVRs legitimately contain
 * flow-to-flow cycles. A request budget bounds a pathological tenant. Nothing
 * is ever dropped: an unresolvable reference becomes a node carrying an
 * explicit status, because a missing node and an unreachable node must be
 * distinguishable downstream.
 */
export async function buildResourceGraph(
  seeds: readonly DependencyRef[],
  resolver: ResourceResolver,
  options: { maxRequests?: number } = {},
): Promise<ResourceGraph> {
  const maxRequests = options.maxRequests ?? DEFAULT_MAX_REQUESTS;
  const nodes = new Map<string, ResourceGraphNode>();
  const edges: ResourceGraphEdge[] = [];
  const referenced = new Set<string>();

  let worklist: DependencyRef[] = [...seeds];
  let requests = 0;
  let budgetExhausted = false;

  while (worklist.length > 0) {
    const batch = worklist.filter((ref) => !nodes.has(keyOf(ref)));
    worklist = [];
    if (batch.length === 0) break;

    if (requests + batch.length > maxRequests) {
      budgetExhausted = true;
      batch.length = Math.max(0, maxRequests - requests);
      if (batch.length === 0) break;
    }

    const resolutions = await resolver.resolve(batch);
    requests += batch.length;

    for (const resolution of resolutions) {
      const key = keyOf(resolution.ref);
      nodes.set(key, {
        key,
        type: resolution.ref.type,
        id: resolution.ref.id,
        displayName: resolution.displayName,
        resolutionStatus: resolution.status,
      });

      // A node that could not be read cannot be asked for its own references.
      if (resolution.status !== 'resolved') continue;

      for (const outward of resolver.outwardRefs(resolution)) {
        const to = keyOf(outward);
        edges.push({ from: key, to, viaNodeId: key, viaField: outward.type });
        referenced.add(to);
        if (!nodes.has(to)) worklist.push(outward);
      }
    }

    if (budgetExhausted) break;
  }

  const orphans = [...nodes.keys()].filter((key) => !referenced.has(key)).sort();

  return {
    nodes: [...nodes.values()].sort((a, b) => (a.key < b.key ? -1 : 1)),
    edges,
    orphans,
    budgetExhausted,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/capture/test/resource-graph.test.ts`
Expected: PASS, 8 tests.

> The orphan test expects `queue:unused` to be reported. A seed that nothing references is an orphan by definition; `flow:f1` is also unreferenced, so assert with `toContain`, not equality. That is what the test does — do not tighten it.

- [ ] **Step 5: Commit**

```bash
npm run verify
git add packages/capture
git commit -m "feat(capture): resource reference-graph walker"
```

---

### Task 7: Bundle writer and sealer

**Files:**

- Create: `packages/capture/src/bundle-writer.ts`
- Modify: `packages/capture/src/index.ts`
- Test: `packages/capture/test/bundle-writer.test.ts`

**Interfaces:**

- Consumes: `contentHash` and `CanonicalOptions` from `@genesys-archivist/domain`; `createStaging` and `promote` from `@genesys-archivist/storage`; `AssetStore` from Task 5.
- Produces: `class BundleWriter` with `writeFlow`, `writeResource`, `putAsset`, `writeResourceGraph`, and `seal(): Promise<SealedBundle>` returning `{ captureId, contentHash, manifest }`.

**The sealing rule:** the content hash is computed over canonicalized content with volatile fields excluded — signed media URLs and extraction timestamps change on every run and would make every capture look different. Get this wrong and change detection reports 100% churn forever.

- [ ] **Step 1: Write the failing test**

> **Correction before you write this.** Several tests below build a second
> writer with `{ ...opts(), root: await mkdtemp(...) }`. Those extra
> directories are never removed — `afterEach` only deletes the one `root` from
> `beforeEach` — so every run of the suite leaks temp directories, forever.
> Track every directory you create and remove them all in `afterEach`.

```ts
// packages/capture/test/bundle-writer.test.ts
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BundleWriter } from '../src/bundle-writer.js';

let root = '';
const opts = () => ({
  root,
  captureId: '2026-08-20T14-02-11Z_a1b2c3',
  organization: { id: 'org_1', region: 'mec1' },
  policy: {
    versionSelection: 'published' as const,
    captureAssets: true,
    captureDataTableRows: true,
  },
  versions: { application: '0.1.0', adapter: '0.1.0', sourceProvider: 'fixture' as const },
  now: () => new Date('2026-08-20T14:31:00Z'),
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'archivist-bundle-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('BundleWriter', () => {
  it('produces a manifest that validates against the published schema', async () => {
    const { default: Ajv2020 } = await import('ajv/dist/2020.js');
    const { default: addFormats } = await import('ajv-formats');
    const schema: unknown = JSON.parse(
      await readFile('schemas/capture-bundle.schema.json', 'utf8'),
    );
    const ajv = new Ajv2020({ strict: true });
    addFormats(ajv);
    const writer = new BundleWriter(opts());
    await writer.writeFlow('f1', '1', 'name: Main\n', { id: 'f1', type: 'inboundcall' });
    const sealed = await writer.seal();
    expect(ajv.compile(schema)(sealed.manifest)).toBe(true);
  });

  it('classifies every bundle as restricted', async () => {
    const writer = new BundleWriter(opts());
    expect((await writer.seal()).manifest.classification).toBe('restricted');
  });

  it('produces the same content hash for the same content', async () => {
    const a = new BundleWriter({ ...opts(), root: await mkdtemp(join(tmpdir(), 'a-')) });
    const b = new BundleWriter({ ...opts(), root: await mkdtemp(join(tmpdir(), 'b-')) });
    for (const w of [a, b])
      await w.writeFlow('f1', '1', 'name: Main\n', { id: 'f1', type: 'inboundcall' });
    expect((await a.seal()).contentHash).toBe((await b.seal()).contentHash);
  });

  it('produces a different content hash when a flow definition changes', async () => {
    const a = new BundleWriter({ ...opts(), root: await mkdtemp(join(tmpdir(), 'a-')) });
    const b = new BundleWriter({ ...opts(), root: await mkdtemp(join(tmpdir(), 'b-')) });
    await a.writeFlow('f1', '1', 'name: Main\n', { id: 'f1', type: 'inboundcall' });
    await b.writeFlow('f1', '1', 'name: Changed\n', { id: 'f1', type: 'inboundcall' });
    expect((await a.seal()).contentHash).not.toBe((await b.seal()).contentHash);
  });

  it('ignores volatile fields, so a signed URL does not fake a change', async () => {
    const a = new BundleWriter({ ...opts(), root: await mkdtemp(join(tmpdir(), 'a-')) });
    const b = new BundleWriter({ ...opts(), root: await mkdtemp(join(tmpdir(), 'b-')) });
    await a.writeResource('prompts', 'p1', {
      id: 'p1',
      mediaUri: 'https://x/sig=AAA',
      extractedAt: '2026-01-01T00:00:00Z',
    });
    await b.writeResource('prompts', 'p1', {
      id: 'p1',
      mediaUri: 'https://x/sig=BBB',
      extractedAt: '2026-06-06T00:00:00Z',
    });
    expect((await a.seal()).contentHash).toBe((await b.seal()).contentHash);
  });

  it('counts what it captured', async () => {
    const writer = new BundleWriter(opts());
    await writer.writeFlow('f1', '1', 'x', { id: 'f1', type: 'inboundcall' });
    await writer.writeResource('queues', 'q1', { id: 'q1' });
    const sealed = await writer.seal();
    expect(sealed.manifest.counts.flows).toBe(1);
    expect(sealed.manifest.counts.resources).toBe(1);
  });

  it('records migration readiness honestly when assets were not captured', async () => {
    const writer = new BundleWriter({
      ...opts(),
      policy: { ...opts().policy, captureAssets: false },
    });
    const sealed = await writer.seal();
    expect(sealed.manifest.migrationReadiness?.assetsCaptured).toBe(false);
  });

  it('writes definition.yaml where a migration tool expects it', async () => {
    const writer = new BundleWriter(opts());
    await writer.writeFlow('f1', '1', 'name: Main\n', { id: 'f1', type: 'inboundcall' });
    await writer.seal();
    const path = join(root, 'flows', 'f1', 'versions', '1', 'definition.yaml');
    expect(await readFile(path, 'utf8')).toBe('name: Main\n');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/capture/test/bundle-writer.test.ts`
Expected: FAIL — cannot resolve `../src/bundle-writer.js`.

- [ ] **Step 3: Write the implementation**

Implement `BundleWriter` so that:

```ts
// packages/capture/src/bundle-writer.ts  (shape; fill in against the tests)
import { contentHash, type CanonicalOptions } from '@genesys-archivist/domain';
import { resolveWithinRootReal } from '@genesys-archivist/security';

/**
 * Fields excluded from the seal. Signed media URLs are regenerated per request
 * and extraction timestamps change every run; including either would make every
 * capture appear to differ from the last and report 100% churn forever.
 */
export const BUNDLE_CANONICAL: CanonicalOptions = {
  canonicalizerVersion: '1',
  volatileKeys: new Set(['mediaUri', 'extractedAt', 'downloadUrl', 'selfUri', 'dateModified']),
  orderSensitivePaths: new Set(['/graph/edges']),
};
```

`writeFlow(flowId, versionId, definitionYaml, flowMeta)` writes `flows/<flowId>/versions/<versionId>/definition.yaml` and `flow.json`, every path through `resolveWithinRootReal`. `writeResource(category, id, body)` writes `resources/<category>/<id>.json`. `seal()` canonicalizes the accumulated in-memory record of everything written, hashes it with `BUNDLE_CANONICAL`, assembles a manifest with `classification: 'restricted'`, `counts`, and `migrationReadiness`, writes `bundle-manifest.json`, and returns `{ captureId, contentHash, manifest }`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/capture/test/bundle-writer.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
npm run verify
git add packages/capture
git commit -m "feat(capture): bundle writer and content-hash sealing"
```

---

### Task 8: Bundle verifier

**Files:**

- Create: `packages/capture/src/bundle-verifier.ts`
- Modify: `packages/capture/src/index.ts`
- Test: `packages/capture/test/bundle-verifier.test.ts`

**Interfaces:**

- Produces: `verifyBundle(dir: string): Promise<VerificationResult>` where `VerificationResult = { readonly ok: boolean; readonly findings: readonly VerificationFinding[] }`.

**What it is for:** a bundle is handed to a separate migration server, possibly months later, possibly after being copied between machines. `archivist bundle verify` is how that server's operator establishes the bundle is intact and unmodified before acting on it.

- [ ] **Step 1: Write the failing test**

```ts
// packages/capture/test/bundle-verifier.test.ts
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BundleWriter } from '../src/bundle-writer.js';
import { verifyBundle } from '../src/bundle-verifier.js';

let root = '';

async function seededBundle(dir: string): Promise<void> {
  const writer = new BundleWriter({
    root: dir,
    captureId: '2026-08-20T14-02-11Z_a1b2c3',
    organization: { id: 'org_1', region: 'mec1' },
    policy: { versionSelection: 'published', captureAssets: true, captureDataTableRows: true },
    versions: { application: '0.1.0', adapter: '0.1.0', sourceProvider: 'fixture' },
    now: () => new Date('2026-08-20T14:31:00Z'),
  });
  await writer.writeFlow('f1', '1', 'name: Main\n', { id: 'f1', type: 'inboundcall' });
  await writer.seal();
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'archivist-verify-'));
  await seededBundle(root);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('verifyBundle', () => {
  it('accepts an untouched bundle', async () => {
    expect((await verifyBundle(root)).ok).toBe(true);
  });

  it('detects a modified flow definition', async () => {
    await writeFile(
      join(root, 'flows', 'f1', 'versions', '1', 'definition.yaml'),
      'name: Tampered\n',
    );
    const result = await verifyBundle(root);
    expect(result.ok).toBe(false);
    expect(result.findings.some((f) => f.code === 'CONTENT_HASH_MISMATCH')).toBe(true);
  });

  it('detects a deleted file', async () => {
    await rm(join(root, 'flows', 'f1', 'versions', '1', 'definition.yaml'));
    expect((await verifyBundle(root)).ok).toBe(false);
  });

  it('detects a tampered manifest hash', async () => {
    const path = join(root, 'bundle-manifest.json');
    const manifest = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    manifest['contentHash'] = 'sha256:' + '0'.repeat(64);
    await writeFile(path, JSON.stringify(manifest));
    expect((await verifyBundle(root)).ok).toBe(false);
  });

  it('reports a missing manifest rather than throwing', async () => {
    await rm(join(root, 'bundle-manifest.json'));
    const result = await verifyBundle(root);
    expect(result.ok).toBe(false);
    expect(result.findings.some((f) => f.code === 'MANIFEST_MISSING')).toBe(true);
  });

  it('rejects a manifest that does not satisfy the published schema', async () => {
    const path = join(root, 'bundle-manifest.json');
    const manifest = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    manifest['classification'] = 'public';
    await writeFile(path, JSON.stringify(manifest));
    const result = await verifyBundle(root);
    expect(result.findings.some((f) => f.code === 'MANIFEST_SCHEMA_INVALID')).toBe(true);
  });

  it('never includes bundle content in a finding message', async () => {
    await writeFile(
      join(root, 'flows', 'f1', 'versions', '1', 'definition.yaml'),
      'name: SECRET-CUSTOMER\n',
    );
    const result = await verifyBundle(root);
    expect(JSON.stringify(result)).not.toContain('SECRET-CUSTOMER');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/capture/test/bundle-verifier.test.ts`
Expected: FAIL — cannot resolve `../src/bundle-verifier.js`.

- [ ] **Step 3: Write the implementation**

`verifyBundle` reads `bundle-manifest.json`, validates it against `schemas/capture-bundle.schema.json` with Ajv, re-walks the bundle directory reconstructing the same canonical record `BundleWriter.seal()` hashed, recomputes the hash with `BUNDLE_CANONICAL`, and compares. Findings carry a `code` from `MANIFEST_MISSING | MANIFEST_SCHEMA_INVALID | CONTENT_HASH_MISMATCH | FILE_MISSING` and a message that never quotes bundle content.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/capture/test/bundle-verifier.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
npm run verify
git add packages/capture
git commit -m "feat(capture): bundle verifier with tamper detection"
```

---

### Task 9: Capture run state machine

**Files:**

- Create: `packages/capture/src/capture-run.ts`
- Modify: `packages/capture/src/index.ts`
- Test: `packages/capture/test/capture-run.test.ts`

**Interfaces:**

- Consumes: `GenesysSourceProvider` from `@genesys-archivist/domain`, `FakeSourceProvider` from `@genesys-archivist/testing`, `BundleWriter` from Task 7, `acquireLock` from Task 4.
- Produces: `runCapture(options: CaptureRunOptions): Promise<CaptureRunResult>` and `resumeCapture(runId, options): Promise<CaptureRunResult>`, persisting a run manifest that satisfies `schemas/run-manifest.schema.json`.

States: `planned → queued → discovering → fetching_definitions → walking_resources → downloading_assets → sealing → completed | completed_with_warnings | failed | cancelled`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/capture/test/capture-run.test.ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asFlowId, asOrganizationId } from '@genesys-archivist/domain';
import { FakeSourceProvider } from '@genesys-archivist/testing';
import { runCapture, resumeCapture } from '../src/capture-run.js';

let root = '';

function provider(count = 3): FakeSourceProvider {
  const p = new FakeSourceProvider({
    organizationId: asOrganizationId('org_1'),
    region: 'test',
    pageSize: 2,
  });
  for (let i = 0; i < count; i += 1) {
    p.seedFlow({
      flowId: asFlowId(`f${String(i)}`),
      name: `Flow ${String(i)}`,
      type: 'inboundcall',
    });
  }
  return p;
}

const opts = (overrides = {}) => ({
  root,
  runId: 'run_1',
  planHash: 'sha256:' + 'a'.repeat(64),
  organizationId: asOrganizationId('org_1'),
  expectedOrganizationId: asOrganizationId('org_1'),
  provider: provider(),
  ...overrides,
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'archivist-run-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('runCapture', () => {
  it('completes and seals a bundle', async () => {
    const result = await runCapture(opts());
    expect(result.state).toBe('completed');
    expect(result.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('captures every discovered flow across pages', async () => {
    expect((await runCapture(opts({ provider: provider(7) }))).progress.completed).toBe(7);
  });

  it('aborts before any read when the organization does not match', async () => {
    const result = await runCapture(
      opts({ expectedOrganizationId: asOrganizationId('org_OTHER') }),
    );
    expect(result.state).toBe('failed');
    expect(result.errors.some((e) => e.code === 'TENANT_MISMATCH')).toBe(true);
  });

  // CORRECTED. The original version of this test was a race, not a test:
  //
  //     const first = runCapture(opts({ runId: 'run_a' }));   // not awaited
  //     const second = await runCapture(opts({ runId: 'run_b' }));
  //
  // Both calls suspend inside acquireLock before either has created the lock
  // file, so the OS decides which one wins. The assertion that `second` is the
  // loser holds only by luck, and the test would fail intermittently in CI
  // while looking correct on the machine it was written on. Acquire the lock
  // deterministically first, then assert that a run cannot start.
  it('refuses to start when another run holds the lock', async () => {
    const held = await acquireLock(root, 'capture');
    expect(held).not.toBeNull();
    try {
      const blocked = await runCapture(opts({ runId: 'run_b' }));
      expect(blocked.state).toBe('failed');
      expect(blocked.errors.some((e) => e.code === 'OUTPUT_LOCKED')).toBe(true);
    } finally {
      await held?.release();
    }
  });

  it('persists a run manifest that satisfies the published schema', async () => {
    const { default: Ajv2020 } = await import('ajv/dist/2020.js');
    const { default: addFormats } = await import('ajv-formats');
    const { readFile } = await import('node:fs/promises');
    const schema: unknown = JSON.parse(await readFile('schemas/run-manifest.schema.json', 'utf8'));
    const ajv = new Ajv2020({ strict: true });
    addFormats(ajv);
    await runCapture(opts());
    const manifest: unknown = JSON.parse(
      await readFile(join(root, '.archivist', 'state', 'runs', 'run_1.json'), 'utf8'),
    );
    expect(ajv.compile(schema)(manifest)).toBe(true);
  });

  it('resumes without refetching completed flows', async () => {
    await runCapture(opts());
    const resumed = await resumeCapture('run_1', opts());
    expect(resumed.progress.skipped).toBeGreaterThan(0);
  });

  it('refuses to resume under a different plan hash', async () => {
    await runCapture(opts());
    const resumed = await resumeCapture('run_1', opts({ planHash: 'sha256:' + 'b'.repeat(64) }));
    expect(resumed.state).toBe('failed');
    expect(resumed.errors.some((e) => e.code === 'PLAN_HASH_MISMATCH')).toBe(true);
  });

  it('continues past one failing flow and reports it', async () => {
    const p = provider(3);
    p.seedFlow({ flowId: asFlowId('broken'), name: 'Broken', type: 'inboundcall', failLoad: true });
    const result = await runCapture(opts({ provider: p }));
    expect(result.state).toBe('completed_with_warnings');
    expect(result.progress.completed).toBe(3);
    expect(result.progress.failed).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/capture/test/capture-run.test.ts`
Expected: FAIL — cannot resolve `../src/capture-run.js`. It will also fail on `failLoad`, which `FakeSourceProvider` does not yet support.

- [ ] **Step 3: Extend the fake to support failure injection**

Add `failLoad?: boolean` to `SeededFlow` in `packages/testing/src/fake-source-provider.ts`; when set, `loadFlowSource` rejects with a structured `FLOW_LOAD_FAILED` error. Chaos testing needs a provider that can fail on demand, and this is the smallest change that gives it.

- [ ] **Step 4: Write the implementation**

`runCapture` acquires the lock, validates tenant identity **before any read**, discovers flows, writes each into a `BundleWriter`, persists the run manifest after every flow, seals, and promotes. A single flow failure is recorded and the run continues, ending `completed_with_warnings`. `resumeCapture` loads the persisted manifest, rejects a differing `planHash`, and skips flows already marked complete.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run packages/capture/test/capture-run.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Commit**

```bash
npm run verify
git add packages/capture packages/testing
git commit -m "feat(capture): resumable capture run state machine"
```

---

### Task 10: The `archivist` executable

**Files:**

- Create: `apps/cli/src/bin.ts`
- Create: `apps/cli/src/commands/capture.ts`
- Modify: `apps/cli/src/index.ts`, `apps/cli/package.json`
- Test: `apps/cli/test/bin.test.ts`

**Interfaces:**

- Produces: `buildProgram(deps: CliDeps): Command` — the parsed command tree, injectable so it tests without spawning a process. `bin.ts` is a four-line entry point that builds the program and parses `process.argv`.

Commands wired in this task: `doctor`, `profile list`, `capture --profile <id>`, `bundle verify <dir>`.

- [ ] **Step 1: Install commander and write the failing test**

```bash
npm install --workspace @genesys-archivist/cli commander
```

```ts
// apps/cli/test/bin.test.ts
import { describe, expect, it } from 'vitest';
import { buildProgram } from '../src/bin.js';

function run(argv: readonly string[]): { out: string[]; code: number | null } {
  const out: string[] = [];
  let code: number | null = null;
  const program = buildProgram({
    write: (s) => out.push(s),
    exit: (c) => {
      code = c;
    },
    doctor: () => Promise.resolve({ ok: true, checks: [] }),
    verifyBundle: () => Promise.resolve({ ok: true, findings: [] }),
    listProfiles: () => Promise.resolve([]),
    capture: () => Promise.resolve({ state: 'completed', contentHash: 'sha256:' + 'a'.repeat(64) }),
  });
  program.exitOverride();
  program.parse(['node', 'archivist', ...argv]);
  return { out, code };
}

describe('archivist CLI', () => {
  it('exposes the four release-1 commands', () => {
    const names = buildProgram({} as never)
      .commands.map((c) => c.name())
      .sort();
    expect(names).toEqual(['bundle', 'capture', 'doctor', 'profile']);
  });

  it('rejects an unknown command rather than doing something surprising', () => {
    expect(() => run(['frobnicate'])).toThrow();
  });

  it('requires --profile on capture', () => {
    expect(() => run(['capture'])).toThrow();
  });

  it('has no flag that accepts a client secret', () => {
    const flags = buildProgram({} as never)
      .commands.flatMap((c) => c.options.map((o) => o.flags))
      .join(' ');
    expect(flags).not.toMatch(/secret|password|token|credential/i);
  });

  it('prints a version', () => {
    expect(buildProgram({} as never).version()).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/cli/test/bin.test.ts`
Expected: FAIL — cannot resolve `../src/bin.js`.

- [ ] **Step 3: Write the implementation**

Build the command tree with commander. **No command may accept a secret as a flag** — `profile add` prompts on a TTY and is deliberately absent from the MCP surface. Add to `apps/cli/package.json`:

```json
"bin": { "archivist": "./dist/bin.js" }
```

`dist/bin.js` now exists, so this is safe. Add `#!/usr/bin/env node` as the first line of `bin.ts`.

- [ ] **Step 4: Run test to verify it passes, then prove the binary runs**

Run: `npx vitest run apps/cli/test/bin.test.ts` → PASS, 5 tests.
Run: `npm run build && node apps/cli/dist/bin.js doctor`
Expected: a readable diagnostic table, no stack trace, no secret.

- [ ] **Step 5: Commit**

```bash
npm run verify
git add apps/cli package-lock.json
git commit -m "feat(cli): archivist executable with doctor, profile, capture, and bundle verify"
```

---

### Task 11: Phase 0 spike harness

**Files:**

- Create: `scripts/spike/env.mjs`
- Create: `scripts/spike/s1-source-comparison.mjs`
- Create: `scripts/spike/s2-discovery.mjs`
- Create: `scripts/spike/s4-assets.mjs`
- Create: `docs/spikes/S1-source-path.md` (skeleton from the template)

**Interfaces:**

- Produces: `loadSpikeEnv(): SpikeEnv` reading `.env.phase0`, and three runnable probes writing sanitized evidence to `spike-evidence/`.

**Absolute rule for every file in this task:** the client secret is read, used to authenticate, and never printed, logged, written to `spike-evidence/`, or included in an error message. A spike script that echoes its own configuration is the exact failure the whole credential design exists to prevent.

- [ ] **Step 1: Write the environment loader**

```js
// scripts/spike/env.mjs
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/**
 * Reads .env.phase0. The returned secret is intended for exactly one purpose:
 * handing to the Genesys SDK. It must never be logged, written to
 * spike-evidence/, or included in an error message.
 */
export async function loadSpikeEnv() {
  let raw;
  try {
    raw = await readFile(join(ROOT, '.env.phase0'), 'utf8');
  } catch {
    throw new Error(
      'Missing .env.phase0. Copy .env.example and fill it in. Never paste credentials into a chat.',
    );
  }

  const env = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }

  const required = [
    'GENESYS_REGION',
    'GENESYS_CLIENT_ID',
    'GENESYS_CLIENT_SECRET',
    'GENESYS_EXPECTED_ORG_ID',
  ];
  const missing = required.filter((k) => !env[k]);
  if (missing.length > 0) throw new Error(`.env.phase0 is missing: ${missing.join(', ')}`);

  return {
    region: env.GENESYS_REGION,
    clientId: env.GENESYS_CLIENT_ID,
    expectedOrgId: env.GENESYS_EXPECTED_ORG_ID,
    // Deliberately a getter with no enumerable presence, so console.log(env)
    // and JSON.stringify(env) cannot emit it.
    get secret() {
      return env.GENESYS_CLIENT_SECRET;
    },
    toJSON() {
      return { region: this.region, clientId: '[present]', expectedOrgId: this.expectedOrgId };
    },
  };
}
```

- [ ] **Step 2: Prove the loader cannot leak**

```bash
node --input-type=module -e "
import { loadSpikeEnv } from './scripts/spike/env.mjs';
const e = await loadSpikeEnv();
const s = JSON.stringify(e) + String(e) + \$\{'\$'\}{JSON.stringify({...e})};
console.log('secret leaks through serialization:', s.includes(e.secret));
"
```

Expected: `false`. If it prints `true`, fix the loader before writing any probe.

- [ ] **Step 3: Write the S2 discovery probe first**

S2 is the cheapest probe and validates authentication, region, and tenant binding before the expensive S1 comparison. It authenticates, resolves the organization ID, **aborts if it does not match `GENESYS_EXPECTED_ORG_ID`**, then enumerates every flow type across all pages and writes counts by type and division to `spike-evidence/s2-inventory.json`. Names are hashed, not recorded.

- [ ] **Step 4: Write the S1 source comparison probe**

For each of 6–10 nominated flows, fetch the definition through each available source path (Platform API `/configuration`, Archy CLI, Architect Scripting SDK), and diff each against the manually exported Architect YAML baseline. Record per-path: success, byte size, node count, presence of tracking IDs, and a structural diff summary. Write to `spike-evidence/s1-comparison.json`. Record the decision in `docs/spikes/S1-source-path.md` and, once decided, as `docs/adr/ADR-014-source-path.md`.

- [ ] **Step 5: Write the S4 asset probe**

Enumerate prompts, resolve per-language resources, attempt to download one audio file, hash it, and measure the signed-URL lifetime. Record whether download succeeded under the read-only role — this is the input to **kill criterion 11**.

- [ ] **Step 6: Confirm nothing sensitive is tracked**

```bash
git status --short
git check-ignore -v .env.phase0 spike-evidence
```

Expected: `.env.phase0` and `spike-evidence/` both ignored; neither appears in `git status`.

- [ ] **Step 7: Commit the harness only**

```bash
npm run verify
git add scripts/spike docs/spikes
git commit -m "feat(spike): Phase 0 harness for S1, S2, and S4"
```

---

## Dependency graph for parallel execution

Partition by package, not by task — several tasks share a `src/index.ts`.

```text
WAVE A   Task 1, 2        packages/security
         Task 3, 4, 5     packages/storage      (3 must precede 4 and 5: both import from it)
         Task 11          scripts/spike         (no dependency on any of the above)

WAVE B   Task 6, 7, 8     packages/capture      (7 before 8: the verifier reads the writer's output)

WAVE C   Task 9           packages/capture + packages/testing
         Task 10          apps/cli
```

Within `packages/storage`, Task 3 delivers `resolveWithinRootReal` usage and the journal that Tasks 4 and 5 build beside; one agent should own all three sequentially.

## What this plan deliberately leaves out

| Deferred                                         | Blocked on                                                  |
| ------------------------------------------------ | ----------------------------------------------------------- |
| Any real Genesys adapter                         | Spike S1 picks the source path; S5 fixes the permission set |
| `evidence-pack` and `narrative-contract` schemas | The evidence model settles once the normalizer exists       |
| Normalizer, analyzer, semantic diff              | Needs a real source format from S1                          |
| Documentation templates, Mermaid, PDF            | Needs snapshots to render, and S10 for packaging            |
| Narration queue and claim validator              | Needs the evidence pack                                     |
| MCP server tools                                 | `AGENTS.md` requires the core and CLI to pass tests first   |

## Self-review notes

- **Spec coverage.** This plan implements spec sections 5.3 (resource graph), 5.4 (asset capture), 5.5 (bundle layout and sealing), 5.6 (capture run state machine), 9.2 (credentials), 9.3 (path safety), and the atomic-promotion invariant from 6.7. Section 5.1's four source paths and everything in section 6 beyond promotion remain deferred, with the blocker named above.
- **Type consistency.** `SecretStore` (Plan 1) is implemented by `OsSecretStore` in Task 1 with the same signature. `resolveWithinRootReal` from Task 2 is consumed by Tasks 3 and 7. `AssetStore` from Task 5 is consumed by Task 7. `BundleWriter` from Task 7 is consumed by Tasks 8 and 9. `FakeSourceProvider` from Plan 1 is extended once, in Task 9 Step 3, and that extension is called out explicitly rather than assumed.
- **Known gap.** Task 7's implementation is specified by shape and by its tests rather than given line by line, because the exact bundle-record structure is easier to derive from the eight assertions than to transcribe. Every assertion it must satisfy is present.
