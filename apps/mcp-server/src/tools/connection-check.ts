// apps/mcp-server/src/tools/connection-check.ts
//
// genesys_connection_check -- docs/03. Validates one profile, resolves
// organization identity, and reports missing permission categories without
// exposing a raw authorization response. The only input is a profile id: a
// client chooses which stored profile to use, never a credential itself
// (docs/06's separation-of-duties rule).
import { asProfileId } from '@genesys-archivist/domain';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { failure, success } from '../envelope.js';
import type { Logger } from '../logger.js';
import type { ArchivistPort } from '../port.js';
import { opaqueIdSchema, runTool } from './common.js';

const DESCRIPTION =
  'Validates one profile: resolves organization identity, checks source adapter ' +
  'availability, and reports missing read permission categories. Never exposes a raw ' +
  'authorization response. Read-only against Genesys.';

export function registerConnectionCheckTool(
  server: McpServer,
  port: ArchivistPort,
  logger: Logger,
): void {
  server.registerTool(
    'genesys_connection_check',
    {
      title: 'Check a Genesys profile connection',
      description: DESCRIPTION,
      inputSchema: { profileId: opaqueIdSchema },
      annotations: {
        title: 'Check connection',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ profileId }) =>
      runTool('genesys_connection_check', logger, async (correlationId) => {
        const result = await port.checkConnection(asProfileId(profileId));
        if (!result.reachable) {
          return failure({
            correlationId,
            code: 'PROFILE_SECRET_MISSING',
            category: 'authentication',
            retryable: false,
            message: 'The profile could not be validated against Genesys.',
            operatorAction:
              'Confirm the profile is provisioned (archivist profile add) and its credential ' +
              'has not expired, then retry.',
          });
        }
        return success({
          correlationId,
          summary:
            result.missingPermissionCategories.length === 0
              ? 'Connection validated; no permission gaps found.'
              : `Connection validated; ${String(result.missingPermissionCategories.length)} ` +
                'permission gap(s) found.',
          data: result,
          warnings: result.missingPermissionCategories.map(
            (category) => `Missing read permission category: ${category}`,
          ),
        });
      }),
  );
}
