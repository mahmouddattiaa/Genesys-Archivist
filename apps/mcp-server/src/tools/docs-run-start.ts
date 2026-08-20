// apps/mcp-server/src/tools/docs-run-start.ts
//
// genesys_docs_run_start -- docs/03. Starts a persisted run from a plan id
// and the exact plan hash `genesys_docs_plan` returned. A changed or expired
// plan is rejected; the port (not this file) owns making a repeated start of
// the same valid plan idempotent, because it is the only thing with a
// durable view of runs across separate tool calls.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { failure, success } from '../envelope.js';
import type { Logger } from '../logger.js';
import type { ArchivistPort } from '../port.js';
import { PlanRejectedError } from '../port.js';
import { opaqueIdSchema, runTool } from './common.js';

const DESCRIPTION =
  'Starts a persisted documentation run from a plan ID and its exact plan hash. A changed or ' +
  'expired plan is rejected. Returns a runId immediately; the run continues durably after this ' +
  'call returns -- poll genesys_docs_run_get for status. Writes local files; read-only against ' +
  'Genesys.';

const inputShape = {
  planId: opaqueIdSchema,
  planHash: z.string().min(1).max(200),
};

export function registerDocsRunStartTool(
  server: McpServer,
  port: ArchivistPort,
  logger: Logger,
): void {
  server.registerTool(
    'genesys_docs_run_start',
    {
      title: 'Start a documentation run',
      description: DESCRIPTION,
      inputSchema: inputShape,
      annotations: {
        title: 'Start documentation run',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) =>
      runTool('genesys_docs_run_start', logger, async (correlationId) => {
        try {
          const status = await port.startRun(args.planId, args.planHash);
          return success({
            correlationId,
            summary: `Run ${status.runId} is ${status.state}.`,
            data: status,
            resources: status.resourceUris,
          });
        } catch (error) {
          if (error instanceof PlanRejectedError) {
            return failure({
              correlationId,
              code: error.code,
              category: 'input',
              retryable: false,
              message: error.message,
              operatorAction:
                error.code === 'PLAN_EXPIRED'
                  ? 'Call genesys_docs_plan again to create a fresh plan, then retry.'
                  : 'Call genesys_docs_plan again; the plan may have been altered or is unknown ' +
                    'to this server.',
            });
          }
          throw error;
        }
      }),
  );
}
