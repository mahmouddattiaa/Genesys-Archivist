// apps/mcp-server/test/stdout-purity.test.ts
//
// docs/03's transport policy: "Write protocol messages to stdout only
// through the SDK... Send logs to stderr." This server never uses
// `StdioServerTransport` in-process (tests connect through
// `InMemoryTransport` -- see helpers.ts), so the strongest thing this test
// can prove directly is the invariant that actually matters: nothing in this
// server's code path -- not a tool handler, not the envelope/logging
// plumbing -- ever calls `process.stdout.write` itself. A stray
// `console.log` or direct stdout write would show up here as a nonzero call
// count; `no-console` (eslint.config.mjs) already blocks the former outside
// tests, this is the runtime backstop for both.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { asOrganizationId, asProfileId } from '@genesys-archivist/domain';
import type { Logger, LogFields } from '../src/logger.js';
import { connectTestClient } from './helpers.js';
import { FakeArchivistPort } from './fake-port.js';

describe('stdout purity', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a full tool call writes nothing to process.stdout; the logger writes to its own stream instead', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const logLines: string[] = [];
    const logger: Logger = {
      info: (event: string, fields?: LogFields) => {
        logLines.push(JSON.stringify({ event, ...fields }));
      },
      error: (event: string, fields?: LogFields) => {
        logLines.push(JSON.stringify({ event, ...fields }));
      },
    };

    const port = new FakeArchivistPort();
    port.seedProfile({
      profileId: asProfileId('p'),
      displayName: 'Demo',
      expectedOrganizationId: asOrganizationId('org'),
      region: 'us-east-1',
      outputRoot: 'root',
      secretStoreStatus: 'available',
      lastValidatedAt: null,
    });

    const session = await connectTestClient(port, { logger });
    try {
      await session.client.callTool({ name: 'genesys_profiles_list', arguments: {} });
      await session.client.callTool({
        name: 'genesys_connection_check',
        arguments: { profileId: 'p' },
      });
    } finally {
      await session.close();
    }

    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(logLines.length).toBeGreaterThan(0);
    expect(logLines.some((line) => line.includes('tool.invoked'))).toBe(true);
    expect(logLines.some((line) => line.includes('tool.completed'))).toBe(true);
  });

  it('the default logger (no explicit logger option) writes to process.stderr, not process.stdout', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const port = new FakeArchivistPort();
    const session = await connectTestClient(port);
    try {
      await session.client.callTool({ name: 'genesys_profiles_list', arguments: {} });
    } finally {
      await session.close();
    }

    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalled();
  });
});
