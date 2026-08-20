// apps/mcp-server/src/tools/common.ts
//
// Shared plumbing every tool file uses so the nine tools in `tools/` do not
// each reinvent correlation-id handling, envelope construction, structured
// logging, or the generic-exception-to-safe-envelope translation. This is
// where the release-blocking rule from the task brief ("an error envelope
// never carries a stack trace...") is enforced for the common case:
// `runTool` catches whatever a handler throws and, unless it recognizes the
// error as one of this codebase's own typed, pre-sanitized types, always
// returns the same generic `unexpectedFailure` -- never `error.message`,
// never `error.stack`.
import { InvalidIdentityError } from '@genesys-archivist/domain';
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { failure, newCorrelationId, toCallToolResult, unexpectedFailure } from '../envelope.js';
import type { Envelope } from '../envelope.js';
import type { Logger } from '../logger.js';

/**
 * Identifiers (profile, flow, run, plan ids) are opaque tokens from local
 * configuration or from a prior tool result, never free-form display text or
 * a filesystem path. The schema only bounds length and forbids the empty
 * string; the branded constructors in `@genesys-archivist/domain`
 * (`asProfileId`, `asFlowId`, ...) do the real validation when a tool
 * converts the raw string into a domain id.
 */
export const opaqueIdSchema = z.string().min(1).max(300);

export type ToolHandler<T> = (correlationId: string) => Promise<Envelope<T>>;

/**
 * Runs one tool handler and converts whatever it returns, or throws, into a
 * `CallToolResult`. A handler is expected to catch its own *expected*
 * failure modes (a missing profile, a rejected plan) and return a `failure()`
 * envelope for them with a specific taxonomy code; `runTool`'s catch block
 * is the backstop for everything else, and it is deliberately generic --
 * this is the one place that stands between an arbitrary thrown value
 * (which might be a raw upstream error carrying a path or a stack) and the
 * client.
 *
 * Every call is logged (start and outcome) to `logger`, which `server.ts`
 * always wires to stderr -- see docs/11's structured-logging requirements:
 * correlation id, tool name, outcome, and nothing that could carry
 * tenant content or a credential.
 */
export async function runTool<T>(
  toolName: string,
  logger: Logger,
  handler: ToolHandler<T>,
): Promise<CallToolResult> {
  const correlationId = newCorrelationId();
  logger.info('tool.invoked', { tool: toolName, correlationId });
  try {
    const envelope = await handler(correlationId);
    logger.info('tool.completed', { tool: toolName, correlationId, ok: envelope.ok });
    return toCallToolResult(envelope);
  } catch (error) {
    if (error instanceof InvalidIdentityError) {
      logger.error('tool.failed', { tool: toolName, correlationId, code: 'INVALID_ARGUMENT' });
      return toCallToolResult(
        failure({
          correlationId,
          code: 'INVALID_ARGUMENT',
          category: 'input',
          retryable: false,
          message: 'One or more identifiers were not valid.',
        }),
      );
    }
    // Deliberately not logging error.message or error.stack: an upstream
    // SDK exception, a filesystem error, or a rejected promise can carry a
    // path or a stack trace, and docs/11 forbids both from ever reaching a
    // log line.
    logger.error('tool.failed', { tool: toolName, correlationId, code: 'UNEXPECTED_ERROR' });
    return toCallToolResult(unexpectedFailure(correlationId));
  }
}
