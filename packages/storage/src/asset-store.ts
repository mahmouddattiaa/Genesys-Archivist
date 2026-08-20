// packages/storage/src/asset-store.ts
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface AssetUsage {
  readonly type: string;
  readonly id: string;
  readonly language?: string;
}

export interface AssetMeta {
  readonly originalName: string;
  readonly mimeType: string;
  readonly usedBy: AssetUsage;
}

export interface AssetIndexEntry {
  readonly originalName: string;
  readonly mimeType: string;
  readonly byteLength: number;
  readonly usedBy: readonly AssetUsage[];
}

export type AssetIndex = Record<string, AssetIndexEntry>;

const EXTENSIONS: Record<string, string> = {
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'application/pdf': 'pdf',
};

interface StoredAsset {
  readonly originalName: string;
  readonly mimeType: string;
  readonly byteLength: number;
  readonly usages: AssetUsage[];
  readonly written: Promise<void>;
}

/**
 * Content-addressed binary store with deduplication.
 *
 * The stored filename is derived entirely from the SHA-256 digest of the
 * bytes plus an extension picked from the declared mime type -- never from
 * `meta.originalName`. That is a deliberate design choice, not an omitted
 * validation step: it removes filename-driven path traversal by
 * construction, the same way `safeSegment` does for tenant-influenced path
 * segments elsewhere, without needing to call it here at all. The tenant
 * name survives only as a string value inside `index.json`.
 */
export class AssetStore {
  readonly #dir: string;
  readonly #assets = new Map<string, StoredAsset>();

  constructor(dir: string) {
    this.#dir = dir;
  }

  async put(bytes: Uint8Array, meta: AssetMeta): Promise<string> {
    const digest = createHash('sha256').update(bytes).digest('hex');
    let asset = this.#assets.get(digest);

    if (asset === undefined) {
      // Reserved synchronously, before any `await`: a concurrent put() for
      // the same digest sees this entry immediately rather than racing to
      // create its own, which is what makes "stores once" hold even when
      // put() is called concurrently for identical bytes, not just in
      // sequence.
      asset = {
        originalName: meta.originalName,
        mimeType: meta.mimeType,
        byteLength: bytes.byteLength,
        usages: [],
        written: this.#writeOnce(digest, bytes, meta.mimeType),
      };
      this.#assets.set(digest, asset);
    }
    asset.usages.push(meta.usedBy);
    await asset.written;
    return `sha256:${digest}`;
  }

  async #writeOnce(digest: string, bytes: Uint8Array, mimeType: string): Promise<void> {
    const extension = EXTENSIONS[mimeType] ?? 'bin';
    await mkdir(this.#dir, { recursive: true });
    await writeFile(join(this.#dir, `${digest}.${extension}`), bytes);
  }

  async writeIndex(): Promise<void> {
    const entries: Array<[string, AssetIndexEntry]> = [];
    for (const [digest, asset] of this.#assets) {
      entries.push([
        digest,
        {
          originalName: asset.originalName,
          mimeType: asset.mimeType,
          byteLength: asset.byteLength,
          usedBy: asset.usages,
        },
      ]);
    }
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const index: AssetIndex = Object.fromEntries(entries);
    await mkdir(this.#dir, { recursive: true });
    await writeFile(join(this.#dir, 'index.json'), JSON.stringify(index, null, 2), 'utf8');
  }

  static async readIndex(dir: string): Promise<AssetIndex> {
    return JSON.parse(await readFile(join(dir, 'index.json'), 'utf8')) as AssetIndex;
  }
}
