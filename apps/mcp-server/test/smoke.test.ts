// apps/mcp-server/test/smoke.test.ts
import { describe, expect, it } from 'vitest';
import { asOrganizationId, asProfileId } from '@genesys-archivist/domain';
import { connectTestClient, envelopeOf } from './helpers.js';
import { FakeArchivistPort } from './fake-port.js';

describe('smoke: server boots and answers a tool call', () => {
  it('lists profiles through a real MCP client/server round trip', async () => {
    const port = new FakeArchivistPort();
    port.seedProfile({
      profileId: asProfileId('demo'),
      displayName: 'Demo profile',
      expectedOrganizationId: asOrganizationId('org-1'),
      region: 'us-east-1',
      outputRoot: 'demo-root',
      secretStoreStatus: 'available',
      lastValidatedAt: null,
    });

    const session = await connectTestClient(port);
    try {
      const result = await session.client.callTool({
        name: 'genesys_profiles_list',
        arguments: {},
      });
      const envelope = envelopeOf(result);
      expect(envelope['ok']).toBe(true);
      expect(envelope['contractVersion']).toBe('1.0');
    } finally {
      await session.close();
    }
  });
});
