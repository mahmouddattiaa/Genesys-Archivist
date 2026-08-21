// apps/cli/test/profile-narration-key.test.ts
//
// `archivist profile set-narration-key <id>` -- the sibling command to
// `set-secret` that stores the AI narration provider's API key. Same rule
// as every other credential this CLI handles: read from stdin or a hidden
// prompt, never argv, and stored under a *derived* SecretStore key so it
// never collides with the profile's own Genesys client secret (one secret
// per SecretStore key).
import { describe, expect, it } from 'vitest';
import { CANARIES, scanForCanaries } from '@genesys-archivist/testing';
import { profileMetadataSchema } from '@genesys-archivist/security';
import {
  narrationSecretProfileId,
  parseProfileArgs,
  runProfileRemove,
  runProfileSetNarrationKey,
  type ProfileCommandDeps,
  type ProfileStoreLike,
} from '../src/commands/profile.js';

function profile(overrides: Partial<Record<string, unknown>> = {}) {
  return profileMetadataSchema.parse({
    profileId: 'acme',
    displayName: 'Acme Bank',
    region: 'mec1',
    expectedOrganizationId: 'org_1',
    clientId: 'client-1',
    outputRoot: '/work/out',
    ...overrides,
  });
}

function fakeProfileStore(initial: ReturnType<typeof profile>[] = []): ProfileStoreLike {
  const byId = new Map(initial.map((p) => [p.profileId, p]));
  return {
    list: () => Promise.resolve({ profiles: [...byId.values()], unreadable: [] }),
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

// The intersection with the plain-`string`-keyed shape lets this test call
// `secrets.get('acme')` directly with a bare string, exactly as
// apps/cli/test/profile-command.test.ts's own `fakeSecretStore` does --
// `SecretStore`'s real methods take the branded `ProfileId`, but a test
// double backed by a plain `Map<string, string>` has no need for the brand
// itself, only for something that satisfies `ProfileCommandDeps['secretStore']`
// structurally.
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
    readSecret: () => Promise.resolve('a-narration-key'),
    confirm: () => Promise.resolve(true),
    checkOutputRootWritable: () => Promise.resolve(true),
    ...overrides,
  };
  return { deps, out };
}

describe('parseProfileArgs: set-narration-key', () => {
  it('parses set-narration-key <id>', () => {
    expect(parseProfileArgs(['set-narration-key', 'acme'])).toEqual({
      kind: 'set-narration-key',
      profileId: 'acme',
    });
  });

  it('rejects --client-secret on set-narration-key too', () => {
    const result = parseProfileArgs(['set-narration-key', 'acme', '--client-secret', 'hunter2']);
    expect(result.kind).toBe('error');
    expect(result.kind === 'error' && result.message).toMatch(/argv|stdin/i);
  });

  it('rejects set-narration-key without an id', () => {
    expect(parseProfileArgs(['set-narration-key']).kind).toBe('error');
  });
});

describe('narrationSecretProfileId', () => {
  it('derives a distinct SecretStore key from the capture profile id', () => {
    const derived = narrationSecretProfileId('acme');
    expect(String(derived)).not.toBe('acme');
    expect(String(derived)).toContain('acme');
  });
});

describe('runProfileSetNarrationKey', () => {
  it('fails for an unknown profile', async () => {
    const { deps } = commandDeps();
    expect(await runProfileSetNarrationKey(deps, 'nope')).toBe(1);
  });

  it('stores the key under a key distinct from the profile’s own Genesys secret', async () => {
    const secrets = fakeSecretStore();
    await secrets.set('acme', 'GENESYS-CLIENT-SECRET');
    const { deps } = commandDeps({
      profileStore: fakeProfileStore([profile()]),
      secretStore: secrets,
      readSecret: () => Promise.resolve('sk-anthropic-key'),
    });

    expect(await runProfileSetNarrationKey(deps, 'acme')).toBe(0);

    // The Genesys secret is untouched.
    expect(await secrets.get('acme')).toBe('GENESYS-CLIENT-SECRET');
    // The narration key lives under its own, derived key.
    const narrationKey = String(narrationSecretProfileId('acme'));
    expect(await secrets.get(narrationKey)).toBe('sk-anthropic-key');
  });

  it('rejects an empty key without writing anything', async () => {
    const secrets = fakeSecretStore();
    const { deps } = commandDeps({
      profileStore: fakeProfileStore([profile()]),
      secretStore: secrets,
      readSecret: () => Promise.resolve('   '),
    });
    expect(await runProfileSetNarrationKey(deps, 'acme')).toBe(1);
    expect(await secrets.get(String(narrationSecretProfileId('acme')))).toBeNull();
  });

  it('a canary narration key never appears in program output', async () => {
    const canary = CANARIES[0]!;
    const secrets = fakeSecretStore();
    const { deps, out } = commandDeps({
      profileStore: fakeProfileStore([profile()]),
      secretStore: secrets,
      readSecret: () => Promise.resolve(canary),
    });
    await runProfileSetNarrationKey(deps, 'acme');
    expect(scanForCanaries(out.join('\n'))).toEqual([]);
  });
});

describe('runProfileRemove: narration key cleanup', () => {
  it('also removes a stored narration key, leaving no orphaned credential', async () => {
    const store = fakeProfileStore([profile()]);
    const secrets = fakeSecretStore();
    await secrets.set('acme', 'GENESYS-CLIENT-SECRET');
    await secrets.set(String(narrationSecretProfileId('acme')), 'sk-anthropic-key');
    const { deps } = commandDeps({ profileStore: store, secretStore: secrets });

    await runProfileRemove(deps, 'acme', { yes: true });

    expect(await secrets.get('acme')).toBeNull();
    expect(await secrets.get(String(narrationSecretProfileId('acme')))).toBeNull();
  });

  it('does not fail profile removal if there was never a narration key to remove', async () => {
    const store = fakeProfileStore([profile()]);
    const secrets = fakeSecretStore();
    await secrets.set('acme', 'GENESYS-CLIENT-SECRET');
    const { deps } = commandDeps({ profileStore: store, secretStore: secrets });

    const code = await runProfileRemove(deps, 'acme', { yes: true });
    expect(code).toBe(0);
  });
});
