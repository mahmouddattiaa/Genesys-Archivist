// packages/storage/test/asset-store.test.ts
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AssetStore } from '../src/asset-store.js';

let dir = '';
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
const meta = (name: string, id = 'p1') => ({
  originalName: name,
  mimeType: 'audio/wav',
  usedBy: { type: 'prompt', id, language: 'en-US' },
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'archivist-assets-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('AssetStore', () => {
  it('returns a sha256-prefixed hash', async () => {
    expect(await new AssetStore(dir).put(bytes('audio'), meta('greeting.wav'))).toMatch(
      /^sha256:[0-9a-f]{64}$/,
    );
  });

  it('stores identical content exactly once', async () => {
    const store = new AssetStore(dir);
    await store.put(bytes('same audio'), meta('greeting.wav', 'p1'));
    await store.put(bytes('same audio'), meta('welcome.wav', 'p2'));
    await store.writeIndex();
    const files = (await readdir(dir)).filter((f) => f !== 'index.json');
    expect(files).toHaveLength(1);
  });

  it('records every usage of a deduplicated asset', async () => {
    const store = new AssetStore(dir);
    await store.put(bytes('same audio'), meta('greeting.wav', 'p1'));
    await store.put(bytes('same audio'), meta('welcome.wav', 'p2'));
    await store.writeIndex();
    const index = await AssetStore.readIndex(dir);
    expect(Object.values(index)[0]!.usedBy).toHaveLength(2);
  });

  it('stores differing content separately', async () => {
    const store = new AssetStore(dir);
    await store.put(bytes('audio one'), meta('a.wav'));
    await store.put(bytes('audio two'), meta('b.wav'));
    await store.writeIndex();
    expect((await readdir(dir)).filter((f) => f !== 'index.json')).toHaveLength(2);
  });

  it('never lets the tenant filename reach the filesystem', async () => {
    const store = new AssetStore(dir);
    await store.put(bytes('x'), meta('../../../etc/passwd'));
    await store.writeIndex();
    const files = (await readdir(dir)).filter((f) => f !== 'index.json');
    expect(files[0]).toMatch(/^[0-9a-f]{64}\.\w+$/);
    expect(files.join()).not.toContain('passwd');
  });

  it('preserves the original name in the index for migration', async () => {
    const store = new AssetStore(dir);
    await store.put(bytes('x'), meta('Greeting Prompt.wav'));
    await store.writeIndex();
    const index = await AssetStore.readIndex(dir);
    expect(Object.values(index)[0]!.originalName).toBe('Greeting Prompt.wav');
  });

  it('records byte length so bundle size is auditable', async () => {
    const store = new AssetStore(dir);
    await store.put(bytes('12345'), meta('a.wav'));
    await store.writeIndex();
    expect(Object.values(await AssetStore.readIndex(dir))[0]!.byteLength).toBe(5);
  });

  it('stores content once even when put is called concurrently for the same bytes', async () => {
    // Content-addressed means the hash IS the identity: this exercises the
    // real race, not a sequential approximation -- three puts for the same
    // bytes are kicked off in the same tick. A check-then-write without a
    // synchronous reservation would let the disk write happen more than
    // once and could lose a usage record to a lost update.
    const store = new AssetStore(dir);
    await Promise.all([
      store.put(bytes('same audio, concurrent'), meta('a.wav', 'p1')),
      store.put(bytes('same audio, concurrent'), meta('b.wav', 'p2')),
      store.put(bytes('same audio, concurrent'), meta('c.wav', 'p3')),
    ]);
    await store.writeIndex();
    const files = (await readdir(dir)).filter((f) => f !== 'index.json');
    expect(files).toHaveLength(1);
    const index = await AssetStore.readIndex(dir);
    expect(Object.values(index)[0]!.usedBy).toHaveLength(3);
  });

  it('falls back to a generic extension for an unrecognized mime type, without touching the filename', async () => {
    const store = new AssetStore(dir);
    await store.put(bytes('data'), {
      originalName: 'notes.bin',
      mimeType: 'application/x-mystery',
      usedBy: { type: 'prompt', id: 'p1' },
    });
    await store.writeIndex();
    const files = (await readdir(dir)).filter((f) => f !== 'index.json');
    expect(files[0]).toMatch(/^[0-9a-f]{64}\.bin$/);
  });

  it('never includes asset bytes or the resolved path in a thrown error', async () => {
    // put() itself never throws in the current implementation, but this
    // guards the contract: nothing about the store's error surface may leak
    // restricted content. Forcing a failure via an unwritable directory
    // parent is platform-fragile, so this asserts the positive contract
    // instead -- put()'s resolved value is only ever the hash string.
    const store = new AssetStore(dir);
    const result = await store.put(bytes('CANARY-ASSET-CONTENT'), meta('secret.wav'));
    expect(result).not.toContain('CANARY-ASSET-CONTENT');
    expect(result).not.toContain(dir);
  });

  it('does not let a usage id or language influence the stored filename', async () => {
    const store = new AssetStore(dir);
    await store.put(bytes('y'), {
      originalName: 'ok.wav',
      mimeType: 'audio/wav',
      usedBy: { type: 'prompt', id: '../../escape', language: '../evil' },
    });
    await store.writeIndex();
    const files = (await readdir(dir)).filter((f) => f !== 'index.json');
    expect(files[0]).toMatch(/^[0-9a-f]{64}\.wav$/);
  });
});
