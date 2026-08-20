// packages/security/src/secret-store-os.ts
import { Entry } from '@napi-rs/keyring';
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

  // Guarantees no secret escapes through an accidental log or console.log of
  // the store itself. Non-enumerable would be redundant here: the backend
  // and service name are the only fields, and neither ever holds a secret,
  // but the override still means a future field added to this class cannot
  // leak through default serialization by accident.
  toJSON(): Record<string, string> {
    return { type: 'OsSecretStore', service: this.#service };
  }

  toString(): string {
    return '[OsSecretStore]';
  }
}

/**
 * Wires the real OS credential store as a `KeyringBackend`.
 *
 * `@napi-rs/keyring` was chosen over shelling out to platform CLIs (see
 * docs/adr/ADR-017-credential-store.md): it ships prebuilt native binaries
 * for Windows, macOS, and Linux, so `npm install` needs no compiler
 * toolchain. `Entry` is its primary, synchronous API; each call wraps a
 * fresh `Entry` in an `async` function so a synchronous throw from the
 * native binding — locked keyring, missing entry, ambiguous credential —
 * becomes a rejected promise rather than escaping past the `await` in
 * `OsSecretStore`, which is what turns it into a `CredentialStoreError`.
 */
function createKeyringBackend(): KeyringBackend {
  return {
    // eslint-disable-next-line @typescript-eslint/require-await -- see comment above: async is load-bearing for sync-throw safety, not for awaiting anything.
    async getPassword(service, account) {
      return new Entry(service, account).getPassword();
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async setPassword(service, account, password) {
      new Entry(service, account).setPassword(password);
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async deletePassword(service, account) {
      return new Entry(service, account).deletePassword();
    },
  };
}

/** Wires `OsSecretStore` to the real OS credential store. */
export function createOsSecretStore(): OsSecretStore {
  return new OsSecretStore(createKeyringBackend());
}
