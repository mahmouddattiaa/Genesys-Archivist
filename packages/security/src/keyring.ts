// packages/security/src/keyring.ts
/**
 * The seam over the OS credential store. Injected rather than imported
 * directly so the secret store is unit-testable without a keyring daemon —
 * Linux CI runners have none.
 */
export interface KeyringBackend {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
}
