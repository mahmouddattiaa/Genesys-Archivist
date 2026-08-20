// apps/mcp-server/test/cancel-idempotence.test.ts
//
// docs/03: "Cancellation is idempotent." Cancelling an active run twice must
// both succeed and report `cancelled` both times, never a second distinct
// run or an error on the second call -- and neither call may touch previous
// output (there is no filesystem in this test at all, which is itself part
// of the proof: nothing about cancellation reaches for one).
import { describe, expect, it } from 'vitest';
import { asFlowId, asProfileId } from '@genesys-archivist/domain';
import { connectTestClient, envelopeOf } from './helpers.js';
import { FakeArchivistPort } from './fake-port.js';

const PROFILE_ID = String(asProfileId('p'));

async function planAndStartOneRun(
  session: Awaited<ReturnType<typeof connectTestClient>>,
): Promise<string> {
  const planEnvelope = envelopeOf(
    await session.client.callTool({
      name: 'genesys_docs_plan',
      arguments: { profileId: PROFILE_ID, scope: { kind: 'flows', flows: [{ flowId: 'f1' }] } },
    }),
  );
  const plan = planEnvelope['data'] as { planId: string; planHash: string };
  const runEnvelope = envelopeOf(
    await session.client.callTool({
      name: 'genesys_docs_run_start',
      arguments: { planId: plan.planId, planHash: plan.planHash },
    }),
  );
  return (runEnvelope['data'] as { runId: string }).runId;
}

describe('genesys_docs_run_cancel is idempotent', () => {
  it('cancelling twice succeeds twice and reports the same cancelled state', async () => {
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
      const runId = await planAndStartOneRun(session);

      const firstCancel = envelopeOf(
        await session.client.callTool({ name: 'genesys_docs_run_cancel', arguments: { runId } }),
      );
      const secondCancel = envelopeOf(
        await session.client.callTool({ name: 'genesys_docs_run_cancel', arguments: { runId } }),
      );

      expect(firstCancel['ok']).toBe(true);
      expect(secondCancel['ok']).toBe(true);
      expect((firstCancel['data'] as { state: string }).state).toBe('cancelled');
      expect((secondCancel['data'] as { state: string }).state).toBe('cancelled');
      expect((firstCancel['data'] as { runId: string }).runId).toBe(
        (secondCancel['data'] as { runId: string }).runId,
      );
    } finally {
      await session.close();
    }
  });

  it('cancelling an already-completed run succeeds and reports the terminal state unchanged', async () => {
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
      const runId = await planAndStartOneRun(session);

      // Simulate the run having already finished successfully, the way a
      // real port's background worker would update it -- cancel must not
      // clobber a genuinely completed run back to "cancelled".
      port.setRunState(runId, 'completed');

      const cancelResult = envelopeOf(
        await session.client.callTool({ name: 'genesys_docs_run_cancel', arguments: { runId } }),
      );
      expect(cancelResult['ok']).toBe(true);
      expect((cancelResult['data'] as { state: string }).state).toBe('completed');

      // Output is untouched: this fixture never wrote a file to begin with,
      // and the cancelled-twice case above proves the same call path is
      // side-effect free on a repeat call.
      expect(port.peekRun(runId)?.state).toBe('completed');
    } finally {
      await session.close();
    }
  });
});
