// packages/genesys-source/src/platform-source-provider.ts
//
// The production implementation of `GenesysSourceProvider`
// (packages/domain/src/source-provider.ts). Every method here is read-only
// by construction: the only thing it can do to Genesys is issue a GET,
// because that is all `PlatformApiClient` (ADR-019) can do.
import {
  asFlowId,
  asFlowVersionId,
  asOrganizationId,
  type ConnectionIdentity,
  type DependencyRef,
  type DependencyResolution,
  type FlowDescriptor,
  type FlowDiscoveryQuery,
  type FlowVersionRef,
  type GenesysSourceProvider,
  type ProfileId,
  type RawFlowSource,
} from '@genesys-archivist/domain';
import type { Logger } from '@genesys-archivist/observability';
import {
  PlatformApiClient,
  PlatformApiError,
  createTokenProvider,
  getFlow,
  getFlowLatestConfiguration,
  getFlowVersionConfiguration,
  getFlowVersions,
  getFlows,
  getIvrs,
  getOrganizationsMe,
  permissionForOperation,
  resolveRegion,
  type FlowConfiguration,
  type FetchLike,
  type PlatformOperation,
  type SleepLike,
} from '@genesys-archivist/genesys-platform';
import type { SecretStore } from '@genesys-archivist/security';
import { extractManifestReferences } from './manifest.js';
import { createResourceReaders, unsupportedResolution } from './resource-readers.js';

/** Simple bounded, insertion-order-evicting cache. Flow configurations can
 * run to hundreds of kilobytes each and an org-wide run can touch hundreds
 * of flows, so this must never grow without bound -- but it also must not
 * be a strict LRU with per-read bookkeeping cost, because it exists purely
 * to make `resolveDependencies` free immediately after `loadFlowSource` for
 * the same flow, not to serve as a general-purpose store. */
class BoundedCache<K, V> {
  readonly #map = new Map<K, V>();
  constructor(private readonly limit: number) {}

  get(key: K): V | undefined {
    return this.#map.get(key);
  }

  set(key: K, value: V): void {
    this.#map.delete(key);
    this.#map.set(key, value);
    if (this.#map.size > this.limit) {
      const oldest = this.#map.keys().next();
      if (!oldest.done) this.#map.delete(oldest.value);
    }
  }
}

/** Bounds how many manifest references this adapter resolves concurrently.
 * AGENTS.md requires bounded concurrency on every external call; a flow
 * with a very large manifest (or a whole-org resource-graph batch) must not
 * turn into an unbounded burst of simultaneous requests. */
const RESOLVE_CONCURRENCY = 8;

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      const item = items[index] as T;
      results[index] = await fn(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

const FLOW_CONFIG_CACHE_LIMIT = 32;

export interface MissingPermission {
  readonly operation: PlatformOperation;
  readonly permission: string;
  readonly status: number;
}

export class PlatformSourceProvider implements GenesysSourceProvider {
  readonly #client: PlatformApiClient;
  readonly #regionKey: string;
  readonly #logger: Logger | undefined;
  readonly #readers: ReadonlyMap<string, (id: string) => Promise<DependencyResolution>>;
  /**
   * Languages declared by the flows this provider has loaded.
   *
   * A Genesys system prompt carries every locale Genesys supports -- 477 on a
   * real tenant -- while a flow typically declares one. Without this, a
   * single-flow migration capture downloaded all 477 and took 259 seconds
   * instead of four, for 476 files nothing would ever play.
   */
  readonly #languagesInUse = new Set<string>();

  /** Keyed `flowId:versionId` -> the configuration body. */
  readonly #flowConfigCache = new BoundedCache<string, FlowConfiguration>(FLOW_CONFIG_CACHE_LIMIT);
  /** Keyed `flowId` -> the version `loadFlowSource` most recently resolved
   * for it, so a same-flow `resolveDependencies({type:'flow', id: flowId})`
   * call right after -- the `capture-run.ts` self-ref convention -- costs
   * zero extra requests, per this task's brief. */
  readonly #flowSelfCache = new BoundedCache<
    string,
    { versionId: string; configuration: FlowConfiguration }
  >(FLOW_CONFIG_CACHE_LIMIT);

  constructor(client: PlatformApiClient, regionKey: string, logger?: Logger) {
    this.#client = client;
    this.#regionKey = regionKey;
    this.#logger = logger;
    // The readers ask, at download time, which languages are worth fetching.
    // A closure rather than a value because flows are loaded before their
    // resources are resolved, so the set is not known when the readers are
    // built -- only by the time one of them needs it.
    this.#readers = createResourceReaders(client, () =>
      this.#languagesInUse.size > 0 ? this.#languagesInUse : null,
    );
  }

  async validateConnection(): Promise<ConnectionIdentity> {
    const org = await getOrganizationsMe(this.#client);
    return {
      organizationId: asOrganizationId(org.id),
      organizationName: org.name ?? null,
      region: this.#regionKey,
    };
  }

  /**
   * Best-effort permission-gap report for `doctor`/`connection_check`,
   * separate from `validateConnection` so a caller that only needs identity
   * never pays for these extra probes. Reports only permission categories
   * this adapter *positively observed* as missing (a 403 mapped through
   * `permissions.ts`) -- a probe that fails for any other reason (network,
   * rate limit, a schema mismatch) is not evidence of anything and is not
   * reported as a gap, per AGENTS.md's rule against presenting inference as
   * fact. See `permissions.ts`'s header comment: this table is the
   * *expected* mapping, not one verified endpoint-by-endpoint
   * (`docs/spikes/S4-permission-matrix.md`).
   */
  async checkPermissions(): Promise<readonly MissingPermission[]> {
    const probes: {
      readonly operation: PlatformOperation;
      readonly run: () => Promise<unknown>;
    }[] = [
      {
        operation: 'flows.list',
        run: () => getFlows(this.#client, { pageNumber: 1, pageSize: 1 }),
      },
      {
        operation: 'architect.ivrs.list',
        run: () => getIvrs(this.#client, { pageNumber: 1, pageSize: 1 }),
      },
    ];
    const missing: MissingPermission[] = [];
    for (const probe of probes) {
      try {
        await probe.run();
      } catch (err) {
        if (err instanceof PlatformApiError && err.category === 'permission') {
          const permission = permissionForOperation(probe.operation);
          if (permission !== null)
            missing.push({ operation: probe.operation, permission, status: err.status });
        }
      }
    }
    return missing;
  }

  /**
   * Pages through `/flows` to termination. Trusts `pageCount` when the
   * server reports one; falls back to an empty batch as the terminator.
   * Guards against two distinct failure shapes a malformed or looping
   * server could produce: a page count that never arrives (bounded by
   * `MAX_PAGES`) and a server that keeps returning the *same* content
   * regardless of the requested page (detected by comparing each page's
   * entity-id signature to the previous one).
   *
   * S2's unfiltered-walk finding governs the default here: when the caller
   * supplies no `flowTypes`, this issues no `type` filter at all, so the
   * server -- not a local list -- is the authority on which types exist.
   */
  async *listFlows(query: FlowDiscoveryQuery): AsyncIterable<FlowDescriptor> {
    const MAX_PAGES = 5_000;
    const PAGE_SIZE = 100;
    let pageNumber = 1;
    let previousSignature: string | null = null;

    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await getFlows(this.#client, {
        ...(query.flowTypes !== undefined ? { type: query.flowTypes } : {}),
        ...(query.divisionIds !== undefined ? { divisionId: query.divisionIds } : {}),
        pageNumber,
        pageSize: PAGE_SIZE,
      });
      const entities = result.entities;
      if (entities.length === 0) return;

      const signature = `${String(entities.length)}:${entities[0]?.id ?? ''}:${entities[entities.length - 1]?.id ?? ''}`;
      if (signature === previousSignature) {
        this.#logger?.warn('platform_pagination_stalled', { endpoint: 'flows.list', pageNumber });
        return;
      }
      previousSignature = signature;

      for (const flow of entities) {
        yield {
          flowId: asFlowId(flow.id),
          name: flow.name,
          type: flow.type.toLowerCase(),
          divisionId: flow.division?.id ?? null,
          publishedVersion: flow.publishedVersion?.id ?? null,
        };
      }

      const pageCount = result.pageCount;
      if (typeof pageCount === 'number' && pageNumber >= pageCount) return;
      pageNumber += 1;
    }
    this.#logger?.warn('platform_pagination_max_pages_reached', { endpoint: 'flows.list' });
  }

  async loadFlowSource(ref: FlowVersionRef): Promise<RawFlowSource> {
    const { versionId, configuration } = await this.#resolveFlowConfig(ref.flowId, ref.versionId);
    return {
      flowId: ref.flowId,
      versionId: asFlowVersionId(versionId),
      format: 'json',
      body: JSON.stringify(configuration),
    };
  }

  /**
   * The seam this task exists to get exactly right (see `capture-run.ts`'s
   * ADR-018 modeling-note comment). A `{type:'flow', id}` ref resolves to a
   * resolution whose `safeMetadata.references` is the flow's manifest,
   * flattened generically by `manifest.ts`. Every other type is dispatched
   * through `resource-readers.ts`'s registry, or reported `unsupported` if
   * this adapter has never learned to read it.
   */
  /**
   * Notes the languages a flow declares, so prompt audio can be narrowed to
   * them at download time.
   *
   * `supportedLanguages` is the authority; `defaultLanguage` is included too
   * because a flow can play its default without listing it. Lower-cased
   * because Genesys is inconsistent across the two: a flow configuration says
   * "en-US", a prompt resource says "en-us".
   */
  #recordLanguages(configuration: unknown): void {
    if (typeof configuration !== 'object' || configuration === null) return;
    const record = configuration as Record<string, unknown>;
    const supported = record['supportedLanguages'];
    if (Array.isArray(supported)) {
      for (const entry of supported) {
        if (typeof entry === 'string' && entry.length > 0) {
          this.#languagesInUse.add(entry.toLowerCase());
        }
      }
    }
    const fallback = record['defaultLanguage'];
    if (typeof fallback === 'string' && fallback.length > 0) {
      this.#languagesInUse.add(fallback.toLowerCase());
    }
  }

  async resolveDependencies(
    refs: readonly DependencyRef[],
  ): Promise<readonly DependencyResolution[]> {
    return mapWithConcurrency(refs, RESOLVE_CONCURRENCY, async (ref) => {
      if (ref.type === 'flow') return this.#resolveFlowRef(ref);
      const reader = this.#readers.get(ref.type);
      if (reader === undefined) return unsupportedResolution(ref);
      return reader(ref.id);
    });
  }

  async #resolveFlowRef(ref: DependencyRef): Promise<DependencyResolution> {
    const cached = this.#flowSelfCache.get(ref.id);
    const { configuration } = cached ?? (await this.#resolveFlowConfig(asFlowId(ref.id), null));
    const { references, warnings } = extractManifestReferences(configuration);
    for (const warning of warnings) {
      this.#logger?.warn('manifest_entry_missing_id', { manifestType: warning.manifestType });
    }
    return {
      ref,
      status: 'resolved',
      displayName: configuration.name ?? null,
      safeMetadata: { references },
    };
  }

  /**
   * Resolves and caches a flow's configuration. `versionId === null` means
   * "whatever the version policy resolves to" (the domain interface's own
   * wording): the published version when the flow has one.
   *
   * When a flow has no published version at all, there is no field in the
   * configuration response itself that names which version
   * `getFlowLatestconfiguration` returned (checked directly against
   * `fixtures/flow-config/inboundcall-47-nodes.json`: no top-level `id` or
   * version marker). This falls back to the highest numeric version id
   * `GET /flows/{flowId}/versions` reports as a best-effort label for what
   * was actually captured -- documented here as a heuristic, not asserted
   * as certain, per AGENTS.md's rule against presenting inference as fact.
   * It only applies to flows with no published version, which is the rare
   * case in practice.
   */
  async #resolveFlowConfig(
    flowId: string,
    versionId: string | null,
  ): Promise<{ versionId: string; configuration: FlowConfiguration }> {
    if (versionId !== null) {
      const cacheKey = `${flowId}:${versionId}`;
      const cached = this.#flowConfigCache.get(cacheKey);
      if (cached !== undefined) {
        this.#recordLanguages(cached);
        this.#flowSelfCache.set(flowId, { versionId, configuration: cached });
        return { versionId, configuration: cached };
      }
      const configuration = await getFlowVersionConfiguration(this.#client, flowId, versionId);
      this.#flowConfigCache.set(cacheKey, configuration);
      this.#recordLanguages(configuration);
      this.#flowSelfCache.set(flowId, { versionId, configuration });
      return { versionId, configuration };
    }

    const flow = await getFlow(this.#client, flowId);
    if (flow.publishedVersion?.id !== undefined) {
      return this.#resolveFlowConfig(flowId, flow.publishedVersion.id);
    }

    const configuration = await getFlowLatestConfiguration(this.#client, flowId);
    const resolvedVersionId = await this.#bestEffortLatestVersionId(flowId);
    this.#flowConfigCache.set(`${flowId}:${resolvedVersionId}`, configuration);
    this.#recordLanguages(configuration);
    this.#flowSelfCache.set(flowId, { versionId: resolvedVersionId, configuration });
    return { versionId: resolvedVersionId, configuration };
  }

  async #bestEffortLatestVersionId(flowId: string): Promise<string> {
    const page = await getFlowVersions(this.#client, flowId, { pageNumber: 1, pageSize: 100 });
    let best: string | null = null;
    let bestNumeric = -Infinity;
    for (const version of page.entities) {
      const numeric = Number(version.id);
      if (Number.isFinite(numeric) && numeric > bestNumeric) {
        bestNumeric = numeric;
        best = version.id;
      } else if (best === null) {
        best = version.id;
      }
    }
    return best ?? 'unknown';
  }
}

export interface CreatePlatformSourceProviderOptions {
  readonly region: string;
  readonly clientId: string;
  readonly secretStore: SecretStore;
  readonly profileId: ProfileId;
  readonly fetch: FetchLike;
  readonly now?: () => Date;
  readonly sleep?: SleepLike;
  readonly logger?: Logger;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function createPlatformSourceProvider(
  options: CreatePlatformSourceProviderOptions,
): PlatformSourceProvider {
  const region = resolveRegion(options.region);
  const now = options.now ?? ((): Date => new Date());
  const tokenProvider = createTokenProvider({
    loginHost: region.loginHost,
    clientId: options.clientId,
    secretStore: options.secretStore,
    profileId: options.profileId,
    fetch: options.fetch,
    now,
  });
  const client = new PlatformApiClient({
    apiHost: region.apiHost,
    tokenProvider,
    fetch: options.fetch,
    sleep: options.sleep ?? defaultSleep,
    now,
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  });
  return new PlatformSourceProvider(client, region.key, options.logger);
}
