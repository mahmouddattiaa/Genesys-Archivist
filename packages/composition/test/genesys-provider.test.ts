// packages/composition/test/genesys-provider.test.ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asProfileId, type ProfileId } from '@genesys-archivist/domain';
import type { FetchLike } from '@genesys-archivist/genesys-platform';
import type { SecretStore } from '@genesys-archivist/security';
import { openProfileStore } from '../src/profiles.js';
import { createGenesysProvider } from '../src/genesys-provider.js';

class InMemorySecretStore implements SecretStore {
  readonly #secrets = new Map<string, string>();
  set(profileId: ProfileId, secret: string): Promise<void> {
    this.#secrets.set(profileId, secret);
    return Promise.resolve();
  }
  get(profileId: ProfileId): Promise<string | null> {
    return Promise.resolve(this.#secrets.get(profileId) ?? null);
  }
  has(profileId: ProfileId): Promise<boolean> {
    return Promise.resolve(this.#secrets.has(profileId));
  }
  remove(profileId: ProfileId): Promise<boolean> {
    return Promise.resolve(this.#secrets.delete(profileId));
  }
}

const created: string[] = [];
async function freshConfigRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'archivist-genesys-provider-'));
  created.push(dir);
  return dir;
}

beforeEach(() => {
  created.length = 0;
});
afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const CANARY_SECRET = 'CANARY-GENESYS-PROVIDER-SECRET-7a1c';

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function buildFakeFetch(): FetchLike {
  return (input) => {
    const url = new URL(input);
    if (url.pathname === '/oauth/token')
      return Promise.resolve(json({ access_token: 'a-token', expires_in: 3600 }));
    if (url.pathname === '/api/v2/organizations/me') {
      return Promise.resolve(json({ id: 'org-real-1', name: 'Real Org' }));
    }
    return Promise.reject(new Error(`genesys-provider test: no route for ${input}`));
  };
}

describe('createGenesysProvider', () => {
  it('resolves a real provider for a configured profile with a stored secret', async () => {
    const configRoot = await freshConfigRoot();
    const profileStore = openProfileStore({ configRoot });
    await profileStore.put({
      profileId: 'sandbox-a',
      displayName: 'Sandbox A',
      region: 'eu_west_1',
      expectedOrganizationId: 'org-real-1',
      clientId: 'not-a-secret-client-id',
      outputRoot: join(configRoot, 'out'),
      lastValidatedAt: null,
    });
    const secretStore = new InMemorySecretStore();
    await secretStore.set(asProfileId('sandbox-a'), CANARY_SECRET);

    const provider = await createGenesysProvider({
      profileId: asProfileId('sandbox-a'),
      configRoot,
      secretStore,
      fetch: buildFakeFetch(),
      now: () => new Date('2026-08-20T12:00:00Z'),
    });

    const identity = await provider.validateConnection();
    expect(identity.organizationId).toBe('org-real-1');
  });

  it('rejects, naming the profile id, when no profile is configured', async () => {
    const configRoot = await freshConfigRoot();
    const secretStore = new InMemorySecretStore();

    await expect(
      createGenesysProvider({
        profileId: asProfileId('never-configured'),
        configRoot,
        secretStore,
        fetch: buildFakeFetch(),
      }),
    ).rejects.toThrow(/never-configured/);
  });

  it('rejects, never naming the secret, when the profile has no stored credential', async () => {
    const configRoot = await freshConfigRoot();
    const profileStore = openProfileStore({ configRoot });
    await profileStore.put({
      profileId: 'sandbox-no-secret',
      displayName: 'No Secret',
      region: 'eu_west_1',
      expectedOrganizationId: 'org-real-1',
      clientId: 'not-a-secret-client-id',
      outputRoot: join(configRoot, 'out'),
      lastValidatedAt: null,
    });
    const secretStore = new InMemorySecretStore(); // nothing stored for this profile.

    let message = '';
    try {
      await createGenesysProvider({
        profileId: asProfileId('sandbox-no-secret'),
        configRoot,
        secretStore,
        fetch: buildFakeFetch(),
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('sandbox-no-secret');
    expect(message).not.toContain(CANARY_SECRET);
  });
});
