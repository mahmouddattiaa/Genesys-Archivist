// packages/normalization/src/config-schema.ts
import { z } from 'zod';

/**
 * Boundary schema for a raw Genesys Architect flow configuration.
 *
 * Deliberately asymmetric:
 *  - Permissive on unknown keys via `.passthrough()`. Genesys adds fields to
 *    its API responses regularly; a capture tool that breaks when a vendor
 *    adds a field fails exactly when a customer upgrades.
 *  - Strict on the fields the normalizer actually reads. If
 *    `flowSequenceItemList` disappears, the flow cannot be normalized at all
 *    and the run must fail loudly rather than emit an empty snapshot.
 */
export const flowConfigSchema = z
  .object({
    name: z.string(),
    type: z.string(),
    flowSequenceItemList: z.array(z.unknown()),
    variables: z.array(z.unknown()).default([]),
  })
  .loose();

export type RawFlowConfig = z.infer<typeof flowConfigSchema>;

/**
 * Thrown when a raw configuration fails boundary validation.
 *
 * Flow configuration is customer data and this message reaches log files, so
 * the message is built from Zod's `issue.path` only. `issue.message` is
 * discarded because it can embed received values.
 */
export class ConfigValidationError extends Error {
  constructor(paths: readonly string[]) {
    super(
      paths.length > 0
        ? `Invalid flow configuration at path(s): ${paths.join(', ')}`
        : 'Invalid flow configuration',
    );
    this.name = 'ConfigValidationError';
  }
}

const pathToString = (path: readonly PropertyKey[]): string =>
  path.length > 0 ? path.map(String).join('.') : '(root)';

/** Validates a raw configuration object, throwing `ConfigValidationError` on failure. */
export function parseFlowConfig(raw: unknown): RawFlowConfig {
  const result = flowConfigSchema.safeParse(raw);
  if (!result.success) {
    const paths = result.error.issues.map((issue) => pathToString(issue.path));
    throw new ConfigValidationError(paths);
  }
  return result.data;
}
