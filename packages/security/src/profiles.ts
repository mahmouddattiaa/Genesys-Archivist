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
    /** A hash of the client ID, so a profile can be matched without storing it. */
    clientIdFingerprint: z.string().regex(/^sha256:[0-9a-f]+$/),
    outputRoot: z.string().min(1),
    lastValidatedAt: z.iso.datetime().nullish(),
  })
  .strict();

export type ProfileMetadata = z.infer<typeof profileMetadataSchema>;
