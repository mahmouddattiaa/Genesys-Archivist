// apps/mcp-server/src/tools/profiles-list.ts
//
// genesys_profiles_list -- docs/03-mcp-contract.md. Read-only, zero
// arguments, and structurally incapable of returning a secret: the input
// schema is empty, and `ProfileSummary` (port.ts) has no field for a client
// ID, token, or secret to occupy.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { success } from '../envelope.js';
import type { Logger } from '../logger.js';
import type { ArchivistPort } from '../port.js';
import { runTool } from './common.js';

const DESCRIPTION =
  'Lists safe profile metadata: profile ID, display name, expected organization, region, ' +
  'output root, secret-store status, and last validation time. Never returns client IDs, ' +
  'secrets, or tokens -- profiles are provisioned with the archivist CLI, never through chat. ' +
  'Read-only.';

export function registerProfilesListTool(
  server: McpServer,
  port: ArchivistPort,
  logger: Logger,
): void {
  server.registerTool(
    'genesys_profiles_list',
    {
      title: 'List configured Genesys profiles',
      description: DESCRIPTION,
      inputSchema: {},
      annotations: {
        title: 'List profiles',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () =>
      runTool('genesys_profiles_list', logger, async (correlationId) => {
        const profiles = await port.listProfiles();
        return success({
          correlationId,
          summary: `${String(profiles.length)} profile(s) configured.`,
          data: { profiles },
        });
      }),
  );
}
