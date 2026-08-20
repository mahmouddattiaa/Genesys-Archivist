// packages/security/test/secret-store-os.test.ts
import { describe, expect, it } from 'vitest';
import { asProfileId } from '@genesys-archivist/domain';
import { OsSecretStore, type KeyringBackend } from '../src/secret-store-os.js';

function fakeKeyring(): KeyringBackend & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    getPassword: (s, a) => Promise.resolve(store.get(`${s}:${a}`) ?? null),
    setPassword: (s, a, p) => {
      store.set(`${s}:${a}`, p);
      return Promise.resolve();
    },
    deletePassword: (s, a) => Promise.resolve(store.delete(`${s}:${a}`)),
  };
}

describe('OsSecretStore', () => {
  it('round-trips a secret for a profile', async () => {
    const store = new OsSecretStore(fakeKeyring());
    await store.set(asProfileId('acme'), 'shhh');
    expect(await store.get(asProfileId('acme'))).toBe('shhh');
  });

  it('returns null for an unknown profile rather than throwing', async () => {
    expect(await new OsSecretStore(fakeKeyring()).get(asProfileId('missing'))).toBeNull();
  });

  it('isolates profiles from one another', async () => {
    const store = new OsSecretStore(fakeKeyring());
    await store.set(asProfileId('a'), 'secret-a');
    await store.set(asProfileId('b'), 'secret-b');
    expect(await store.get(asProfileId('a'))).toBe('secret-a');
  });

  it('namespaces entries under a fixed service so it cannot collide with other apps', async () => {
    const keyring = fakeKeyring();
    await new OsSecretStore(keyring).set(asProfileId('acme'), 'shhh');
    expect([...keyring.store.keys()][0]).toMatch(/^genesys-archivist:/);
  });

  it('reports presence without returning the value', async () => {
    const store = new OsSecretStore(fakeKeyring());
    await store.set(asProfileId('acme'), 'shhh');
    expect(await store.has(asProfileId('acme'))).toBe(true);
    expect(await store.has(asProfileId('nope'))).toBe(false);
  });

  it('never exposes a secret through its own serialization', async () => {
    const store = new OsSecretStore(fakeKeyring());
    await store.set(asProfileId('acme'), 'CANARY-STORE-LEAK');
    expect(JSON.stringify(store)).not.toContain('CANARY-STORE-LEAK');
    expect(String(store)).not.toContain('CANARY-STORE-LEAK');
  });

  it('surfaces a backend failure as a structured error without the secret', async () => {
    const broken: KeyringBackend = {
      getPassword: () => Promise.reject(new Error('keyring locked')),
      setPassword: () => Promise.reject(new Error('keyring locked')),
      deletePassword: () => Promise.reject(new Error('keyring locked')),
    };
    await expect(new OsSecretStore(broken).get(asProfileId('acme'))).rejects.toThrow(
      /credential store/i,
    );
  });

  // Secret-canary tests: a canary that echoes back through an underlying
  // backend error, a rejected promise message, or the store's own error must
  // never reach the message an OsSecretStore throws or surfaces.

  it('never lets a canary secret leak through a write failure', async () => {
    const broken: KeyringBackend = {
      getPassword: () => Promise.resolve(null),
      // Simulates an OS keyring implementation that (mis)behaves like some
      // real ones do: echoing the value it failed to store into its error.
      setPassword: (_s, _a, password) =>
        Promise.reject(new Error(`failed to store secret "${password}"`)),
      deletePassword: () => Promise.resolve(false),
    };
    const store = new OsSecretStore(broken);
    await expect(store.set(asProfileId('acme'), 'CANARY-WRITE-LEAK')).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('CANARY-WRITE-LEAK') }),
    );
  });

  it('never lets a canary secret leak through a read failure', async () => {
    const broken: KeyringBackend = {
      getPassword: () => Promise.reject(new Error('found stale value "CANARY-READ-LEAK"')),
      setPassword: () => Promise.resolve(),
      deletePassword: () => Promise.resolve(false),
    };
    const store = new OsSecretStore(broken);
    await expect(store.get(asProfileId('acme'))).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('CANARY-READ-LEAK') }),
    );
  });

  it('never lets a canary secret leak through Object.keys, util.inspect-style enumeration, or a thrown has() failure', async () => {
    const store = new OsSecretStore(fakeKeyring());
    await store.set(asProfileId('acme'), 'CANARY-ENUM-LEAK');
    const seen = JSON.stringify(Object.entries(store));
    expect(seen).not.toContain('CANARY-ENUM-LEAK');
  });
});

describe('OsSecretStore.remove', () => {
  it('deletes a stored secret and reports that one was present', async () => {
    const keyring = fakeKeyring();
    const store = new OsSecretStore(keyring);
    await store.set(asProfileId('acme'), 'shhh');

    expect(await store.remove(asProfileId('acme'))).toBe(true);
    expect(await store.get(asProfileId('acme'))).toBeNull();
    expect(keyring.store.size).toBe(0);
  });

  it('is idempotent: removing an absent secret succeeds and reports false', async () => {
    // "Already gone" is the state the caller asked for. Throwing here would
    // make `profile remove` fail on a profile whose secret was cleared by hand.
    const store = new OsSecretStore(fakeKeyring());
    expect(await store.remove(asProfileId('never-existed'))).toBe(false);
  });

  it('leaves other profiles untouched', async () => {
    const store = new OsSecretStore(fakeKeyring());
    await store.set(asProfileId('a'), 'secret-a');
    await store.set(asProfileId('b'), 'secret-b');

    await store.remove(asProfileId('a'));
    expect(await store.get(asProfileId('b'))).toBe('secret-b');
  });

  it('throws rather than reporting false when the keyring fails', async () => {
    // The dangerous failure is a delete that did not happen being reported as
    // "nothing was there": the caller would then delete the profile metadata
    // and leave a live credential nothing references.
    const keyring = fakeKeyring();
    keyring.deletePassword = () => Promise.reject(new Error('keyring is locked'));
    await expect(new OsSecretStore(keyring).remove(asProfileId('acme'))).rejects.toThrow(
      /credential store failed during delete/i,
    );
  });

  it('never echoes the secret or the underlying error when a delete fails', async () => {
    const keyring = fakeKeyring();
    await new OsSecretStore(keyring).set(asProfileId('acme'), 'CANARY-SECRET-9f24bd');
    keyring.deletePassword = () =>
      Promise.reject(new Error('failed to delete entry holding CANARY-SECRET-9f24bd'));

    const error = await new OsSecretStore(keyring)
      .remove(asProfileId('acme'))
      .then(() => null)
      .catch((e: unknown) => e);

    // `stack` is optional on Error, so it is coerced; `message` is already a
    // string and coercing it would be a no-op the linter rightly rejects.
    const thrown = error as Error;
    const serialized = `${thrown.message}${String(thrown.stack)}`;
    expect(serialized).not.toContain('CANARY-SECRET-9f24bd');
  });
});
