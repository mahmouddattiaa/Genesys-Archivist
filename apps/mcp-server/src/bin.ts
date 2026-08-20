#!/usr/bin/env node
// apps/mcp-server/src/bin.ts
//
// The `genesys-archivist-mcp` STDIO entry point. Everything testable lives
// in `server.ts`, `wire.ts`, and the modules they use; this file's only job
// is the parts that genuinely require a real process: connecting the real
// transport, installing a stderr-only logger, and handling SIGINT/SIGTERM
// with a shutdown that never deletes output. Guarded the same way
// apps/cli/src/bin.ts is, so importing this module (as a future test might,
// for `readVersion` or similar) never starts a real server against
// process.stdin/stdout.
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createStderrLogger } from './logger.js';
import { createServer } from './server.js';
import { buildRealPort } from './wire.js';

// docs/03: "Write protocol messages to stdout only through the SDK. Send
// logs to stderr or structured log files." A stray console.log (console.*
// is already an ESLint error outside tests -- see eslint.config.mjs's
// `no-console` rule) would corrupt the protocol stream, so every line this
// process emits goes through this one stderr logger, shared between the
// server's own tool-call logging (server.ts) and this file's process
// lifecycle events.
const logger = createStderrLogger();

function readVersion(): string {
  // Same relative-depth trick apps/cli/src/bin.ts uses: this file and its
  // compiled dist/bin.js sit at the same depth below apps/mcp-server, so one
  // relative path resolves correctly from either src (vitest) or dist (the
  // published bin).
  const require = createRequire(import.meta.url);
  const pkg = require('../package.json') as { readonly version: string };
  return pkg.version;
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return fileURLToPath(import.meta.url) === resolve(entry);
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const port = buildRealPort();
  const server = createServer(port, { version: readVersion(), logger });

  // Cooperative, idempotent shutdown: a second SIGINT/SIGTERM while the
  // first is still closing the transport is a no-op, not a second attempt
  // that could race the first. Neither signal touches the filesystem, so
  // there is nothing here that could disturb previously promoted
  // documentation -- shutdown only closes the protocol connection.
  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('server.stopping', { signal });
    try {
      await server.close();
      logger.info('server.stopped');
      process.exitCode = 0;
    } catch {
      logger.error('server.stop_failed');
      process.exitCode = 1;
    }
  };
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('server.started');
}

if (isMainModule()) {
  try {
    await main();
  } catch {
    // The one place an uncaught startup failure is reported. Still never a
    // raw error message/stack: only the fact that startup failed.
    logger.error('server.start_failed');
    process.exitCode = 1;
  }
}
