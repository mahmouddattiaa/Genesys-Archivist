// packages/domain/src/source-provider.ts
import type { FlowId, FlowVersionId, OrganizationId, ResourceId } from './identity.js';

export interface ConnectionIdentity {
  readonly organizationId: OrganizationId;
  readonly organizationName: string | null;
  readonly region: string;
}

export interface FlowDescriptor {
  readonly flowId: FlowId;
  readonly name: string;
  readonly type: string;
  readonly divisionId: string | null;
  readonly publishedVersion: string | null;
}

export interface FlowDiscoveryQuery {
  readonly flowTypes?: readonly string[];
  readonly divisionIds?: readonly string[];
}

export interface FlowVersionRef {
  readonly flowId: FlowId;
  /** null means "whatever the version policy resolves to", usually published. */
  readonly versionId: FlowVersionId | null;
}

export interface RawFlowSource {
  readonly flowId: FlowId;
  readonly versionId: FlowVersionId;
  readonly format: 'yaml' | 'json';
  readonly body: string;
}

export type DependencyResolutionStatus =
  'resolved' | 'partially_resolved' | 'not_found' | 'forbidden' | 'unsupported' | 'redacted';

export interface DependencyRef {
  readonly type: string;
  readonly id: ResourceId;
}

export interface DependencyResolution {
  readonly ref: DependencyRef;
  readonly status: DependencyResolutionStatus;
  readonly displayName: string | null;
  readonly safeMetadata: Readonly<Record<string, unknown>>;
}

/**
 * The single seam between the domain and Genesys. Four implementations exist;
 * which one is the production default is decided by Phase 0 spike S1, not here.
 *
 * No implementation may expose a mutation method, and no SDK object may cross
 * this boundary.
 */
export interface GenesysSourceProvider {
  validateConnection(): Promise<ConnectionIdentity>;
  listFlows(query: FlowDiscoveryQuery): AsyncIterable<FlowDescriptor>;
  loadFlowSource(ref: FlowVersionRef): Promise<RawFlowSource>;
  resolveDependencies(refs: readonly DependencyRef[]): Promise<readonly DependencyResolution[]>;
}
