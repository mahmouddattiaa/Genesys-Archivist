// packages/security/src/profiles.ts
import { z } from 'zod';

/**
 * Non-secret metadata only. This is the shape MCP tools are allowed to see.
 * `.strict()` is the enforcement: an unknown key such as `clientSecret` is a
 * parse failure, not a silently ignored extra.
 */
export const profileMetadataSchema = z
  .object({
    profileId: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'profileId must be lowercase alphanumeric with hyphens'),
    displayName: z.string().min(1).max(200),
    region: z.string().min(1).max(50),
    expectedOrganizationId: z.string().min(1).max(300),
    /**
     * The OAuth client ID. Deliberately stored in plain text.
     *
     * It is not a secret — the README is explicit that flow, queue and client
     * identifiers "are not secret API keys" — and authentication needs it
     * alongside the secret. An earlier revision stored only a hash of it,
     * which meant a profile carried no way to authenticate at all: the
     * credential store holds the secret, and the client ID existed nowhere
     * retrievable. See toSafeProfileSummary for why storing it is still safe.
     */
    clientId: z.string().min(1).max(200),
    outputRoot: z.string().min(1),
    lastValidatedAt: z.iso.datetime().nullish(),
  })
  .strict();

export type ProfileMetadata = z.infer<typeof profileMetadataSchema>;

/**
 * The projection MCP tools are allowed to return.
 *
 * `docs/03` states that `genesys_profiles_list` "never returns client IDs,
 * secrets, or tokens". Storage and exposure are different concerns: the client
 * ID must be on disk so the process can authenticate, and must not be handed
 * to a model that will write it into a chat transcript. Deriving the safe
 * shape here — rather than trusting each call site to remember — is what makes
 * that boundary hold.
 */
export interface SafeProfileSummary {
  readonly profileId: string;
  readonly displayName: string;
  readonly region: string;
  readonly expectedOrganizationId: string;
  readonly outputRoot: string;
  readonly lastValidatedAt: string | null;
  readonly secretPresent: boolean;
}

export function toSafeProfileSummary(
  profile: ProfileMetadata,
  secretPresent: boolean,
): SafeProfileSummary {
  return {
    profileId: profile.profileId,
    displayName: profile.displayName,
    region: profile.region,
    expectedOrganizationId: profile.expectedOrganizationId,
    outputRoot: profile.outputRoot,
    lastValidatedAt: profile.lastValidatedAt ?? null,
    secretPresent,
  };
}
