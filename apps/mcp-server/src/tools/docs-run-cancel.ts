// apps/mcp-server/src/tools/docs-run-cancel.ts
//
// genesys_docs_run_cancel -- docs/03. Requests cooperative cancellation.
// Idempotent by construction: this file has no branch that behaves
// differently on a second call for the same runId, because it does nothing
// but relay whatever `port.cancelRun` (which owns the actual state machine)
// reports back. It never deletes previous good output -- it has no
// filesystem access to do so even if it wanted to.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { success } from '../envelope.js';
import type { Logger } from '../logger.js';
import type { ArchivistPort } from '../port.js';
import { opaqueIdSchema, runTool } from './common.js';

const DESCRIPTION =
  'Requests cooperative cancellation of a documentation run. Does not delete previous good ' +
  'output. Idempotent: cancelling an already-cancelled or already-completed run succeeds and ' +
  'reports its current state rather than erroring.';

const inputShape = { runId: opaqueIdSchema };

export function registerDocsRunCancelTool(
  server: McpServer,
  port: ArchivistPort,
  logger: Logger,
): void {
  server.registerTool(
    'genesys_docs_run_cancel',
    {
      title: 'Cancel a documentation run',
      description: DESCRIPTION,
      inputSchema: inputShape,
      annotations: {
        title: 'Cancel documentation run',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ runId }) =>
      runTool('genesys_docs_run_cancel', logger, async (correlationId) => {
        const status = await port.cancelRun(runId);
        return success({
          correlationId,
          summary: `Run ${status.runId} is ${status.state}.`,
          data: status,
          resources: status.resourceUris,
        });
      }),
  );
}
