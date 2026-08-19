// packages/domain/src/derive-node-id.ts
import { createHash } from 'node:crypto';
import { asNodeId, type NodeId } from './identity.js';

export interface DeriveNodeIdInput {
  readonly containerPath: readonly string[];
  readonly sourceType: string;
  readonly discriminator: string;
}

// A separator that cannot occur in Genesys display names, so that
// ["a","b"] + "c" can never serialize to the same string as ["a"] + "b/c".
const SEP = '';

export function deriveNodeId(input: DeriveNodeIdInput): NodeId {
  const parts = [...input.containerPath, input.sourceType, input.discriminator];
  const canonical = parts.map((p) => p.normalize('NFC')).join(SEP);
  const digest = createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 32);
  return asNodeId(`nd_${digest}`);
}
