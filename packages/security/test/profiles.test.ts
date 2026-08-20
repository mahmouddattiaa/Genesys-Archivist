// packages/security/test/profiles.test.ts
import { describe, expect, it } from 'vitest';
import { asProfileId } from '@genesys-archivist/domain';
import { EnvSecretStore } from '../src/secret-store-env.js';
import { profileMetadataSchema, toSafeProfileSummary } from '../src/profiles.js';

describe('ProfileMetadata', () => {
  it('accepts a well-formed profile', () => {
    const parsed = profileMetadataSchema.parse({
      profileId: 'acme-sandbox',
      displayName: 'Acme Sandbox',
      region: 'mec1',
      expectedOrganizationId: 'org_123',
      clientId: 'a1b2c3d4-0000-4000-a000-000000000001',
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
        clientId: 'a1b2c3d4-0000-4000-a000-000000000001',
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
        clientId: 'a1b2c3d4-0000-4000-a000-000000000001',
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

describe('toSafeProfileSummary', () => {
  const profile = profileMetadataSchema.parse({
    profileId: 'acme',
    displayName: 'Acme Bank',
    region: 'eu_west_1',
    expectedOrganizationId: 'org_123',
    clientId: 'a1b2c3d4-0000-4000-a000-000000000001',
    outputRoot: '/work/acme',
  });

  it('omits the client ID, which docs/03 forbids MCP tools from returning', () => {
    const summary = toSafeProfileSummary(profile, true);
    expect(JSON.stringify(summary)).not.toContain('a1b2c3d4');
    expect('clientId' in summary).toBe(false);
  });

  it('keeps the fields an operator needs to identify a profile', () => {
    const summary = toSafeProfileSummary(profile, true);
    expect(summary.profileId).toBe('acme');
    expect(summary.region).toBe('eu_west_1');
    expect(summary.expectedOrganizationId).toBe('org_123');
  });

  it('reports secret presence without exposing the secret', () => {
    expect(toSafeProfileSummary(profile, true).secretPresent).toBe(true);
    expect(toSafeProfileSummary(profile, false).secretPresent).toBe(false);
  });

  it('normalises a missing validation timestamp to null', () => {
    expect(toSafeProfileSummary(profile, true).lastValidatedAt).toBeNull();
  });

  it('stores the client ID so authentication is actually possible', () => {
    // The regression this guards: an earlier revision stored only a hash, so a
    // profile carried no way to authenticate at all.
    expect(profile.clientId).toBe('a1b2c3d4-0000-4000-a000-000000000001');
  });
});
