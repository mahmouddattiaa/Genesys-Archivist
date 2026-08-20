// apps/mcp-server/src/tools/docs-plan.ts
//
// genesys_docs_plan -- docs/03. Creates an immutable, expiring plan for a
// bounded set of flows, with a cryptographic plan hash `docs_run_start`
// later verifies exactly. An organization-wide scope above the policy
// maximum comes back as a `PlanPreview` instead of a `Plan`: this tool
// never silently proceeds with a broad, unconfirmed run, per AGENTS.md's
// staged-confirmation rule.
import { asFlowId, asProfileId } from '@genesys-archivist/domain';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { success } from '../envelope.js';
import type { Envelope } from '../envelope.js';
import type { Logger } from '../logger.js';
import type { ArchivistPort, PlanResult, PlanScope } from '../port.js';
import { opaqueIdSchema, runTool } from './common.js';

const DESCRIPTION =
  'Creates an immutable, expiring plan for a bounded set of flows: selected IDs, target ' +
  'versions, changed/unchanged counts, expected output paths, estimated work, warnings, and a ' +
  'cryptographic plan hash. An organization-wide selection above the policy maximum returns a ' +
  'preview requiring an explicit larger confirmedMax rather than proceeding. Read-only against ' +
  'Genesys; does not write local files.';

const flowSelectorSchema = z.object({
  flowId: opaqueIdSchema,
  version: z.string().min(1).max(200).optional(),
});

const scopeSchema = z.union([
  z.object({
    kind: z.literal('flows'),
    flows: z.array(flowSelectorSchema).min(1).max(500),
  }),
  z.object({
    kind: z.literal('organization'),
    flowTypes: z.array(z.string().min(1).max(200)).max(50).optional(),
  }),
]);

const inputShape = {
  profileId: opaqueIdSchema,
  scope: scopeSchema,
  confirmedMax: z.number().int().min(1).max(1_000_000).optional(),
};

export function registerDocsPlanTool(server: McpServer, port: ArchivistPort, logger: Logger): void {
  server.registerTool(
    'genesys_docs_plan',
    {
      title: 'Plan a documentation run',
      description: DESCRIPTION,
      inputSchema: inputShape,
      annotations: {
        title: 'Plan documentation run',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) =>
      runTool('genesys_docs_plan', logger, async (correlationId): Promise<Envelope<PlanResult>> => {
        const scope: PlanScope =
          args.scope.kind === 'flows'
            ? {
                kind: 'flows',
                flows: args.scope.flows.map((f) => ({
                  flowId: asFlowId(f.flowId),
                  ...(f.version !== undefined ? { version: f.version } : {}),
                })),
              }
            : {
                kind: 'organization',
                ...(args.scope.flowTypes !== undefined ? { flowTypes: args.scope.flowTypes } : {}),
              };

        const result = await port.createPlan({
          profileId: asProfileId(args.profileId),
          scope,
          ...(args.confirmedMax !== undefined ? { confirmedMax: args.confirmedMax } : {}),
        });

        if (result.kind === 'preview') {
          return success({
            correlationId,
            summary:
              `${String(result.candidateCount)} candidate flow(s) exceed the policy maximum of ` +
              `${String(result.policyMax)}. Call genesys_docs_plan again with confirmedMax >= ` +
              `${String(result.candidateCount)} to proceed.`,
            data: result,
          });
        }

        return success({
          correlationId,
          summary:
            `Plan ${result.planId}: ${String(result.changedCount)} changed, ` +
            `${String(result.unchangedCount)} unchanged flow(s); expires ${result.expiresAt}.`,
          data: result,
          warnings: result.warnings,
        });
      }),
  );
}
