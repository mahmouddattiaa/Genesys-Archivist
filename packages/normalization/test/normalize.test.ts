// packages/normalization/test/normalize.test.ts
import { readFile } from 'node:fs/promises';
import type { ValidateFunction } from 'ajv';
import { beforeAll, describe, expect, it } from 'vitest';
import { asNodeId } from '@genesys-archivist/domain';
import { createSchemaValidator } from '@genesys-archivist/testing';
import { normalizeFlow } from '../src/normalize.js';

let raw: unknown;
let validate: ValidateFunction;

const input = () => ({
  config: raw,
  source: {
    provider: 'platform-api' as const,
    adapterVersion: '0.1.0',
    extractedAt: '2026-08-20T00:00:00Z',
    region: 'eu_west_1',
    organizationId: 'org_1',
    trackingIdsAvailable: true,
    redactionApplied: true,
  },
  flow: {
    id: 'f1',
    name: 'Fixture Flow',
    type: 'inboundcall',
    secure: false,
    version: { selected: '4.0', state: 'published' as const },
  },
});

beforeAll(async () => {
  raw = JSON.parse(await readFile('fixtures/flow-config/inboundcall-47-nodes.json', 'utf8'));
  // allowUnionTypes matches scripts/validate-schemas.mjs's own Ajv setup —
  // the schema deliberately uses `type: [...]` unions (nullable ids,
  // integer-or-string version numbers), and strict mode refuses to compile
  // any schema keyword under a type union without this flag. Every other
  // option is exactly as the plan specifies: strict:true, allErrors:true.
  validate = await createSchemaValidator('schemas/flow-snapshot.schema.json', {
    allErrors: true,
    allowUnionTypes: true,
  });
});

describe('normalizeFlow', () => {
  it('produces a snapshot that validates against the published schema', () => {
    const snapshot = normalizeFlow(input());
    const valid = validate(snapshot);
    if (!valid) console.error(validate.errors);
    expect(valid).toBe(true);
  });

  it('carries all 47 nodes through', () => {
    expect(normalizeFlow(input()).graph.nodes).toHaveLength(47);
  });

  it('records at least one entry node', () => {
    expect(normalizeFlow(input()).graph.entryNodeIds.length).toBeGreaterThan(0);
  });

  it('reports completeness honestly', () => {
    const c = normalizeFlow(input()).completeness;
    expect(c?.representedObjectCount).toBe(47);
    expect(c?.unsupportedNodeCount).toBe(0);
  });

  it('is deterministic — identical input yields identical output', () => {
    expect(JSON.stringify(normalizeFlow(input()))).toBe(JSON.stringify(normalizeFlow(input())));
  });

  it('produces a stable canonical graph hash', () => {
    expect(normalizeFlow(input()).hashes.normalizedGraph).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('every node evidence id resolves to a real evidence record', () => {
    const s = normalizeFlow(input());
    const ids = new Set(s.evidence.map((e) => e.evidenceId));
    for (const n of s.graph.nodes) for (const id of n.evidenceIds) expect(ids.has(id)).toBe(true);
  });

  it('every dependency reference points at a real node', () => {
    const s = normalizeFlow(input());
    const ids = new Set(s.graph.nodes.map((n) => n.nodeId));
    for (const d of s.dependencies)
      for (const n of d.referencedByNodeIds) expect(ids.has(asNodeId(n))).toBe(true);
  });
});
