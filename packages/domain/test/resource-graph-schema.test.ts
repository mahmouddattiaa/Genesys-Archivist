// packages/domain/test/resource-graph-schema.test.ts
import { readFile } from 'node:fs/promises';
import { describe, expect, it, beforeAll } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { ValidateFunction } from 'ajv';

let validate: ValidateFunction;

beforeAll(async () => {
  const schema: unknown = JSON.parse(await readFile('schemas/resource-graph.schema.json', 'utf8'));
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  validate = ajv.compile(schema);
});

const minimal = (): Record<string, unknown> => ({
  schemaVersion: '1.0',
  captureId: '2026-08-20T14-02-11Z_a1b2c3',
  nodes: [
    {
      key: 'flow:f_main',
      type: 'flow',
      id: 'f_main',
      resolutionStatus: 'resolved',
      displayName: 'Main IVR',
    },
    {
      key: 'queue:q_billing',
      type: 'queue',
      id: 'q_billing',
      resolutionStatus: 'resolved',
      displayName: 'Billing',
    },
  ],
  edges: [
    { from: 'flow:f_main', to: 'queue:q_billing', viaNodeId: 'nd_abc', viaField: 'transferTarget' },
  ],
});

describe('resource-graph schema', () => {
  it('accepts a minimal graph', () => {
    expect(validate(minimal())).toBe(true);
  });

  it('requires every node to carry a resolution status', () => {
    const graph = minimal();
    (graph['nodes'] as Record<string, unknown>[])[0] = {
      key: 'flow:f_main',
      type: 'flow',
      id: 'f_main',
    };
    expect(validate(graph)).toBe(false);
  });

  it('rejects an unknown resolution status, so a silent drop cannot be encoded', () => {
    const graph = minimal();
    (graph['nodes'] as Record<string, unknown>[])[0]!['resolutionStatus'] = 'skipped';
    expect(validate(graph)).toBe(false);
  });

  it('requires an edge to record the node and field it came from', () => {
    const graph = minimal();
    (graph['edges'] as Record<string, unknown>[])[0] = {
      from: 'flow:f_main',
      to: 'queue:q_billing',
    };
    expect(validate(graph)).toBe(false);
  });

  it('rejects duplicate node keys', () => {
    const graph = minimal();
    const nodes = graph['nodes'] as Record<string, unknown>[];
    graph['nodes'] = [nodes[0], nodes[0]];
    expect(validate(graph)).toBe(false);
  });
});
