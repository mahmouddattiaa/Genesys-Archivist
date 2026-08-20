// packages/composition/src/genesys-provider.ts
//
// Resolves a real `GenesysSourceProvider` for one profile.
//
// This is composition's job because it is exactly the adapter-selection
// decision this package exists to own in one place (see profiles.ts's
// identical reasoning for `openProfileStore`/`resolveSecretStore`):
// deciding that the Platform API adapter (`createPlatformSourceProvider`,
// `@genesys-archivist/genesys-source`) is the concrete provider a profile
// resolves to, and wiring its region and client id from stored profile
// metadata and its credential from the secret store, at the moment of use.
//
// Nothing here ever holds a secret value. `resolveSecretStore()` /
// `options.secretStore` returns a `SecretStore` -- the store, not the
// secret -- and `createPlatformSourceProvider` itself only reads a token out
// of it lazily, when a request is actually about to be sent. Neither this
// function's parameters nor its return value can carry a secret string, by
// construction: there is no field for one.
import { asProfileId, type GenesysSourceProvider, type ProfileId } from '@genesys-archivist/domain';
import { createPlatformSourceProvider } from '@genesys-archivist/genesys-source';
import type { FetchLike, SleepLike } from '@genesys-archivist/genesys-platform';
import type { SecretStore } from '@genesys-archivist/security';
import type { Logger } from '@genesys-archivist/observability';
import { openProfileStore, resolveSecretStore, type OpenProfileStoreOptions } from './profiles.js';

export interface CreateGenesysProviderOptions extends OpenProfileStoreOptions {
  readonly profileId: ProfileId;
  /** Defaults to `globalThis.fetch`. Overridable so a test never needs a
   * real socket -- the same seam `@genesys-archivist/genesys-platform`
   * itself is built around. */
  readonly fetch?: FetchLike;
  readonly now?: () => Date;
  readonly sleep?: SleepLike;
  readonly logger?: Logger;
  /** Overrides the store `resolveSecretStore()` would otherwise pick. Tests
   * supply an in-memory fake; a real caller normally leaves this unset. */
  readonly secretStore?: SecretStore;
}

function defaultFetch(): FetchLike {
  return (input, init) => globalThis.fetch(input, init);
}

/**
 * Resolves the profile named by `options.profileId` and returns a real,
 * read-only `GenesysSourceProvider` for it.
 *
 * Rejects with a message naming the profile id -- never the secret, and
 * never the underlying credential-store error, which
 * `@genesys-archivist/security`'s own `CredentialStoreError` already takes
 * care to keep content-free -- if the profile does not exist or has no
 * stored credential. This is the injection point
 * `packages/composition/src/archivist-port.ts`'s `deps.providerFor` expects
 * (`(profileId) => Promise<GenesysSourceProvider>`); a caller wires it as
 * `providerFor: (profileId) => createGenesysProvider({ profileId, ...fixed
 * options })`.
 */
export async function createGenesysProvider(
  options: CreateGenesysProviderOptions,
): Promise<GenesysSourceProvider> {
  const profileStore = openProfileStore(options);
  const profile = await profileStore.get(options.profileId);
  if (profile === null) {
    throw new Error(
      `No profile named "${options.profileId}" is configured. Run: archivist profile add`,
    );
  }
  const profileId = asProfileId(profile.profileId);

  const secretStore = options.secretStore ?? (await resolveSecretStore());
  const hasSecret = await secretStore.has(profileId);
  if (!hasSecret) {
    throw new Error(
      `Profile "${profile.profileId}" has no stored credential. Run: archivist profile add`,
    );
  }

  return createPlatformSourceProvider({
    region: profile.region,
    clientId: profile.clientId,
    secretStore,
    profileId,
    fetch: options.fetch ?? defaultFetch(),
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  });
}
