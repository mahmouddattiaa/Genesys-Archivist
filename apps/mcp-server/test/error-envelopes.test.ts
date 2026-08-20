// apps/mcp-server/test/error-envelopes.test.ts
//
// The task brief's release-blocking rule: "An error envelope never carries
// a stack trace, a filesystem path, a raw upstream response, or tenant
// content." This throws an error shaped exactly like the thing that rule is
// about -- a message containing a filesystem path, with a real `.stack` --
// and proves the resulting envelope has neither.
import { describe, expect, it } from 'vitest';
import { asFlowId, asProfileId } from '@genesys-archivist/domain';
import { connectTestClient, envelopeOf } from './helpers.js';
import { FakeArchivistPort } from './fake-port.js';

const PATH_FRAGMENT = 'C:\\Users\\acme-customer\\secrets\\credentials.json';

function pathAndStackError(): Error {
  const error = new Error(`ENOENT: no such file or directory, open '${PATH_FRAGMENT}'`);
  // A real filesystem error always has a stack; make sure this one does too,
  // so the test proves the envelope omits an actual stack, not an absent one.
  error.stack = `Error: ENOENT...\n    at readFileSync (node:fs:123:45)\n    at ${PATH_FRAGMENT}`;
  return error;
}

describe('error envelopes never carry a path or a stack', () => {
  it('genesys_flow_inspect: a thrown fs-shaped error yields a generic, safe envelope', async () => {
    const port = new FakeArchivistPort();
    port.throwOn('inspectFlow', pathAndStackError());

    const session = await connectTestClient(port);
    try {
      const result = await session.client.callTool({
        name: 'genesys_flow_inspect',
        arguments: { profileId: String(asProfileId('p')), flowId: String(asFlowId('f')) },
      });
      const envelope = envelopeOf(result);
      expect(envelope['ok']).toBe(false);
      const error = envelope['error'] as Record<string, unknown>;

      expect(JSON.stringify(envelope)).not.toContain(PATH_FRAGMENT);
      expect(JSON.stringify(envelope)).not.toContain('at readFileSync');
      expect(JSON.stringify(envelope)).not.toContain('.js:');
      expect(error['code']).toBe('UNEXPECTED_ERROR');
      expect(typeof error['message']).toBe('string');
      expect(Object.keys(error)).not.toContain('stack');
    } finally {
      await session.close();
    }
  });

  it('the envelope shape matches docs/03: contractVersion, ok, correlationId, error.{code,category,retryable,message}', async () => {
    const port = new FakeArchivistPort();
    port.throwOn('listProfiles', pathAndStackError());
    const session = await connectTestClient(port);
    try {
      const result = await session.client.callTool({
        name: 'genesys_profiles_list',
        arguments: {},
      });
      const envelope = envelopeOf(result);
      expect(envelope).toMatchObject({
        contractVersion: '1.0',
        ok: false,
      });
      expect(typeof envelope['correlationId']).toBe('string');
      const error = envelope['error'] as Record<string, unknown>;
      expect(typeof error['code']).toBe('string');
      expect(typeof error['category']).toBe('string');
      expect(typeof error['retryable']).toBe('boolean');
      expect(typeof error['message']).toBe('string');
    } finally {
      await session.close();
    }
  });

  it('a success envelope matches docs/03: contractVersion, ok, correlationId, summary, data, warnings, resources', async () => {
    const port = new FakeArchivistPort();
    const session = await connectTestClient(port);
    try {
      const result = await session.client.callTool({
        name: 'genesys_profiles_list',
        arguments: {},
      });
      const envelope = envelopeOf(result);
      expect(envelope).toMatchObject({ contractVersion: '1.0', ok: true });
      expect(typeof envelope['correlationId']).toBe('string');
      expect(typeof envelope['summary']).toBe('string');
      expect(envelope).toHaveProperty('data');
      expect(Array.isArray(envelope['warnings'])).toBe(true);
      expect(Array.isArray(envelope['resources'])).toBe(true);
    } finally {
      await session.close();
    }
  });
});
