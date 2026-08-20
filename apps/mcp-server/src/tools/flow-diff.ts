// apps/mcp-server/src/tools/flow-diff.ts
//
// genesys_flow_diff -- docs/03. Returns a semantic diff between two known
// snapshots/versions. Node, variable, and prompt names in the diff are
// tenant-authored, so every list here is wrapped as untrusted content before
// it leaves this process; large detail is exposed as a resource rather than
// inlined.
import { asFlowId, asProfileId } from '@genesys-archivist/domain';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { success } from '../envelope.js';
import type { Logger } from '../logger.js';
import type { ArchivistPort } from '../port.js';
import { wrapUntrusted } from '../untrusted.js';
import { opaqueIdSchema, runTool } from './common.js';

const DESCRIPTION =
  'Returns a semantic diff between two known snapshots/versions of one flow: added/removed/' +
  'changed nodes, branches, variables, dependencies, prompts, and material caller-journey ' +
  'changes. Large detail is exposed as a resource. Names in the diff are tenant-authored and ' +
  'are returned as delimited, labelled untrusted data. Read-only.';

const inputShape = {
  profileId: opaqueIdSchema,
  flowId: opaqueIdSchema,
  fromVersion: opaqueIdSchema,
  toVersion: opaqueIdSchema,
};

function wrapList(items: readonly string[], label: string): readonly string[] {
  return items.map((item) => wrapUntrusted(item, { label }).text);
}

export function registerFlowDiffTool(server: McpServer, port: ArchivistPort, logger: Logger): void {
  server.registerTool(
    'genesys_flow_diff',
    {
      title: 'Diff two Genesys Architect flow versions',
      description: DESCRIPTION,
      inputSchema: inputShape,
      annotations: {
        title: 'Diff flow versions',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) =>
      runTool('genesys_flow_diff', logger, async (correlationId) => {
        const diff = await port.diffFlow(
          asProfileId(args.profileId),
          asFlowId(args.flowId),
          args.fromVersion,
          args.toVersion,
        );

        const changeCount =
          diff.addedNodes.length +
          diff.removedNodes.length +
          diff.changedNodes.length +
          diff.materialJourneyChanges.length;

        return success({
          correlationId,
          summary:
            changeCount === 0
              ? 'No material differences between the two versions.'
              : `${String(changeCount)} node/journey change(s) between ${diff.fromVersion} and ` +
                `${diff.toVersion}.`,
          data: {
            flowId: diff.flowId,
            fromVersion: diff.fromVersion,
            toVersion: diff.toVersion,
            addedNodes: wrapList(diff.addedNodes, 'added node name'),
            removedNodes: wrapList(diff.removedNodes, 'removed node name'),
            changedNodes: wrapList(diff.changedNodes, 'changed node name'),
            addedVariables: wrapList(diff.addedVariables, 'added variable name'),
            removedVariables: wrapList(diff.removedVariables, 'removed variable name'),
            dependencyChanges: wrapList(diff.dependencyChanges, 'dependency change description'),
            promptChanges: wrapList(diff.promptChanges, 'prompt change description'),
            materialJourneyChanges: wrapList(
              diff.materialJourneyChanges,
              'caller-journey change description',
            ),
          },
          resources: diff.detailResourceUri !== null ? [diff.detailResourceUri] : [],
        });
      }),
  );
}
