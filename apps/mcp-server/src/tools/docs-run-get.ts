// apps/mcp-server/src/tools/docs-run-get.ts
//
// genesys_docs_run_get -- docs/03. Reports the run state machine: status,
// phase, per-flow counts, bounded errors, warnings, timestamps, and result
// resource URIs. Idempotent: calling this repeatedly for the same runId
// never changes anything, it only observes.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { MAX_ERROR_ITEMS } from '../bounds.js';
import { success } from '../envelope.js';
import type { Logger } from '../logger.js';
import type { ArchivistPort } from '../port.js';
import { opaqueIdSchema, runTool } from './common.js';

const DESCRIPTION =
  'Returns status, phase, per-flow counts, bounded errors, warnings, timestamps, and result ' +
  'resource URIs for one documentation run. States: planned, queued, extracting, ' +
  'normalizing, analyzing, rendering, validating, promoting, completed, with terminal ' +
  'alternatives failed, cancelled, completed_with_warnings. Read-only.';

const inputShape = { runId: opaqueIdSchema };

export function registerDocsRunGetTool(
  server: McpServer,
  port: ArchivistPort,
  logger: Logger,
): void {
  server.registerTool(
    'genesys_docs_run_get',
    {
      title: 'Get documentation run status',
      description: DESCRIPTION,
      inputSchema: inputShape,
      annotations: {
        title: 'Get run status',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ runId }) =>
      runTool('genesys_docs_run_get', logger, async (correlationId) => {
        const status = await port.getRun(runId);
        const boundedErrors = status.errors.slice(0, MAX_ERROR_ITEMS);

        const omittedNote =
          status.errors.length > boundedErrors.length
            ? [
                `${String(status.errors.length - boundedErrors.length)} additional error(s) ` +
                  'omitted; read the run-errors resource for the full list.',
              ]
            : [];

        return success({
          correlationId,
          summary: `Run ${status.runId} is ${status.state}.`,
          data: { ...status, errors: boundedErrors },
          resources: status.resourceUris,
          warnings: [...status.warnings, ...omittedNote],
        });
      }),
  );
}
