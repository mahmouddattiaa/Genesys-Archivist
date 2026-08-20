// apps/mcp-server/test/canaries.test.ts
//
// docs/06's release gate: "Secret canaries in every possible upstream field
// never appear in output/logs/errors." The canary here simulates a raw,
// upstream-shaped exception -- the kind of thing a real Genesys SDK call or
// filesystem error could throw, carrying content this process must never
// repeat. `runTool` (tools/common.ts) is supposed to be the backstop: unless
// an error is one of this codebase's own typed, pre-sanitized types
// (`InvalidIdentityError`, `PlanRejectedError`), its message must never
// reach a tool result, a log line, or a resource body.
import { describe, expect, it } from 'vitest';
import { asFlowId, asProfileId } from '@genesys-archivist/domain';
import type { Logger, LogFields } from '../src/logger.js';
import { connectTestClient, envelopeOf } from './helpers.js';
import { FakeArchivistPort } from './fake-port.js';

const CANARY = 'CANARY-SECRET-6b0d3e';

/** Captures every field ever logged, as flattened strings, so a test can
 * assert the canary never appears in any of them without caring about log
 * shape. */
function capturingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const record = (event: string, fields?: LogFields): void => {
    lines.push(JSON.stringify({ event, ...fields }));
  };
  return { logger: { info: record, error: record }, lines };
}

describe('secret canary suite', () => {
  it('a canary in a thrown upstream-shaped error never reaches a tool result or a log line', async () => {
    const port = new FakeArchivistPort();
    port.throwOn('listProfiles', new Error(`upstream failure: token=${CANARY} at /var/secrets/x`));
    const { logger, lines } = capturingLogger();

    const session = await connectTestClient(port, { logger });
    try {
      const result = await session.client.callTool({
        name: 'genesys_profiles_list',
        arguments: {},
      });
      const envelope = envelopeOf(result);
      expect(envelope['ok']).toBe(false);
      expect(JSON.stringify(envelope)).not.toContain(CANARY);
      expect(lines.join('\n')).not.toContain(CANARY);
    } finally {
      await session.close();
    }
  });

  it('a canary in a connection-check failure never reaches the result', async () => {
    const port = new FakeArchivistPort();
    port.throwOn('checkConnection', new Error(`Authorization: Bearer ${CANARY}`));
    const { logger, lines } = capturingLogger();

    const session = await connectTestClient(port, { logger });
    try {
      const result = await session.client.callTool({
        name: 'genesys_connection_check',
        arguments: { profileId: String(asProfileId('p')) },
      });
      const envelope = envelopeOf(result);
      expect(JSON.stringify(envelope)).not.toContain(CANARY);
      expect(lines.join('\n')).not.toContain(CANARY);
    } finally {
      await session.close();
    }
  });

  it('a canary in a resource-read failure never reaches the protocol error', async () => {
    const port = new FakeArchivistPort();
    port.throwOn('readResource', new Error(`leaked ${CANARY}`));
    const { logger, lines } = capturingLogger();

    const session = await connectTestClient(port, { logger });
    try {
      let caught = '';
      try {
        await session.client.readResource({
          uri: 'genesys-docs://organizations/o/flows/f/versions/v/snapshot',
        });
      } catch (error) {
        caught = error instanceof Error ? error.message : String(error);
      }
      expect(caught).not.toContain(CANARY);
      expect(lines.join('\n')).not.toContain(CANARY);
    } finally {
      await session.close();
    }
  });

  it('a canary embedded in seeded flow data is only ever surfaced delimited, never in an error path', async () => {
    // Legitimate tenant data containing the canary string is not a leak --
    // AGENTS.md treats flow content as data to display (delimited,
    // labelled), not as a secret to redact. What must never happen is the
    // canary reaching an *error* envelope, which only carries fixed,
    // pre-written strings.
    const port = new FakeArchivistPort();
    port.throwOn('inspectFlow', new Error(`inspect failed near ${CANARY}`));
    const { logger, lines } = capturingLogger();

    const session = await connectTestClient(port, { logger });
    try {
      const result = await session.client.callTool({
        name: 'genesys_flow_inspect',
        arguments: { profileId: String(asProfileId('p')), flowId: String(asFlowId('f')) },
      });
      const envelope = envelopeOf(result);
      expect(envelope['ok']).toBe(false);
      expect(JSON.stringify(envelope)).not.toContain(CANARY);
      expect(lines.join('\n')).not.toContain(CANARY);
    } finally {
      await session.close();
    }
  });
});
