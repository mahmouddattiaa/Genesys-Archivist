// packages/composition/src/profiles.ts
//
// Wiring for profile persistence and secret resolution. Neither
// `@genesys-archivist/storage` nor `@genesys-archivist/security` may depend on
// each other's adapters -- `FileProfileStore` lives in storage precisely so
// security never has to import storage (see profile-store.ts's own comment)
// -- so this is the one place that decides *which* concrete `SecretStore`
// backs a real run and *where* `FileProfileStore` reads and writes.
import { asProfileId } from '@genesys-archivist/domain';
import {
  createOsSecretStore,
  defaultConfigRoot,
  EnvSecretStore,
  type SecretStore,
} from '@genesys-archivist/security';
import { FileProfileStore, type ProfileStore } from '@genesys-archivist/storage';

export interface OpenProfileStoreOptions {
  /** Defaults to `defaultConfigRoot()` (per-user, OS-appropriate). Overridable
   * for tests and for a future `--config-root` escape hatch. */
  readonly configRoot?: string;
}

/** Opens the on-disk profile metadata store. Never touches a secret. */
export function openProfileStore(options: OpenProfileStoreOptions = {}): ProfileStore {
  return new FileProfileStore(options.configRoot ?? defaultConfigRoot());
}

export interface ResolveSecretStoreOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * Skips the keyring probe and picks one store outright. Exists for a
   * caller that already knows better -- `doctor` just probed the keyring
   * itself for its own report and would otherwise pay for a second, redundant
   * probe here -- and for an explicit operator override.
   */
  readonly forceStore?: 'os' | 'env';
  /** Injected so this can be unit-tested without a real keyring daemon. */
  readonly createOsStore?: () => SecretStore;
  readonly probeOsStore?: (store: SecretStore) => Promise<boolean>;
}

// .has() on a profile id that (almost certainly) has no stored secret never
// reads real credential material -- a miss returns false -- but it still
// exercises the same call path a real lookup would, which is what makes it a
// meaningful probe rather than a no-op. Mirrors
// apps/cli/src/commands/../bin.ts's own probeSecretStore.
const PROBE_PROFILE_ID = asProfileId('archivist-keyring-probe');

async function defaultProbe(store: SecretStore): Promise<boolean> {
  try {
    await store.has(PROBE_PROFILE_ID);
    return true;
  } catch {
    return false;
  }
}

/**
 * Picks the OS keyring store by default and falls back to `EnvSecretStore`
 * when the keyring is unreachable or when the caller forces it, per
 * ADR-017: `EnvSecretStore` exists specifically for the Linux CI runner that
 * has no keyring daemon at all, guarded so it still refuses to run anywhere
 * `ARCHIVIST_CI_SECRETS=1` is not declared. A developer machine with a
 * working keyring never falls through to it.
 */
export async function resolveSecretStore(
  options: ResolveSecretStoreOptions = {},
): Promise<SecretStore> {
  const env = options.env ?? process.env;
  const createOsStore = options.createOsStore ?? createOsSecretStore;

  if (options.forceStore === 'env') return new EnvSecretStore(env);
  if (options.forceStore === 'os') return createOsStore();

  const osStore = createOsStore();
  const probe = options.probeOsStore ?? defaultProbe;
  if (await probe(osStore)) return osStore;

  return new EnvSecretStore(env);
}
