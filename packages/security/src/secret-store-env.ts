// packages/security/src/secret-store-env.ts
import type { ProfileId } from '@genesys-archivist/domain';
import type { SecretStore } from './secret-store.js';

type Env = Readonly<Record<string, string | undefined>>;

const envKey = (profileId: string): string =>
  `ARCHIVIST_SECRET_${profileId.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;

/**
 * CI-only. On a developer machine the OS credential store is the supported
 * path; this class refuses to run unless CI is declared explicitly, so nobody
 * reaches for it because it was convenient.
 */
export class EnvSecretStore implements SecretStore {
  readonly #env: Env;

  constructor(env: Env = process.env) {
    this.#env = env;
  }

  #assertCi(): void {
    if (this.#env['ARCHIVIST_CI_SECRETS'] !== '1') {
      throw new Error(
        'EnvSecretStore requires ARCHIVIST_CI_SECRETS=1. Use the OS credential store on developer machines.',
      );
    }
  }

  // Deliberately `async`: the CI guard throws synchronously, and only an
  // `async` function turns that throw into a promise rejection rather than
  // letting it escape the call before the caller can attach `.catch`/`await`.
  // eslint-disable-next-line @typescript-eslint/require-await
  async get(profileId: ProfileId): Promise<string | null> {
    this.#assertCi();
    return this.#env[envKey(profileId)] ?? null;
  }

  set(): Promise<void> {
    return Promise.reject(new Error('EnvSecretStore is read-only. Provision secrets through CI.'));
  }

  async has(profileId: ProfileId): Promise<boolean> {
    return (await this.get(profileId)) !== null;
  }

  /**
   * Rejects, like `set`. This store reads a CI-provisioned environment and
   * cannot unset it.
   *
   * Returning `false` would be worse than failing: the caller would be told no
   * secret was present when in fact one is still there, and would go on to
   * delete the profile metadata that pointed at it.
   */
  remove(): Promise<boolean> {
    return Promise.reject(
      new Error('EnvSecretStore is read-only. Remove the secret through CI, not here.'),
    );
  }

  // Guarantees no secret escapes through an accidental log of the store itself.
  toJSON(): Record<string, string> {
    return { type: 'EnvSecretStore' };
  }

  toString(): string {
    return '[EnvSecretStore]';
  }
}
