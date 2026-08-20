// apps/mcp-server/test/helpers.ts
//
// Drives `createServer` through a real MCP `Client`, connected over the
// SDK's `InMemoryTransport` -- no child process, no socket, no real stdio.
// This is the SDK's own supported way to exercise a server end-to-end:
// requests go through the real JSON-RPC request/response path (schema
// validation, tool routing, resource routing included), which a direct call
// into a tool's handler function would skip.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createServer } from '../src/server.js';
import type { CreateServerOptions } from '../src/server.js';
import type { ArchivistPort } from '../src/port.js';

export interface TestSession {
  readonly client: Client;
  readonly server: McpServer;
  close(): Promise<void>;
}

export async function connectTestClient(
  port: ArchivistPort,
  options: CreateServerOptions = {},
): Promise<TestSession> {
  const server = createServer(port, options);
  const client = new Client({ name: 'test-client', version: '0.0.0' });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  return {
    client,
    server,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** Parses the JSON envelope out of a `CallToolResult`'s first text content
 * block -- every tool in this server returns exactly that shape (see
 * `envelope.ts`'s `toCallToolResult`).
 *
 * Takes `unknown` rather than `{ content?: unknown }` deliberately. The latter
 * is a *weak type* -- every property optional -- so TypeScript requires the
 * argument to share at least one property with it, and the SDK's result types
 * carry an index signature that defeats that check. Narrowing here is both
 * what a parser of an external result should do and the only shape that
 * typechecks against every result variant the SDK returns. */
export function envelopeOf(result: unknown): Record<string, unknown> {
  if (typeof result !== 'object' || result === null) {
    throw new Error('Tool result was not an object.');
  }
  const content: unknown = (result as Record<string, unknown>)['content'];
  if (!Array.isArray(content)) throw new Error('Tool result had no content array.');
  const first: unknown = content[0];
  if (
    typeof first !== 'object' ||
    first === null ||
    (first as Record<string, unknown>)['type'] !== 'text'
  ) {
    throw new Error('Tool result content was not text.');
  }
  const text = (first as { readonly text: string }).text;
  return JSON.parse(text) as Record<string, unknown>;
}
