// @genesys-archivist/mcp-server
// The `genesys-archivist` MCP STDIO server.
//
// This is the package's public surface for anything that wants to embed or
// test the server without going through the `bin.ts` process entry point:
// `createServer` builds an `McpServer` against an injected `ArchivistPort`
// without connecting a transport, which is exactly what
// `apps/mcp-server/test/*.test.ts` uses to drive the whole tool/resource/
// prompt set in-process.
export { createServer } from './server.js';
export type { CreateServerOptions } from './server.js';

export type {
  ArchivistPort,
  ConnectionCheckResult,
  FlowDescriptor,
  FlowDiff,
  FlowInspection,
  FlowListPage,
  FlowListQuery,
  FlowPublicationState,
  Plan,
  PlanFlowSelector,
  PlanInput,
  PlanPreview,
  PlanResult,
  PlanScope,
  ProfileSummary,
  ResourceDocument,
  ResourceLocator,
  RunError,
  RunState,
  RunStatus,
} from './port.js';
export { PlanRejectedError } from './port.js';

export { buildResourceUri, parseResourceUri } from './resources.js';
export { wrapUntrusted } from './untrusted.js';
export type { WrapUntrustedOptions, WrappedUntrusted } from './untrusted.js';

export { createStderrLogger, NULL_LOGGER } from './logger.js';
export type { LogFields, LogFieldValue, Logger } from './logger.js';

export { buildRealPort } from './wire.js';
