#!/usr/bin/env node
/**
 * Speaks real MCP over stdio to the built server, exactly as a client does.
 *
 * The in-process test suite drives `createServer` against a fake port, which
 * proves the tools but not the thing a developer actually experiences: a
 * process spawned by Claude Code or Cursor, handshaking over stdin and stdout,
 * with the real wired port behind it. Those are different failures --
 * a stray write to stdout corrupts the protocol and no unit test would see it.
 *
 * Read-only against Genesys: it lists profiles and tools, and (with --live)
 * validates a connection and lists flows. It starts no run.
 *
 *   node scripts/smoke/mcp-client-smoke.mjs [--live] [--profile <id>]
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const live = process.argv.includes('--live');
const profileIndex = process.argv.indexOf('--profile');
const profileId = profileIndex === -1 ? 'sandbox' : (process.argv[profileIndex + 1] ?? 'sandbox');

const ok = (m) => console.log(`  \u2713 ${m}`);
const bad = (m) => console.log(`  \u2717 ${m}`);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['apps/mcp-server/dist/bin.js'],
  cwd: process.cwd(),
});
const client = new Client({ name: 'archivist-smoke', version: '0.0.0' }, { capabilities: {} });

let failures = 0;
const check = (condition, message) => {
  if (condition) ok(message);
  else {
    bad(message);
    failures += 1;
  }
};

async function callTool(name, args) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? '{}';
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, raw: text.slice(0, 300) };
  }
}

console.log('\nMCP client smoke\n');
await client.connect(transport);
ok('connected over stdio');

const instructions = client.getInstructions?.() ?? '';
check(instructions.length > 0, 'server sent initialization instructions');
check(
  /never request or pass credentials in chat/i.test(instructions),
  'instructions carry the mandated credential warning',
);
check(/archivist render/i.test(instructions), 'instructions tell the client to offer rendering');

const { tools } = await client.listTools();
check(tools.length === 9, `9 tools registered (found ${String(tools.length)})`);

// The structural credential check, from the outside this time: whatever the
// in-process test asserts about registered schemas, what a client is actually
// offered is what matters.
const forbidden = /secret|password|token|credential|apikey|api_key|authorization/i;
const offending = [];
const walk = (node, path) => {
  if (node === null || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node)) {
    if (key === 'properties' && value !== null && typeof value === 'object') {
      for (const property of Object.keys(value)) {
        if (forbidden.test(property)) offending.push(`${path}.${property}`);
      }
    }
    walk(value, `${path}.${key}`);
  }
};
for (const tool of tools) walk(tool.inputSchema, tool.name);
check(
  offending.length === 0,
  `no tool accepts a credential-shaped field${offending.length ? `: ${offending.join(', ')}` : ''}`,
);

const profiles = await callTool('genesys_profiles_list', {});
check(profiles.ok === true, 'genesys_profiles_list returned ok');
check(
  !JSON.stringify(profiles).includes('clientId'),
  'profiles_list never returns a client ID (docs/03)',
);

if (live) {
  console.log('\n  --live: touching Genesys, read-only\n');
  const conn = await callTool('genesys_connection_check', { profileId });
  check(conn.ok === true, `connection_check ok for profile "${profileId}"`);
  check(
    typeof conn.data?.organizationName === 'string',
    `resolved organization: ${String(conn.data?.organizationName)}`,
  );

  const flows = await callTool('genesys_flows_list', { profileId, pageSize: 5 });
  check(flows.ok === true, 'flows_list returned ok');
  check((flows.data?.items ?? []).length > 0, 'flows_list returned flows');
  check(typeof flows.data?.nextCursor === 'string', 'flows_list paginates (continuation cursor)');
}

await client.close();
console.log(failures === 0 ? '\nALL CHECKS PASSED\n' : `\n${String(failures)} CHECK(S) FAILED\n`);
process.exitCode = failures === 0 ? 0 : 1;
