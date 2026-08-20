// packages/capture/test/multi-language-assets.test.ts
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asFlowId, asOrganizationId, asResourceId } from '@genesys-archivist/domain';
import { FakeSourceProvider } from '@genesys-archivist/testing';
import { runCapture } from '../src/capture-run.js';

/**
 * A Genesys prompt carries one audio recording *per language*.
 *
 * The `safeMetadata.asset` convention this module documents could only ever
 * carry one of them, so a `migration` capture of a bilingual IVR wrote the
 * first language's audio, dropped the rest, and still sealed a bundle
 * declaring itself migration-ready. AGENTS.md forbids exactly that: never
 * silently drop something, and never present an incomplete capture as
 * complete.
 *
 * It is invisible in a monolingual sandbox, which is why it survived until a
 * provider that reads real prompt resources was written. The sandbox this
 * project targets serves both `en-us` and `ar-sa` prompt audio.
 */
let root = '';

const AUDIO = {
  'en-us': new Uint8Array([1, 2, 3, 4]),
  'ar-sa': new Uint8Array([5, 6, 7, 8, 9]),
  'fr-fr': new Uint8Array([10, 11]),
} as const;

function bilingualPromptProvider(): FakeSourceProvider {
  const provider = new FakeSourceProvider({
    organizationId: asOrganizationId('org_1'),
    region: 'euw1',
  });
  provider.seedFlow({ flowId: asFlowId('f0'), name: 'Flow 0', type: 'inboundcall' });
  provider.seedDependency({
    ref: { type: 'flow', id: asResourceId('f0') },
    status: 'resolved',
    displayName: 'Flow 0',
    safeMetadata: { references: [{ type: 'userPrompt', id: 'p1' }] },
  });
  provider.seedDependency({
    ref: { type: 'userPrompt', id: asResourceId('p1') },
    status: 'resolved',
    displayName: 'Main Greeting',
    safeMetadata: {
      references: [],
      availableLanguages: Object.keys(AUDIO),
      assets: Object.entries(AUDIO).map(([language, bytes]) => ({
        bytes,
        originalName: `greeting-${language}.wav`,
        mimeType: 'audio/wav',
      })),
    },
  });
  return provider;
}

const captureOptions = (provider: FakeSourceProvider) => ({
  root,
  runId: 'run-multilang',
  planHash: 'sha256:' + 'a'.repeat(64),
  organizationId: asOrganizationId('org_1'),
  expectedOrganizationId: asOrganizationId('org_1'),
  provider,
  mode: 'migration' as const,
  now: () => new Date('2026-08-20T14:31:00Z'),
});

/** Counts stored payloads, excluding `index.json` — the asset store writes its
 * index alongside the content-addressed files. */
async function assetFileCount(bundleDir: string): Promise<number> {
  const walk = async (dir: string): Promise<number> => {
    let total = 0;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) total += await walk(join(dir, entry.name));
      else if (entry.name !== 'index.json') total += 1;
    }
    return total;
  };
  try {
    return await walk(join(bundleDir, 'assets'));
  } catch {
    return 0;
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'archivist-multilang-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('multi-language prompt assets', () => {
  it('captures every language of a prompt, not just the first', async () => {
    const result = await runCapture(captureOptions(bilingualPromptProvider()));

    expect(result.state).not.toBe('failed');
    expect(result.bundleDir).toBeDefined();

    // Three distinct recordings, three distinct content hashes, so
    // content-addressed storage keeps three files rather than deduplicating.
    expect(await assetFileCount(result.bundleDir as string)).toBe(3);
  });

  it('still accepts the singular asset field', async () => {
    // The convention documented at the top of capture-run.ts named `asset`,
    // and a provider written against that spelling must keep working.
    const provider = new FakeSourceProvider({
      organizationId: asOrganizationId('org_1'),
      region: 'euw1',
    });
    provider.seedFlow({ flowId: asFlowId('f0'), name: 'Flow 0', type: 'inboundcall' });
    provider.seedDependency({
      ref: { type: 'flow', id: asResourceId('f0') },
      status: 'resolved',
      displayName: 'Flow 0',
      safeMetadata: { references: [{ type: 'userPrompt', id: 'p1' }] },
    });
    provider.seedDependency({
      ref: { type: 'userPrompt', id: asResourceId('p1') },
      status: 'resolved',
      displayName: 'Main Greeting',
      safeMetadata: {
        references: [],
        asset: {
          bytes: AUDIO['en-us'],
          originalName: 'greeting.wav',
          mimeType: 'audio/wav',
        },
      },
    });

    const result = await runCapture(captureOptions(provider));
    expect(await assetFileCount(result.bundleDir as string)).toBe(1);
  });

  it('never writes raw audio bytes into the resource body', async () => {
    // `assets` is this module's own bookkeeping, not part of the resource.
    // Leaving it in would serialize a Uint8Array of audio into the resource's
    // JSON -- megabytes per language, duplicating what the content-addressed
    // asset store already holds.
    const result = await runCapture(captureOptions(bilingualPromptProvider()));
    const bundleDir = result.bundleDir as string;

    const resourceDir = join(bundleDir, 'resources', 'userPrompt');
    const files = await readdir(resourceDir).catch(() => [] as string[]);
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const body = await readFile(join(resourceDir, file), 'utf8');
      const parsed: unknown = JSON.parse(body);
      expect(Object.keys(parsed as Record<string, unknown>)).not.toContain('assets');
      expect(Object.keys(parsed as Record<string, unknown>)).not.toContain('asset');
      // The languages themselves are legitimate resource metadata and must
      // survive: dropping the bytes must not also drop the fact they existed.
      expect(body).toContain('ar-sa');
    }
  });
});
