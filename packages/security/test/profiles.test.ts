// packages/security/test/profiles.test.ts
import { describe, expect, it } from 'vitest';
import { asProfileId } from '@genesys-archivist/domain';
import { EnvSecretStore } from '../src/secret-store-env.js';
import { profileMetadataSchema } from '../src/profiles.js';

describe('ProfileMetadata', () => {
  it('accepts a well-formed profile', () => {
    const parsed = profileMetadataSchema.parse({
      profileId: 'acme-sandbox',
      displayName: 'Acme Sandbox',
      region: 'mec1',
      expectedOrganizationId: 'org_123',
      clientIdFingerprint: 'sha256:abc',
      outputRoot: '/work/out',
    });
    expect(parsed.profileId).toBe('acme-sandbox');
  });

  it('rejects any attempt to smuggle a secret into profile metadata', () => {
    expect(() =>
      profileMetadataSchema.parse({
        profileId: 'acme-sandbox',
        displayName: 'Acme Sandbox',
        region: 'mec1',
        expectedOrganizationId: 'org_123',
        clientIdFingerprint: 'sha256:abc',
        outputRoot: '/work/out',
        clientSecret: 'oops',
      }),
    ).toThrow();
  });

  it('rejects a profileId that could influence a filesystem path', () => {
    expect(() =>
      profileMetadataSchema.parse({
        profileId: '../../escape',
        displayName: 'x',
        region: 'mec1',
        expectedOrganizationId: 'org_123',
        clientIdFingerprint: 'sha256:abc',
        outputRoot: '/work/out',
      }),
    ).toThrow();
  });
});

describe('EnvSecretStore', () => {
  it('refuses to operate outside CI', async () => {
    const store = new EnvSecretStore({ ARCHIVIST_CI_SECRETS: undefined });
    await expect(store.get(asProfileId('acme-sandbox'))).rejects.toThrow(/CI/);
  });

  it('reads the per-profile variable when CI is declared', async () => {
    const store = new EnvSecretStore({
      ARCHIVIST_CI_SECRETS: '1',
      ARCHIVIST_SECRET_ACME_SANDBOX: 'shhh',
    });
    expect(await store.get(asProfileId('acme-sandbox'))).toBe('shhh');
  });

  it('returns null rather than throwing when the profile has no secret', async () => {
    const store = new EnvSecretStore({ ARCHIVIST_CI_SECRETS: '1' });
    expect(await store.get(asProfileId('missing'))).toBeNull();
  });

  it('never includes the secret in its string representation', () => {
    const store = new EnvSecretStore({ ARCHIVIST_CI_SECRETS: '1', ARCHIVIST_SECRET_X: 'shhh' });
    expect(JSON.stringify(store)).not.toContain('shhh');
    expect(String(store)).not.toContain('shhh');
  });
});
