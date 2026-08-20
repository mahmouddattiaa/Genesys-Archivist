// apps/mcp-server/src/tools/flows-list.ts
//
// genesys_flows_list -- docs/03. Returns paginated flow descriptors, never
// full source. This is the one tool in the set that genuinely needs the
// continuation-token machinery in bounds.ts: an organization can hold far
// more flows than fit in one bounded result, and docs/03 requires a
// continuation token rather than silent truncation.
import { asProfileId } from '@genesys-archivist/domain';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { clampPageSize, decodeToken, encodeToken } from '../bounds.js';
import { failure, success } from '../envelope.js';
import type { Logger } from '../logger.js';
import type { ArchivistPort, FlowPublicationState } from '../port.js';
import { opaqueIdSchema, runTool } from './common.js';

const DESCRIPTION =
  'Returns paginated flow descriptors (id, name, type, division, publication state, latest ' +
  'and published version), never full flow source. Filters by type, division, name query, ' +
  'publication state, and changed-since time. Result size is capped; pass the returned cursor ' +
  'back in to fetch the next page. Read-only.';

/** This tool's own scope tag for the shared continuation-cursor format --
 * prevents a cursor minted here from being replayed against a different
 * paginated tool, should one exist later. Named "cursor", not "token": it
 * carries no authority, only a position, but the structural credential test
 * (test/credential-schema.test.ts) flags any input property name containing
 * "token" regardless of what it actually holds, and the property name
 * itself should not need a human to double-check that. */
const CURSOR_SCOPE = 'genesys_flows_list';

const publicationStateSchema = z.enum(['published', 'draft', 'unpublished', 'unknown']);

const inputShape = {
  profileId: opaqueIdSchema,
  flowType: z.string().min(1).max(200).optional(),
  divisionId: z.string().min(1).max(300).optional(),
  nameQuery: z.string().min(1).max(300).optional(),
  publicationState: publicationStateSchema.optional(),
  changedSince: z.string().min(1).max(64).optional(),
  pageSize: z.number().int().min(1).max(200).optional(),
  cursor: z.string().min(1).max(4000).optional(),
};

export function registerFlowsListTool(
  server: McpServer,
  port: ArchivistPort,
  logger: Logger,
): void {
  server.registerTool(
    'genesys_flows_list',
    {
      title: 'List Genesys Architect flows',
      description: DESCRIPTION,
      inputSchema: inputShape,
      annotations: {
        title: 'List flows',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) =>
      runTool('genesys_flows_list', logger, async (correlationId) => {
        const pageSize = clampPageSize(args.pageSize);

        let underlyingPageToken: string | undefined;
        if (args.cursor !== undefined) {
          const decoded = decodeToken(args.cursor, { scope: CURSOR_SCOPE });
          if (!decoded.ok) {
            return failure({
              correlationId,
              code: 'INVALID_ARGUMENT',
              category: 'input',
              retryable: false,
              message:
                decoded.reason === 'expired'
                  ? 'The cursor has expired. Call genesys_flows_list again without a cursor to ' +
                    'restart from the first page.'
                  : 'The cursor is not valid for this tool.',
            });
          }
          underlyingPageToken = decoded.payload.portPageToken;
        }

        const publicationState: FlowPublicationState | undefined = args.publicationState;
        const page = await port.listFlows(asProfileId(args.profileId), {
          ...(args.flowType !== undefined ? { flowType: args.flowType } : {}),
          ...(args.divisionId !== undefined ? { divisionId: args.divisionId } : {}),
          ...(args.nameQuery !== undefined ? { nameQuery: args.nameQuery } : {}),
          ...(publicationState !== undefined ? { publicationState } : {}),
          ...(args.changedSince !== undefined ? { changedSince: args.changedSince } : {}),
          pageSize,
          ...(underlyingPageToken !== undefined ? { pageToken: underlyingPageToken } : {}),
        });

        // Defensive cap: even if the port ignored pageSize, this server
        // never hands back more than it asked for.
        const items = page.items.slice(0, pageSize);
        const nextCursor =
          page.nextPageToken === null
            ? null
            : encodeToken({ scope: CURSOR_SCOPE, portPageToken: page.nextPageToken });

        return success({
          correlationId,
          summary:
            `${String(items.length)} flow(s) returned` +
            (nextCursor !== null ? '; more available.' : '.'),
          data: { items, nextCursor, totalKnown: page.totalKnown },
        });
      }),
  );
}
