// @genesys-archivist/normalization
// Converts a raw flow definition into a versioned FlowSnapshot.
// Implemented by the tasks in docs/superpowers/plans/.
export { flowConfigSchema, parseFlowConfig, ConfigValidationError } from './config-schema.js';
export type { RawFlowConfig } from './config-schema.js';
