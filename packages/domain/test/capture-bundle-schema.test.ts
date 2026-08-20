// packages/domain/test/capture-bundle-schema.test.ts
import { describe, expect, it, beforeAll } from 'vitest';
import type { ValidateFunction } from 'ajv';
import { createSchemaValidator } from '@genesys-archivist/testing';

let validate: ValidateFunction;

beforeAll(async () => {
  validate = await createSchemaValidator('schemas/capture-bundle.schema.json', {
    allErrors: true,
  });
});

const minimal = (): Record<string, unknown> => ({
  schemaVersion: '1.2',
  captureId: '2026-08-20T14-02-11Z_a1b2c3',
  sealedAt: '2026-08-20T14:31:00Z',
  classification: 'restricted',
  organization: { id: 'org_1', region: 'mec1' },
  policy: {
    mode: 'migration',
    versionSelection: 'published',
    captureAssets: true,
    captureDataTableRows: true,
  },
  versions: { application: '0.1.0', adapter: '0.1.0', sourceProvider: 'platform-api' },
  counts: { flows: 2, resources: 14, assets: 9, unresolvedReferences: 1 },
  contentHash: 'sha256:' + 'a'.repeat(64),
});

describe('capture-bundle schema', () => {
  it('accepts a minimal well-formed manifest', () => {
    expect(validate(minimal())).toBe(true);
  });

  it('requires a content hash, because an unsealed bundle must not look sealed', () => {
    const { contentHash: _omitted, ...withoutHash } = minimal();
    expect(validate(withoutHash)).toBe(false);
  });

  it('rejects a malformed content hash', () => {
    expect(validate({ ...minimal(), contentHash: 'md5:abc' })).toBe(false);
  });

  it('rejects an unknown top-level property', () => {
    expect(validate({ ...minimal(), clientSecret: 'oops' })).toBe(false);
  });

  it('rejects a classification weaker than restricted', () => {
    expect(validate({ ...minimal(), classification: 'public' })).toBe(false);
  });

  it('rejects a negative count', () => {
    expect(
      validate({
        ...minimal(),
        counts: { flows: -1, resources: 0, assets: 0, unresolvedReferences: 0 },
      }),
    ).toBe(false);
  });
});
