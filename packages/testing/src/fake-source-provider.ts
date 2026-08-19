// packages/testing/src/fake-source-provider.ts
import {
  asFlowVersionId,
  type ConnectionIdentity,
  type DependencyRef,
  type DependencyResolution,
  type FlowDescriptor,
  type FlowDiscoveryQuery,
  type FlowVersionRef,
  type GenesysSourceProvider,
  type OrganizationId,
  type RawFlowSource,
} from '@genesys-archivist/domain';

export interface FakeSourceProviderOptions {
  readonly organizationId: OrganizationId;
  readonly region: string;
  readonly organizationName?: string;
  /** Forces multi-page iteration so pagination bugs surface offline. */
  readonly pageSize?: number;
}

type SeededFlow = Omit<FlowDescriptor, 'divisionId' | 'publishedVersion'> &
  Partial<Pick<FlowDescriptor, 'divisionId' | 'publishedVersion'>> & { readonly body?: string };

export class FakeSourceProvider implements GenesysSourceProvider {
  readonly #flows: FlowDescriptor[] = [];
  readonly #bodies = new Map<string, string>();
  readonly #resolutions = new Map<string, DependencyResolution>();

  constructor(private readonly options: FakeSourceProviderOptions) {}

  seedFlow(flow: SeededFlow): void {
    this.#flows.push({
      flowId: flow.flowId,
      name: flow.name,
      type: flow.type,
      divisionId: flow.divisionId ?? null,
      publishedVersion: flow.publishedVersion ?? '1',
    });
    this.#bodies.set(flow.flowId, flow.body ?? `name: ${flow.name}\n`);
  }

  seedDependency(resolution: DependencyResolution): void {
    this.#resolutions.set(`${resolution.ref.type}:${resolution.ref.id}`, resolution);
  }

  validateConnection(): Promise<ConnectionIdentity> {
    return Promise.resolve({
      organizationId: this.options.organizationId,
      organizationName: this.options.organizationName ?? null,
      region: this.options.region,
    });
  }

  async *listFlows(query: FlowDiscoveryQuery): AsyncIterable<FlowDescriptor> {
    const matching = this.#flows.filter(
      (f) => query.flowTypes === undefined || query.flowTypes.includes(f.type),
    );
    const pageSize = (this.options.pageSize ?? matching.length) || 1;
    for (let offset = 0; offset < matching.length; offset += pageSize) {
      // An await between pages makes a consumer that ignores backpressure fail here
      // rather than in production.
      await Promise.resolve();
      yield* matching.slice(offset, offset + pageSize);
    }
  }

  loadFlowSource(ref: FlowVersionRef): Promise<RawFlowSource> {
    const body = this.#bodies.get(ref.flowId);
    if (body === undefined) {
      return Promise.reject(new Error(`FLOW_NOT_FOUND: no seeded flow for the requested id`));
    }
    return Promise.resolve({
      flowId: ref.flowId,
      versionId: ref.versionId ?? asFlowVersionId('1'),
      format: 'yaml',
      body,
    });
  }

  resolveDependencies(refs: readonly DependencyRef[]): Promise<readonly DependencyResolution[]> {
    return Promise.resolve(
      refs.map(
        (ref) =>
          this.#resolutions.get(`${ref.type}:${ref.id}`) ?? {
            ref,
            status: 'not_found' as const,
            displayName: null,
            safeMetadata: {},
          },
      ),
    );
  }
}
