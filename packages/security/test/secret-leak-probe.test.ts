import { describe, expect, it } from 'vitest';
import { asProfileId } from '@genesys-archivist/domain';
import { OsSecretStore, type KeyringBackend } from '../src/index.js';

/**
 * An adversarial sweep over the credential path.
 *
 * The per-feature tests check the leak paths their author thought of. This
 * asks the opposite question: given a hostile backend that tries every trick
 * to get the secret back out, does it ever surface? A canary that only proves
 * `JSON.stringify(store)` is clean proves very little — the interesting leaks
 * are through thrown errors, promise rejections, and whatever a logger would
 * actually call on the object.
 */
const CANARY = 'CANARY-b7f3c1d9e5a24680-DO-NOT-LEAK';

/** A backend that echoes whatever it is given into every failure path. */
const hostileBackend = (): KeyringBackend => ({
  getPassword: () => Promise.reject(new Error(`read failed for secret ${CANARY}`)),
  setPassword: (_service: string, _account: string, password: string) =>
    Promise.reject(new Error(`write failed, value was ${password}`)),
  deletePassword: () => Promise.reject(new Error(`delete failed ${CANARY}`)),
});

/** A backend that succeeds and hands the secret straight back. */
const echoBackend = (): KeyringBackend => {
  const held = new Map<string, string>();
  return {
    getPassword: (service: string, account: string) =>
      Promise.resolve(held.get(`${service}/${account}`) ?? null),
    setPassword: (service: string, account: string, password: string) => {
      held.set(`${service}/${account}`, password);
      return Promise.resolve();
    },
    deletePassword: (service: string, account: string) => {
      held.delete(`${service}/${account}`);
      return Promise.resolve(true);
    },
  };
};

/** Every representation something might reach for when logging an object. */
function representations(value: unknown): string[] {
  const out: string[] = [];
  const push = (fn: () => unknown) => {
    try {
      out.push(String(fn()));
    } catch {
      out.push('');
    }
  };
  push(() => JSON.stringify(value));
  push(() => String(value));
  push(() => Object.entries(value as object).map(([k, v]) => `${k}=${String(v)}`));
  push(() => Object.getOwnPropertyNames(value).join(','));
  push(() => Object.keys(value as object).join(','));
  push(() => util_inspect_like(value));
  return out;
}

/** Approximates what a console/logger would render without importing node:util. */
function util_inspect_like(value: unknown): string {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): string => {
    if (typeof v !== 'object' || v === null) return String(v);
    if (seen.has(v)) return '[circular]';
    seen.add(v);
    const parts: string[] = [];
    for (const key of Object.getOwnPropertyNames(v)) {
      const descriptor = Object.getOwnPropertyDescriptor(v, key);
      parts.push(`${key}:${descriptor?.value === undefined ? '' : walk(descriptor.value)}`);
    }
    if (v instanceof Error) parts.push(v.message, v.stack ?? '');
    return parts.join('|');
  };
  return walk(value);
}

const containsCanary = (parts: readonly string[]): boolean => parts.some((p) => p.includes(CANARY));

describe('adversarial secret-leak probe', () => {
  it('the store itself never renders the secret, by any representation', async () => {
    const store = new OsSecretStore(echoBackend(), 'archivist-test');
    await store.set(asProfileId('profile-1'), CANARY);
    expect(containsCanary(representations(store))).toBe(false);
  });

  it('a backend that echoes the secret into a write error does not leak it', async () => {
    const store = new OsSecretStore(hostileBackend(), 'archivist-test');
    let thrown: unknown;
    try {
      await store.set(asProfileId('profile-1'), CANARY);
    } catch (error) {
      thrown = error;
    }
    expect(thrown, 'the hostile backend should have caused a failure').toBeDefined();
    expect(containsCanary(representations(thrown))).toBe(false);
  });

  it('a backend that echoes the secret into a read error does not leak it', async () => {
    const store = new OsSecretStore(hostileBackend(), 'archivist-test');
    let thrown: unknown;
    try {
      await store.get(asProfileId('profile-1'));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
    expect(containsCanary(representations(thrown))).toBe(false);
  });

  it('a synchronous throw from a native binding does not escape as a raw error', async () => {
    // The native keyring binding can throw synchronously rather than
    // rejecting. If that escapes past the store's own error handling, it
    // carries whatever the binding chose to put in the message.
    const throwingBackend: KeyringBackend = {
      getPassword: () => {
        throw new Error(`native blew up holding ${CANARY}`);
      },
      setPassword: () => {
        throw new Error(`native blew up holding ${CANARY}`);
      },
      deletePassword: () => {
        throw new Error(`native blew up holding ${CANARY}`);
      },
    };
    const store = new OsSecretStore(throwingBackend, 'archivist-test');
    let thrown: unknown;
    try {
      await store.set(asProfileId('profile-1'), CANARY);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
    expect(containsCanary(representations(thrown))).toBe(false);
  });

  it('a retrieved secret is returned to the caller and nowhere else', async () => {
    const store = new OsSecretStore(echoBackend(), 'archivist-test');
    await store.set(asProfileId('profile-1'), CANARY);
    const got = await store.get(asProfileId('profile-1'));
    // It must actually come back — a store that leaks nothing because it
    // stores nothing would pass every test above.
    expect(got).toBe(CANARY);
    expect(containsCanary(representations(store))).toBe(false);
  });
});
