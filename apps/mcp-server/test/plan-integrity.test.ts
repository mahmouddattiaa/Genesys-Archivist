// apps/mcp-server/test/plan-integrity.test.ts
//
// docs/03: "Plans are immutable and content-addressed... A changed or
// expired plan is rejected [by docs_run_start]... Starting the same valid
// plan with the same idempotency key returns the existing run." Three
// separate guarantees, each proven here against a real plan/run round trip
// through genesys_docs_plan and genesys_docs_run_start.
import { describe, expect, it } from 'vitest';
import { asFlowId, asProfileId } from '@genesys-archivist/domain';
import { connectTestClient, envelopeOf } from './helpers.js';
import { FakeArchivistPort } from './fake-port.js';

const PROFILE_ID = String(asProfileId('p'));

function scopeForOneFlow(flowId: string): Record<string, unknown> {
  return { kind: 'flows', flows: [{ flowId }] };
}

describe('plan integrity', () => {
  it('a plan with an altered hash is rejected by genesys_docs_run_start', async () => {
    const port = new FakeArchivistPort();
    port.seedFlow({
      flowId: asFlowId('f1'),
      name: 'Flow 1',
      type: 'inboundcall',
      divisionId: null,
      publicationState: 'published',
      lastModifiedAt: null,
      latestVersion: '1',
      publishedVersion: '1',
    });

    const session = await connectTestClient(port);
    try {
      const planEnvelope = envelopeOf(
        await session.client.callTool({
          name: 'genesys_docs_plan',
          arguments: { profileId: PROFILE_ID, scope: scopeForOneFlow('f1') },
        }),
      );
      const plan = planEnvelope['data'] as { planId: string; planHash: string };

      const startEnvelope = envelopeOf(
        await session.client.callTool({
          name: 'genesys_docs_run_start',
          arguments: { planId: plan.planId, planHash: `${plan.planHash}tampered` },
        }),
      );
      expect(startEnvelope['ok']).toBe(false);
      expect((startEnvelope['error'] as { code: string }).code).toBe('PLAN_HASH_MISMATCH');
    } finally {
      await session.close();
    }
  });

  it('an expired plan is rejected by genesys_docs_run_start', async () => {
    let now = new Date('2026-01-01T00:00:00.000Z');
    const port = new FakeArchivistPort({ now: () => now, planTtlMs: 1000 });
    port.seedFlow({
      flowId: asFlowId('f1'),
      name: 'Flow 1',
      type: 'inboundcall',
      divisionId: null,
      publicationState: 'published',
      lastModifiedAt: null,
      latestVersion: '1',
      publishedVersion: '1',
    });

    const session = await connectTestClient(port);
    try {
      const planEnvelope = envelopeOf(
        await session.client.callTool({
          name: 'genesys_docs_plan',
          arguments: { profileId: PROFILE_ID, scope: scopeForOneFlow('f1') },
        }),
      );
      const plan = planEnvelope['data'] as { planId: string; planHash: string };

      now = new Date(now.getTime() + 10_000); // well past the 1s TTL

      const startEnvelope = envelopeOf(
        await session.client.callTool({
          name: 'genesys_docs_run_start',
          arguments: { planId: plan.planId, planHash: plan.planHash },
        }),
      );
      expect(startEnvelope['ok']).toBe(false);
      expect((startEnvelope['error'] as { code: string }).code).toBe('PLAN_EXPIRED');
    } finally {
      await session.close();
    }
  });

  it('starting the same valid plan twice does not start two runs', async () => {
    const port = new FakeArchivistPort();
    port.seedFlow({
      flowId: asFlowId('f1'),
      name: 'Flow 1',
      type: 'inboundcall',
      divisionId: null,
      publicationState: 'published',
      lastModifiedAt: null,
      latestVersion: '1',
      publishedVersion: '1',
    });

    const session = await connectTestClient(port);
    try {
      const planEnvelope = envelopeOf(
        await session.client.callTool({
          name: 'genesys_docs_plan',
          arguments: { profileId: PROFILE_ID, scope: scopeForOneFlow('f1') },
        }),
      );
      const plan = planEnvelope['data'] as { planId: string; planHash: string };

      const first = envelopeOf(
        await session.client.callTool({
          name: 'genesys_docs_run_start',
          arguments: { planId: plan.planId, planHash: plan.planHash },
        }),
      );
      const second = envelopeOf(
        await session.client.callTool({
          name: 'genesys_docs_run_start',
          arguments: { planId: plan.planId, planHash: plan.planHash },
        }),
      );

      const firstRun = first['data'] as { runId: string };
      const secondRun = second['data'] as { runId: string };
      expect(first['ok']).toBe(true);
      expect(second['ok']).toBe(true);
      expect(secondRun.runId).toBe(firstRun.runId);
    } finally {
      await session.close();
    }
  });

  it('an organization-wide plan above the policy maximum returns a preview, not a plan', async () => {
    const port = new FakeArchivistPort({ policyMax: 3 });
    for (let i = 0; i < 10; i += 1) {
      port.seedFlow({
        flowId: asFlowId(`f${String(i)}`),
        name: `Flow ${String(i)}`,
        type: 'inboundcall',
        divisionId: null,
        publicationState: 'published',
        lastModifiedAt: null,
        latestVersion: '1',
        publishedVersion: '1',
      });
    }

    const session = await connectTestClient(port);
    try {
      const planEnvelope = envelopeOf(
        await session.client.callTool({
          name: 'genesys_docs_plan',
          arguments: { profileId: PROFILE_ID, scope: { kind: 'organization' } },
        }),
      );
      const data = planEnvelope['data'] as {
        kind: string;
        candidateCount: number;
        policyMax: number;
      };
      expect(data.kind).toBe('preview');
      expect(data.candidateCount).toBe(10);
      expect(data.policyMax).toBe(3);

      // Confirming with a sufficient confirmedMax proceeds to a real plan.
      const confirmedEnvelope = envelopeOf(
        await session.client.callTool({
          name: 'genesys_docs_plan',
          arguments: {
            profileId: PROFILE_ID,
            scope: { kind: 'organization' },
            confirmedMax: 10,
          },
        }),
      );
      const confirmedData = confirmedEnvelope['data'] as {
        kind: string;
        selectedFlowIds: string[];
      };
      expect(confirmedData.kind).toBe('plan');
      expect(confirmedData.selectedFlowIds).toHaveLength(10);
    } finally {
      await session.close();
    }
  });
});
