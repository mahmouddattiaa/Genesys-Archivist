// packages/domain/src/identity.ts
declare const brand: unique symbol;

export type Branded<T, B extends string> = T & { readonly [brand]: B };

export class InvalidIdentityError extends Error {
  constructor(kind: string, reason: string) {
    // The value is deliberately absent: identifiers are not secret, but this
    // error type is reused for profile IDs and must never echo input.
    super(`Invalid ${kind}: ${reason}`);
    this.name = 'InvalidIdentityError';
  }
}

const MAX_LENGTH = 300;

function makeConstructor<B extends string>(kind: B) {
  return (raw: string): Branded<string, B> => {
    if (raw.trim().length === 0) throw new InvalidIdentityError(kind, 'must not be empty');
    if (raw.length > MAX_LENGTH)
      throw new InvalidIdentityError(kind, `exceeds ${String(MAX_LENGTH)} characters`);
    return raw as Branded<string, B>;
  };
}

export type OrganizationId = Branded<string, 'OrganizationId'>;
export type FlowId = Branded<string, 'FlowId'>;
export type FlowVersionId = Branded<string, 'FlowVersionId'>;
export type NodeId = Branded<string, 'NodeId'>;
export type EdgeId = Branded<string, 'EdgeId'>;
export type EvidenceId = Branded<string, 'EvidenceId'>;
export type CaptureId = Branded<string, 'CaptureId'>;
export type ResourceId = Branded<string, 'ResourceId'>;
export type ProfileId = Branded<string, 'ProfileId'>;
export type AssetHash = Branded<string, 'AssetHash'>;

export const asOrganizationId = makeConstructor('OrganizationId');
export const asFlowId = makeConstructor('FlowId');
export const asFlowVersionId = makeConstructor('FlowVersionId');
export const asNodeId = makeConstructor('NodeId');
export const asEdgeId = makeConstructor('EdgeId');
export const asEvidenceId = makeConstructor('EvidenceId');
export const asCaptureId = makeConstructor('CaptureId');
export const asResourceId = makeConstructor('ResourceId');
export const asProfileId = makeConstructor('ProfileId');
