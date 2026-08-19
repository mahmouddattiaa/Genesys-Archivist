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
}
