// apps/cli/test/profile-command.test.ts
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CANARIES, scanForCanaries } from '@genesys-archivist/testing';
import {
  OsSecretStore,
  profileMetadataSchema,
  type KeyringBackend,
} from '@genesys-archivist/security';
import { openProfileStore } from '@genesys-archivist/composition';
import { buildProgram, type CliDeps } from '../src/bin.js';
import {
  parseProfileArgs,
  readSecretFromStdin,
  runProfileAdd,
  runProfileList,
  runProfileRemove,
  runProfileSetSecret,
  runProfileShow,
  runProfileValidate,
  type ProfileCommandDeps,
  type ProfileStoreLike,
} from '../src/commands/profile.js';

// ---------------------------------------------------------------------------
// parseProfileArgs -- pure, no filesystem or process involved.
// ---------------------------------------------------------------------------

describe('parseProfileArgs', () => {
  it('parses a well-formed add', () => {
    const result = parseProfileArgs([
      'add',
      '--id',
      'acme',
      '--display-name',
      'Acme',
      '--region',
      'mec1',
      '--org',
      'org_1',
      '--client-id',
      'client-1',
      '--output-root',
      '/work/out',
    ]);
    expect(result).toEqual({
      kind: 'add',
      args: {
        profileId: 'acme',
        displayName: 'Acme',
        region: 'mec1',
        organizationId: 'org_1',
        clientId: 'client-1',
        outputRoot: '/work/out',
      },
    });
  });

  it('rejects add with a missing required flag', () => {
    const result = parseProfileArgs(['add', '--id', 'acme']);
    expect(result.kind).toBe('error');
  });

  it('rejects --client-secret on add with an explanation, not a generic "unknown option"', () => {
    const result = parseProfileArgs(['add', '--id', 'acme', '--client-secret', 'hunter2']);
    expect(result.kind).toBe('error');
    expect(result.kind === 'error' && result.message).toMatch(/argv|stdin/i);
    expect(result.kind === 'error' && result.message).not.toBe('Unknown flag: --client-secret');
  });

  it('rejects a flag merely resembling a secret flag, e.g. --token, on add', () => {
    const result = parseProfileArgs(['add', '--id', 'acme', '--token', 'x']);
    expect(result.kind).toBe('error');
    expect(result.kind === 'error' && result.message).toMatch(/argv|stdin/i);
  });

  it('rejects --client-secret on set-secret too', () => {
    const result = parseProfileArgs(['set-secret', 'acme', '--client-secret', 'hunter2']);
    expect(result.kind).toBe('error');
    expect(result.kind === 'error' && result.message).toMatch(/argv|stdin/i);
  });

  it('parses list with no arguments', () => {
    expect(parseProfileArgs(['list'])).toEqual({ kind: 'list' });
  });

  it('parses show <id>', () => {
    expect(parseProfileArgs(['show', 'acme'])).toEqual({ kind: 'show', profileId: 'acme' });
  });

  it('parses remove <id> without --yes', () => {
    expect(parseProfileArgs(['remove', 'acme'])).toEqual({
      kind: 'remove',
      profileId: 'acme',
      yes: false,
    });
  });

  it('parses remove <id> --yes', () => {
    expect(parseProfileArgs(['remove', 'acme', '--yes'])).toEqual({
      kind: 'remove',
      profileId: 'acme',
      yes: true,
    });
  });

  it('parses set-secret <id>', () => {
    expect(parseProfileArgs(['set-secret', 'acme'])).toEqual({
      kind: 'set-secret',
      profileId: 'acme',
    });
  });

  it('parses validate <id>', () => {
    expect(parseProfileArgs(['validate', 'acme'])).toEqual({ kind: 'validate', profileId: 'acme' });
  });

  it('rejects a missing subcommand', () => {
    expect(parseProfileArgs([]).kind).toBe('error');
  });

  it('rejects an unknown subcommand', () => {
    expect(parseProfileArgs(['frobnicate']).kind).toBe('error');
  });

  it('rejects show without an id', () => {
    expect(parseProfileArgs(['show']).kind).toBe('error');
  });
});

// ---------------------------------------------------------------------------
// runProfile* against a fake ProfileStoreLike/SecretStore -- fast, no I/O.
// ---------------------------------------------------------------------------

function profile(overrides: Partial<Record<string, unknown>> = {}) {
  return profileMetadataSchema.parse({
    profileId: 'acme',
    displayName: 'Acme Bank',
    region: 'mec1',
    expectedOrganizationId: 'org_1',
    clientId: 'CLIENT-ID-SHOULD-NEVER-APPEAR',
    outputRoot: '/work/out',
    ...overrides,
  });
}

function fakeProfileStore(initial: ReturnType<typeof profile>[] = []): ProfileStoreLike {
  const byId = new Map(initial.map((p) => [p.profileId, p]));
  return {
    list: () =>
      Promise.resolve({
        profiles: [...byId.values()],
        unreadable: [],
      }),
    get: (id) => Promise.resolve(byId.get(id) ?? null),
    put: (p) => {
      byId.set(p.profileId, p);
      return Promise.resolve();
    },
    remove: (id) => {
      byId.delete(id);
      return Promise.resolve();
    },
  };
}

function fakeSecretStore(): {
  has: (id: string) => Promise<boolean>;
  get: (id: string) => Promise<string | null>;
  set: (id: string, secret: string) => Promise<void>;
  remove: (id: string) => Promise<boolean>;
} & ProfileCommandDeps['secretStore'] {
  const store = new Map<string, string>();
  return {
    get: (id) => Promise.resolve(store.get(id) ?? null),
    set: (id, secret) => {
      store.set(id, secret);
      return Promise.resolve();
    },
    has: (id) => Promise.resolve(store.has(id)),
    remove: (id) => Promise.resolve(store.delete(id)),
  };
}

function commandDeps(overrides: Partial<ProfileCommandDeps> = {}): {
  deps: ProfileCommandDeps;
  out: string[];
} {
  const out: string[] = [];
  const deps: ProfileCommandDeps = {
    write: (line) => out.push(line),
    profileStore: fakeProfileStore(),
    secretStore: fakeSecretStore(),
    readSecret: () => Promise.resolve('a-secret'),
    confirm: () => Promise.resolve(true),
    checkOutputRootWritable: () => Promise.resolve(true),
    ...overrides,
  };
  return { deps, out };
}

describe('runProfileAdd', () => {
  it('stores the secret before the metadata, then reports success', async () => {
    const store = fakeProfileStore();
    const secrets = fakeSecretStore();
    const { deps, out } = commandDeps({ profileStore: store, secretStore: secrets });
    const exitCode = await runProfileAdd(deps, {
      profileId: 'acme',
      displayName: 'Acme',
      region: 'mec1',
      organizationId: 'org_1',
      clientId: 'client-1',
      outputRoot: '/work/out',
    });
    expect(exitCode).toBe(0);
    expect(await secrets.has('acme')).toBe(true);
    expect((await store.get('acme'))?.displayName).toBe('Acme');
    expect(out.some((l) => l.includes('saved'))).toBe(true);
  });

  it('never calls put() when storing the secret fails', async () => {
    const store = fakeProfileStore();
    const { deps } = commandDeps({
      profileStore: store,
      secretStore: {
        get: () => Promise.resolve(null),
        set: () => Promise.reject(new Error('keyring locked')),
        has: () => Promise.resolve(false),
        remove: () => Promise.resolve(false),
      },
    });
    const exitCode = await runProfileAdd(deps, {
      profileId: 'acme',
      displayName: 'Acme',
      region: 'mec1',
      organizationId: 'org_1',
      clientId: 'client-1',
      outputRoot: '/work/out',
    });
    expect(exitCode).toBe(1);
    expect(await store.get('acme')).toBeNull();
  });

  it('rejects an empty secret without writing anything', async () => {
    const store = fakeProfileStore();
    const { deps } = commandDeps({ profileStore: store, readSecret: () => Promise.resolve('  ') });
    const exitCode = await runProfileAdd(deps, {
      profileId: 'acme',
      displayName: 'Acme',
      region: 'mec1',
      organizationId: 'org_1',
      clientId: 'client-1',
      outputRoot: '/work/out',
    });
    expect(exitCode).toBe(1);
    expect(await store.get('acme')).toBeNull();
  });
});

describe('runProfileList', () => {
  it('includes display name and region, and never the client id', async () => {
    const { deps, out } = commandDeps({ profileStore: fakeProfileStore([profile()]) });
    await runProfileList(deps);
    const text = out.join('\n');
    expect(text).toContain('Acme Bank');
    expect(text).toContain('mec1');
    expect(text).not.toContain('CLIENT-ID-SHOULD-NEVER-APPEAR');
  });

  it('reports secretPresent based on the secret store', async () => {
    const secrets = fakeSecretStore();
    await secrets.set('acme', 'shhh');
    const { deps, out } = commandDeps({
      profileStore: fakeProfileStore([profile()]),
      secretStore: secrets,
    });
    await runProfileList(deps);
    expect(out.join('\n')).toContain('secret=present');
  });

  it('lists unreadable profiles alongside valid ones', async () => {
    const store: ProfileStoreLike = {
      list: () =>
        Promise.resolve({
          profiles: [profile()],
          unreadable: [{ profileId: 'broken', reason: 'profile file is not valid JSON' }],
        }),
      get: () => Promise.resolve(null),
      put: () => Promise.resolve(),
      remove: () => Promise.resolve(),
    };
    const { deps, out } = commandDeps({ profileStore: store });
    await runProfileList(deps);
    const text = out.join('\n');
    expect(text).toContain('broken');
    expect(text).toMatch(/UNREADABLE/);
  });
});

describe('runProfileShow', () => {
  it('reports not found for a missing profile', async () => {
    const { deps, out } = commandDeps();
    const exitCode = await runProfileShow(deps, 'nope');
    expect(exitCode).toBe(1);
    expect(out.some((l) => /not found/i.test(l))).toBe(true);
  });
});

describe('runProfileRemove', () => {
  it('is idempotent for a profile that does not exist', async () => {
    const { deps } = commandDeps();
    expect(await runProfileRemove(deps, 'nope', { yes: true })).toBe(0);
  });

  it('does not remove without confirmation unless --yes is given', async () => {
    const store = fakeProfileStore([profile()]);
    const { deps } = commandDeps({ profileStore: store, confirm: () => Promise.resolve(false) });
    await runProfileRemove(deps, 'acme', { yes: false });
    expect(await store.get('acme')).not.toBeNull();
  });

  it('removes without prompting when --yes is given', async () => {
    const store = fakeProfileStore([profile()]);
    const { deps } = commandDeps({
      profileStore: store,
      confirm: () => Promise.reject(new Error('must not be called')),
    });
    await runProfileRemove(deps, 'acme', { yes: true });
    expect(await store.get('acme')).toBeNull();
  });

  it('deletes the stored secret, not just the metadata', async () => {
    // Deleting the profile while leaving the credential in the OS keyring
    // produces an orphaned secret: live, unreferenced, and invisible to every
    // listing this tool offers.
    const store = fakeProfileStore([profile()]);
    const secrets = fakeSecretStore();
    await secrets.set('acme', 'CANARY-SECRET-ORPHAN-31c8');
    const { deps } = commandDeps({ profileStore: store, secretStore: secrets });

    await runProfileRemove(deps, 'acme', { yes: true });

    expect(await secrets.get('acme')).toBeNull();
    expect(await store.get('acme')).toBeNull();
  });

  it('keeps the profile when the secret cannot be deleted', async () => {
    // The ordering that matters: secret first, metadata second. If the delete
    // fails, the profile must survive so the credential still has an owner --
    // a profile that refused to delete is recoverable, an orphaned secret is
    // not findable.
    const store = fakeProfileStore([profile()]);
    const secrets = fakeSecretStore();
    await secrets.set('acme', 'CANARY-SECRET-ORPHAN-31c8');
    secrets.remove = () => Promise.reject(new Error('the credential store failed during delete'));
    const { deps, out } = commandDeps({ profileStore: store, secretStore: secrets });

    const code = await runProfileRemove(deps, 'acme', { yes: true });

    expect(code).not.toBe(0);
    expect(await store.get('acme')).not.toBeNull();
    expect(await secrets.get('acme')).toBe('CANARY-SECRET-ORPHAN-31c8');
    expect(out.join(' ')).toMatch(/leave a credential nothing references/i);
    expect(out.join(' ')).not.toContain('CANARY-SECRET-ORPHAN-31c8');
  });
});

describe('runProfileSetSecret', () => {
  it('fails for an unknown profile', async () => {
    const { deps } = commandDeps();
    expect(await runProfileSetSecret(deps, 'nope')).toBe(1);
  });

  it('rotates the secret for an existing profile', async () => {
    const secrets = fakeSecretStore();
    const { deps } = commandDeps({
      profileStore: fakeProfileStore([profile()]),
      secretStore: secrets,
      readSecret: () => Promise.resolve('new-secret'),
    });
    expect(await runProfileSetSecret(deps, 'acme')).toBe(0);
    expect(await secrets.get('acme')).toBe('new-secret');
  });
});

describe('runProfileValidate', () => {
  it('fails when no secret is stored', async () => {
    const { deps, out } = commandDeps({ profileStore: fakeProfileStore([profile()]) });
    expect(await runProfileValidate(deps, 'acme')).toBe(1);
    expect(out.some((l) => /FAIL.*secret/i.test(l))).toBe(true);
  });

  it('passes when the secret is present and the output root is writable', async () => {
    const secrets = fakeSecretStore();
    await secrets.set('acme', 'shhh');
    const { deps, out } = commandDeps({
      profileStore: fakeProfileStore([profile()]),
      secretStore: secrets,
    });
    expect(await runProfileValidate(deps, 'acme')).toBe(0);
    expect(out.some((l) => /never contact|does not contact/i.test(l))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Real end-to-end: buildProgram(), a real FileProfileStore (via
// openProfileStore()) rooted at a throwaway temp directory, a real
// OsSecretStore backed by an in-memory fake keyring, and real piped stdin
// (readSecretFromStdin against an actual Readable). This is what exercises
// the canary requirements: a secret must never land in a file, in the
// program's own output, or survive being rejected as an argv flag.
// ---------------------------------------------------------------------------

function fakeKeyring(): KeyringBackend {
  const store = new Map<string, string>();
  return {
    getPassword: (s, a) => Promise.resolve(store.get(`${s}:${a}`) ?? null),
    setPassword: (s, a, p) => {
      store.set(`${s}:${a}`, p);
      return Promise.resolve();
    },
    deletePassword: (s, a) => Promise.resolve(store.delete(`${s}:${a}`)),
  };
}

function pipedStdin(line: string): NodeJS.ReadableStream {
  return Readable.from([`${line}\n`]);
}

function capturingWritable(sink: string[]): NodeJS.WritableStream {
  return new Writable({
    write(chunk: Buffer, _enc, callback) {
      sink.push(chunk.toString('utf8'));
      callback();
    },
  });
}

let configRoot = '';

beforeEach(async () => {
  configRoot = await mkdtemp(join(tmpdir(), 'archivist-profile-cli-'));
});
afterEach(async () => {
  await rm(configRoot, { recursive: true, force: true });
});

async function listAllFileContents(dir: string): Promise<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return '';
  }
  const chunks: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      chunks.push(await listAllFileContents(full));
    } else {
      chunks.push(await readFile(full, 'utf8').catch(() => ''));
    }
  }
  return chunks.join('\n');
}

function realCliDeps(out: string[], stdin: NodeJS.ReadableStream, stdoutSink: string[]): CliDeps {
  const stdout = capturingWritable(stdoutSink);
  return {
    write: (line) => out.push(line),
    exit: () => undefined,
    doctor: () => Promise.reject(new Error('not used in this test')),
    capture: () => Promise.reject(new Error('not used in this test')),
    verifyBundle: () => Promise.reject(new Error('not used in this test')),
    documentBundle: () => Promise.reject(new Error('not used in this test')),
    profile: {
      write: (line) => out.push(line),
      profileStore: openProfileStore({ configRoot }),
      secretStore: new OsSecretStore(fakeKeyring()),
      readSecret: () => readSecretFromStdin(stdin, stdout, false),
      confirm: () => Promise.resolve(true),
      checkOutputRootWritable: () => Promise.resolve(true),
    },
  };
}

async function run(deps: CliDeps, argv: readonly string[]): Promise<void> {
  const program = buildProgram(deps);
  await program.parseAsync(['node', 'archivist', ...argv]);
}

describe('archivist profile (end-to-end)', () => {
  it('add reads a canary secret from piped stdin, and the canary appears in no output and no file', async () => {
    const canary = CANARIES[0]!;
    const out: string[] = [];
    const stdoutSink: string[] = [];
    const deps = realCliDeps(out, pipedStdin(canary), stdoutSink);

    await run(deps, [
      'profile',
      'add',
      '--id',
      'acme',
      '--display-name',
      'Acme',
      '--region',
      'mec1',
      '--org',
      'org_1',
      '--client-id',
      'client-1',
      '--output-root',
      '/work/out',
    ]);

    expect(scanForCanaries(out.join('\n'))).toEqual([]);
    expect(scanForCanaries(stdoutSink.join(''))).toEqual([]);
    const fileContents = await listAllFileContents(configRoot);
    expect(fileContents).not.toContain(canary);
  });

  it('add --client-secret <value> fails with the explanatory error and writes nothing', async () => {
    const out: string[] = [];
    const stdoutSink: string[] = [];
    const deps = realCliDeps(out, pipedStdin('irrelevant'), stdoutSink);

    await run(deps, [
      'profile',
      'add',
      '--id',
      'acme',
      '--display-name',
      'Acme',
      '--region',
      'mec1',
      '--org',
      'org_1',
      '--client-id',
      'client-1',
      '--output-root',
      '/work/out',
      '--client-secret',
      'hunter2',
    ]);

    expect(out.some((l) => /argv|stdin/i.test(l))).toBe(true);
    const profilesDir = join(configRoot, 'profiles');
    const entries = await readdir(profilesDir).catch(() => []);
    expect(entries).toEqual([]);
    expect(out.join('\n')).not.toContain('hunter2');
  });

  it('list output contains the display name and region but never the client id', async () => {
    const out: string[] = [];
    const addDeps = realCliDeps([], pipedStdin('some-secret'), []);
    await run(addDeps, [
      'profile',
      'add',
      '--id',
      'acme',
      '--display-name',
      'Acme Sandbox',
      '--region',
      'mec1',
      '--org',
      'org_1',
      '--client-id',
      'CLIENT-ID-SHOULD-NEVER-APPEAR',
      '--output-root',
      '/work/out',
    ]);

    const listDeps = realCliDeps(out, pipedStdin(''), []);
    await run(listDeps, ['profile', 'list']);

    const text = out.join('\n');
    expect(text).toContain('Acme Sandbox');
    expect(text).toContain('mec1');
    expect(text).not.toContain('CLIENT-ID-SHOULD-NEVER-APPEAR');
  });

  it('a corrupt profile file still appears in list output as unreadable', async () => {
    await mkdir(join(configRoot, 'profiles'), { recursive: true });
    await writeFile(join(configRoot, 'profiles', 'broken.json'), 'not json at all {{{', 'utf8');

    const out: string[] = [];
    const deps = realCliDeps(out, pipedStdin(''), []);
    await run(deps, ['profile', 'list']);

    const text = out.join('\n');
    expect(text).toContain('broken');
    expect(text).toMatch(/UNREADABLE/);
  });
});
