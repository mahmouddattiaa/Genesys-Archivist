// apps/mcp-server/test/credential-schema.test.ts
//
// Structural credential test (task brief): walk every registered tool's
// *published* JSON Schema -- what a real MCP client actually receives from
// `tools/list`, not the zod source -- and assert no property name matches a
// credential-shaped pattern at any depth. AGENTS.md: "profile add is
// CLI-only, forever." This test is the automated fence around that rule: it
// must fail the moment anyone adds such a field to any tool, anywhere in the
// schema tree, without needing a reviewer to notice.
import { describe, expect, it } from 'vitest';
import { connectTestClient } from './helpers.js';
import { FakeArchivistPort } from './fake-port.js';

const FORBIDDEN_NAME =
  /secret|password|token|credential|apikey|api_key|clientsecret|authorization/i;

/** Collects every object-schema property name reachable from `schema`,
 * descending through `properties`, `items`, `additionalProperties`, and the
 * `anyOf`/`oneOf`/`allOf` combinators the zod-to-JSON-Schema conversion may
 * produce for a union or optional field. */
function collectPropertyNames(schema: unknown, out: string[]): void {
  if (typeof schema !== 'object' || schema === null) return;
  const node = schema as Record<string, unknown>;

  const properties = node['properties'];
  if (typeof properties === 'object' && properties !== null) {
    for (const [name, sub] of Object.entries(properties as Record<string, unknown>)) {
      out.push(name);
      collectPropertyNames(sub, out);
    }
  }

  if (typeof node['items'] === 'object') collectPropertyNames(node['items'], out);
  if (typeof node['additionalProperties'] === 'object') {
    collectPropertyNames(node['additionalProperties'], out);
  }

  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const branch = node[key];
    if (Array.isArray(branch)) {
      for (const entry of branch) collectPropertyNames(entry, out);
    }
  }
}

describe('structural credential test', () => {
  it('no tool input schema has a credential-shaped property name at any depth', async () => {
    const session = await connectTestClient(new FakeArchivistPort());
    try {
      const { tools } = await session.client.listTools();
      expect(tools.length).toBeGreaterThan(0);

      for (const tool of tools) {
        const names: string[] = [];
        collectPropertyNames(tool.inputSchema, names);
        const offenders = names.filter((name) => FORBIDDEN_NAME.test(name));
        expect(offenders, `tool "${tool.name}" has credential-shaped field(s)`).toEqual([]);
      }
    } finally {
      await session.close();
    }
  });

  it('genesys_docs_review_submit is not registered (omitted per docs/03 until the grounding validator exists)', async () => {
    const session = await connectTestClient(new FakeArchivistPort());
    try {
      const { tools } = await session.client.listTools();
      expect(tools.map((t) => t.name)).not.toContain('genesys_docs_review_submit');
    } finally {
      await session.close();
    }
  });

  it('would catch a credential-shaped field if one were added (self-test of the detector)', () => {
    const hostileSchema = {
      type: 'object',
      properties: {
        profileId: { type: 'string' },
        nested: {
          type: 'object',
          properties: { clientSecret: { type: 'string' } },
        },
      },
    };
    const names: string[] = [];
    collectPropertyNames(hostileSchema, names);
    expect(names.some((name) => FORBIDDEN_NAME.test(name))).toBe(true);
  });
});
