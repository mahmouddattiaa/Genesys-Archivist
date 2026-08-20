// packages/security/src/secret-store.ts
import type { ProfileId } from '@genesys-archivist/domain';

/**
 * Resolves a profile secret at runtime. Implementations must never return a
 * secret to an MCP client, a log, or an error message.
 */
export interface SecretStore {
  get(profileId: ProfileId): Promise<string | null>;
  set(profileId: ProfileId, secret: string): Promise<void>;
  has(profileId: ProfileId): Promise<boolean>;
  /**
   * Deletes the stored secret. Resolves `true` if one was present.
   *
   * Idempotent: removing a secret that is not there is success, not an error,
   * because the caller's desired end state has been reached either way.
   *
   * This exists because deleting a profile without it leaves an **orphaned
   * credential** in the OS keyring that nothing references and no listing
   * shows -- a live secret with no owner, which is strictly worse than either
   * keeping the profile or deleting both.
   */
  remove(profileId: ProfileId): Promise<boolean>;
}
