// apps/mcp-server/test/bounded-output.test.ts
//
// docs/03's output-size policy: a flow list is paginated, never dumped
// whole. This proves it against a port holding far more flows than any
// single tool result may contain, and separately proves the cursor a tool
// hands back is opaque and tamper-evident: forging or reusing an expired one
// is rejected without ever reaching the port.
import { describe, expect, it } from 'vitest';
import { asFlowId, asProfileId } from '@genesys-archivist/domain';
import { encodeToken } from '../src/bounds.js';
import { connectTestClient, envelopeOf } from './helpers.js';
import { FakeArchivistPort } from './fake-port.js';
import type { FlowDescriptor } from '../src/port.js';

const PROFILE_ID = asProfileId('bulk-profile');

function manyFlows(count: number): FlowDescriptor[] {
  return Array.from({ length: count }, (_, i) => ({
    flowId: asFlowId(`flow-${String(i).padStart(5, '0')}`),
    name: `Flow ${String(i)}`,
    type: 'inboundcall',
    divisionId: null,
    publicationState: 'published' as const,
    lastModifiedAt: null,
    latestVersion: '1',
    publishedVersion: '1',
  }));
}

describe('bounded output: genesys_flows_list', () => {
  it('caps a 10,000-flow organization to one bounded page plus a cursor', async () => {
    const port = new FakeArchivistPort();
    port.seedFlows(manyFlows(10_000));

    const session = await connectTestClient(port);
    try {
      const result = await session.client.callTool({
        name: 'genesys_flows_list',
        arguments: { profileId: String(PROFILE_ID), pageSize: 50 },
      });
      const envelope = envelopeOf(result);
      expect(envelope['ok']).toBe(true);
      const data = envelope['data'] as { items: unknown[]; nextCursor: string | null };
      expect(data.items.length).toBe(50);
      expect(typeof data.nextCursor).toBe('string');

      // The serialized result itself must respect the 32 KiB summary target
      // even at this scale -- a capped item count is not enough on its own
      // if each item could still be arbitrarily large.
      const text = (result.content as { readonly text: string }[])[0]?.text ?? '';
      expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(32 * 1024);
    } finally {
      await session.close();
    }
  });

  it('the cursor round-trips to the next page', async () => {
    const port = new FakeArchivistPort();
    port.seedFlows(manyFlows(120));

    const session = await connectTestClient(port);
    try {
      const first = envelopeOf(
        await session.client.callTool({
          name: 'genesys_flows_list',
          arguments: { profileId: String(PROFILE_ID), pageSize: 50 },
        }),
      );
      const firstData = first['data'] as { items: { flowId: string }[]; nextCursor: string };
      expect(firstData.items).toHaveLength(50);
      expect(firstData.items[0]?.flowId).toBe('flow-00000');

      const second = envelopeOf(
        await session.client.callTool({
          name: 'genesys_flows_list',
          arguments: {
            profileId: String(PROFILE_ID),
            pageSize: 50,
            cursor: firstData.nextCursor,
          },
        }),
      );
      const secondData = second['data'] as {
        items: { flowId: string }[];
        nextCursor: string | null;
      };
      expect(secondData.items).toHaveLength(50);
      expect(secondData.items[0]?.flowId).toBe('flow-00050');

      const third = envelopeOf(
        await session.client.callTool({
          name: 'genesys_flows_list',
          arguments: {
            profileId: String(PROFILE_ID),
            pageSize: 50,
            cursor: secondData.nextCursor as string,
          },
        }),
      );
      const thirdData = third['data'] as { items: unknown[]; nextCursor: string | null };
      expect(thirdData.items).toHaveLength(20);
      expect(thirdData.nextCursor).toBeNull();
    } finally {
      await session.close();
    }
  });

  it('rejects a crafted (garbage) cursor without touching the port', async () => {
    const port = new FakeArchivistPort();
    port.seedFlows(manyFlows(5));
    let listCalls = 0;
    const originalListFlows = port.listFlows.bind(port);
    port.listFlows = (profileId, query) => {
      listCalls += 1;
      return originalListFlows(profileId, query);
    };

    const session = await connectTestClient(port);
    try {
      const result = await session.client.callTool({
        name: 'genesys_flows_list',
        arguments: { profileId: String(PROFILE_ID), cursor: 'not-a-real-cursor' },
      });
      const envelope = envelopeOf(result);
      expect(envelope['ok']).toBe(false);
      expect((envelope['error'] as { code: string }).code).toBe('INVALID_ARGUMENT');
      expect(listCalls).toBe(0);
    } finally {
      await session.close();
    }
  });

  it('rejects a tampered cursor (valid shape, wrong signature)', async () => {
    const port = new FakeArchivistPort();
    port.seedFlows(manyFlows(5));
    const session = await connectTestClient(port);
    try {
      const validCursor = encodeToken({ scope: 'genesys_flows_list', portPageToken: 'x' });
      const body = validCursor.split('.')[0] ?? '';
      const tampered = `${body}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;

      const result = await session.client.callTool({
        name: 'genesys_flows_list',
        arguments: { profileId: String(PROFILE_ID), cursor: tampered },
      });
      const envelope = envelopeOf(result);
      expect(envelope['ok']).toBe(false);
      expect((envelope['error'] as { code: string }).code).toBe('INVALID_ARGUMENT');
    } finally {
      await session.close();
    }
  });

  it('rejects an expired cursor', async () => {
    const port = new FakeArchivistPort();
    port.seedFlows(manyFlows(5));
    const session = await connectTestClient(port);
    try {
      const expiredCursor = encodeToken(
        { scope: 'genesys_flows_list', portPageToken: 'x' },
        { ttlMs: -1 },
      );

      const result = await session.client.callTool({
        name: 'genesys_flows_list',
        arguments: { profileId: String(PROFILE_ID), cursor: expiredCursor },
      });
      const envelope = envelopeOf(result);
      expect(envelope['ok']).toBe(false);
      expect((envelope['error'] as { code: string }).code).toBe('INVALID_ARGUMENT');
      expect((envelope['error'] as { message: string }).message).toMatch(/expired/i);
    } finally {
      await session.close();
    }
  });
});
