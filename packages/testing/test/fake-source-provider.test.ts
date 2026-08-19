// packages/testing/test/fake-source-provider.test.ts
import { describe, expect, it } from 'vitest';
import { asFlowId, asOrganizationId } from '@genesys-archivist/domain';
import { FakeSourceProvider } from '../src/fake-source-provider.js';

describe('FakeSourceProvider', () => {
  it('reports the seeded organization identity', async () => {
    const provider = new FakeSourceProvider({
      organizationId: asOrganizationId('org_1'),
      region: 'test',
    });
    const identity = await provider.validateConnection();
    expect(identity.organizationId).toBe('org_1');
  });

  it('pages through seeded flows without losing any', async () => {
    const provider = new FakeSourceProvider({
      organizationId: asOrganizationId('org_1'),
      region: 'test',
      pageSize: 2,
    });
    for (let i = 0; i < 5; i += 1) {
      provider.seedFlow({
        flowId: asFlowId(`f${String(i)}`),
        name: `Flow ${String(i)}`,
        type: 'inboundcall',
      });
    }
    const seen: string[] = [];
    for await (const flow of provider.listFlows({})) seen.push(flow.flowId);
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });

  it('keeps same-named flows in different divisions distinct', async () => {
    const provider = new FakeSourceProvider({
      organizationId: asOrganizationId('org_1'),
      region: 'test',
    });
    provider.seedFlow({
      flowId: asFlowId('f1'),
      name: 'Inbound',
      type: 'inboundcall',
      divisionId: 'd1',
    });
    provider.seedFlow({
      flowId: asFlowId('f2'),
      name: 'Inbound',
      type: 'inboundcall',
      divisionId: 'd2',
    });
    const seen: string[] = [];
    for await (const flow of provider.listFlows({})) seen.push(flow.flowId);
    expect(seen).toEqual(['f1', 'f2']);
  });

  it('throws a structured error for an unknown flow', async () => {
    const provider = new FakeSourceProvider({
      organizationId: asOrganizationId('org_1'),
      region: 'test',
    });
    await expect(
      provider.loadFlowSource({ flowId: asFlowId('nope'), versionId: null }),
    ).rejects.toThrow(/FLOW_NOT_FOUND/);
  });
});
