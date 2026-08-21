// packages/capture/src/bundle-writer.ts
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { contentHash, type CanonicalOptions } from '@genesys-archivist/domain';
import { resolveWithinRootReal } from '@genesys-archivist/security';
import { AssetStore, type AssetMeta, type AssetUsage } from '@genesys-archivist/storage';
import type { ResourceGraph, ResourceGraphResult } from './resource-graph.js';

/**
 * Fields excluded from the seal. Signed media URLs are regenerated per
 * request and extraction timestamps change every run; including either in
 * the hash would make every capture appear to differ from the last and
 * report 100% churn forever. `downloadUrl`, `selfUri`, and `dateModified`
 * are the equivalent volatile fields the Platform API attaches to resources
 * -- present-tense metadata about the request that fetched something, not
 * about the thing itself.
 */
export const BUNDLE_CANONICAL: CanonicalOptions = {
  canonicalizerVersion: '1',
  volatileKeys: new Set(['mediaUri', 'extractedAt', 'downloadUrl', 'selfUri', 'dateModified']),
  orderSensitivePaths: new Set(['/graph/edges']),
};

export type VersionSelection = 'published' | 'checked-in' | 'working-copy' | 'published-and-latest';

export type SourceProviderName = 'platform-api' | 'archy-cli' | 'manual-yaml' | 'fixture';

export interface BundleOrganization {
  readonly id: string;
  readonly region: string;
  readonly name?: string;
}

/**
 * Which job this capture was for. See docs/adr/ADR-018-capture-modes.md.
 *
 * 'context' captures flow definitions and the resource manifest that arrives
 * with them, so a developer can understand the flows. It does not walk
 * resources to closure or download assets, and is never migration-ready.
 * 'migration' captures everything needed to recreate the IVRs elsewhere.
 */
export type CaptureMode = 'context' | 'migration';

export interface BundlePolicy {
  /** Required, not optional. An unmarked bundle is exactly the ambiguity this
   * field exists to prevent: no consumer should ever have to infer fitness
   * for migration from a field's absence. */
  readonly mode: CaptureMode;
  readonly versionSelection: VersionSelection;
  readonly captureAssets: boolean;
  readonly captureDataTableRows: boolean;
  readonly flowTypes?: readonly string[];
}

export interface BundleVersions {
  readonly application: string;
  readonly adapter: string;
  readonly sourceProvider: SourceProviderName;
  readonly genesysSdk?: string;
  readonly archy?: string;
}

export interface BundleWriterOptions {
  readonly root: string;
  readonly captureId: string;
  readonly organization: BundleOrganization;
  readonly policy: BundlePolicy;
  readonly versions: BundleVersions;
  readonly now: () => Date;
}

/** The on-disk name for a flow definition of a given format. Exported so the
 * verifier looks for the same file the writer produced, rather than keeping a
 * second copy of this rule that can drift. */
export function definitionFileName(format: 'yaml' | 'json'): string {
  return format === 'json' ? 'definition.json' : 'definition.yaml';
}

export interface FlowMeta {
  readonly id: string;
  readonly type: string;
  /**
   * The serialization the source actually returned.
   *
   * `GenesysSourceProvider` reports this per flow (`RawFlowSource.format`)
   * because it genuinely varies: the Platform API configuration endpoint
   * returns JSON, an Architect export is YAML. Stage 2 must parse the
   * definition to normalize it, and a bundle that does not record the format
   * leaves it guessing — so this is part of the bundle contract, not an
   * implementation detail of whoever wrote it.
   */
  readonly format: 'yaml' | 'json';
}

export interface BundleCounts {
  readonly flows: number;
  readonly resources: number;
  readonly assets: number;
  readonly assetBytes?: number;
  readonly unresolvedReferences: number;
  readonly dataTableRowsCaptured?: number;
}

export interface MigrationReadiness {
  readonly archyImportableYaml: boolean;
  readonly assetsCaptured: boolean;
  readonly caveats?: readonly string[];
}

export interface BundleManifest {
  readonly schemaVersion: '1.2';
  readonly captureId: string;
  readonly sealedAt: string;
  readonly classification: 'restricted';
  readonly organization: BundleOrganization;
  readonly policy: BundlePolicy;
  readonly versions: BundleVersions;
  readonly counts: BundleCounts;
  // Optional because the published schema declares it optional at the top
  // level -- BundleWriter always populates it, but the type should not claim
  // more than the contract it implements.
  readonly migrationReadiness?: MigrationReadiness;
  readonly contentHash: string;
}

export interface SealedBundle {
  readonly captureId: string;
  readonly contentHash: string;
  readonly manifest: BundleManifest;
}

interface FlowRecord {
  readonly flowId: string;
  readonly versionId: string;
  readonly definition: string;
  readonly meta: FlowMeta;
}

interface ResourceRecord {
  readonly category: string;
  readonly id: string;
  readonly body: Record<string, unknown>;
}

interface AssetRecord {
  readonly originalName: string;
  readonly mimeType: string;
  readonly byteLength: number;
  readonly usedBy: AssetUsage[];
}

function pickOrganization(o: BundleOrganization): BundleOrganization {
  return { id: o.id, region: o.region, ...(o.name !== undefined ? { name: o.name } : {}) };
}

function pickPolicy(p: BundlePolicy): BundlePolicy {
  return {
    mode: p.mode,
    versionSelection: p.versionSelection,
    captureAssets: p.captureAssets,
    captureDataTableRows: p.captureDataTableRows,
    ...(p.flowTypes !== undefined ? { flowTypes: p.flowTypes } : {}),
  };
}

function pickVersions(v: BundleVersions): BundleVersions {
  return {
    application: v.application,
    adapter: v.adapter,
    sourceProvider: v.sourceProvider,
    ...(v.genesysSdk !== undefined ? { genesysSdk: v.genesysSdk } : {}),
    ...(v.archy !== undefined ? { archy: v.archy } : {}),
  };
}

const TRUNCATED_CAVEAT =
  'The resource reference walk was truncated: it stopped at the request budget before ' +
  'reaching closure. resource-graph.json is honestly statused for every node it reached, ' +
  'but some references this capture depends on may be missing from it entirely.';

const CONTEXT_MODE_CAVEAT =
  'This bundle was captured in context mode: flow definitions and their resource manifest ' +
  'only. Resource configuration was not fetched and assets were not downloaded, so it ' +
  'documents these flows but cannot be migrated. Recapture in migration mode to move them.';

const ASSETS_NOT_CAPTURED_CAVEAT =
  'Prompt and response assets were not captured, by policy. A migration target will need ' +
  'audio supplied separately; none is present in this bundle.';

/**
 * Accumulates everything one capture run writes about a Genesys
 * organization, then seals it: hashes the accumulated content (excluding
 * volatile fields) and writes `bundle-manifest.json`.
 *
 * Every write resolves through `resolveWithinRootReal`. `root` is a locally
 * chosen output directory, not attacker input, but resolving through the
 * real, symlink-followed path is cheap and this is exactly the kind of place
 * a shortcut here would be regretted later.
 *
 * This class does not stage or atomically promote its own output -- it
 * writes directly under `root`. A caller that needs the bundle as a whole to
 * appear atomically (the release-gate requirement that a failed run must
 * never disturb the last known-good bundle) is expected to pass a staging
 * directory as `root` and promote it as a unit once `seal()` resolves; nesting
 * `@genesys-archivist/storage`'s staging directory for a run *inside* the same
 * `root` this class writes into and then promoting `root` onto itself is not
 * reachable -- `promote` moves the target directory aside before moving staged
 * content into place, which would move the very staging directory in flight.
 */
export class BundleWriter {
  readonly #root: string;
  readonly #captureId: string;
  readonly #organization: BundleOrganization;
  readonly #policy: BundlePolicy;
  readonly #versions: BundleVersions;
  readonly #now: () => Date;

  readonly #flows = new Map<string, FlowRecord>();
  readonly #resources = new Map<string, ResourceRecord>();
  readonly #assets = new Map<string, AssetRecord>();
  #assetByteTotal = 0;
  #assetStorePromise: Promise<AssetStore> | undefined;
  #graph: ResourceGraph | undefined;
  #truncated = false;

  constructor(options: BundleWriterOptions) {
    this.#root = options.root;
    this.#captureId = options.captureId;
    this.#organization = pickOrganization(options.organization);
    this.#policy = pickPolicy(options.policy);
    this.#versions = pickVersions(options.versions);
    this.#now = options.now;
  }

  async writeFlow(
    flowId: string,
    versionId: string,
    definition: string,
    flowMeta: FlowMeta,
  ): Promise<void> {
    this.#flows.set(`${flowId}:${versionId}`, {
      flowId,
      versionId,
      definition,
      meta: flowMeta,
    });
    // The extension follows the real format. Writing JSON into a file named
    // definition.yaml was how the format got lost between the two stages:
    // capture stored whatever the provider returned, the name said otherwise,
    // and Stage 2 had nothing to go on.
    await this.#writeText(
      ['flows', flowId, 'versions', versionId, definitionFileName(flowMeta.format)],
      definition,
    );
    await this.#writeJson(['flows', flowId, 'flow.json'], flowMeta);
  }

  async writeResource(category: string, id: string, body: Record<string, unknown>): Promise<void> {
    this.#resources.set(`${category}:${id}`, { category, id, body });
    await this.#writeJson(['resources', category, `${id}.json`], body);
  }

  async putAsset(bytes: Uint8Array, meta: AssetMeta): Promise<string> {
    const store = await this.#ensureAssetStore();
    const address = await store.put(bytes, meta);
    let entry = this.#assets.get(address);
    if (entry === undefined) {
      entry = {
        originalName: meta.originalName,
        mimeType: meta.mimeType,
        byteLength: bytes.byteLength,
        usedBy: [],
      };
      this.#assets.set(address, entry);
      this.#assetByteTotal += bytes.byteLength;
    }
    entry.usedBy.push(meta.usedBy);
    return address;
  }

  async writeResourceGraph(result: ResourceGraphResult): Promise<void> {
    this.#graph = result.graph;
    this.#truncated = result.truncated;
    await this.#writeJson(['resource-graph.json'], {
      schemaVersion: '1.0',
      captureId: this.#captureId,
      nodes: result.graph.nodes,
      edges: result.graph.edges,
      orphans: result.graph.orphans,
    });
  }

  async seal(): Promise<SealedBundle> {
    const record = {
      flows: [...this.#flows.values()],
      resources: [...this.#resources.values()],
      graph: this.#graph ?? null,
      // Bare hex, matching `assets/index.json`'s own keys.
      //
      // This map is keyed by the *address* `putAsset` returns ("sha256:<hex>"),
      // because that is the form a caller references an asset by. The verifier
      // can only reconstruct what is on disk, and the index is keyed by bare
      // hex -- so hashing the address here made every bundle containing an
      // asset fail its own verification. Migration bundles never verified.
      //
      // It went unnoticed because the verifier's own tests seal bundles with no
      // assets in them, where the two forms never meet.
      assets: [...this.#assets.entries()].map(([address, asset]) => ({
        digest: address.startsWith('sha256:') ? address.slice('sha256:'.length) : address,
        ...asset,
      })),
    };
    const hash = contentHash(record, BUNDLE_CANONICAL);

    const unresolvedReferences = this.#graph
      ? this.#graph.nodes.filter((node) => node.resolutionStatus !== 'resolved').length
      : 0;

    const caveats: string[] = [];
    if (this.#truncated) caveats.push(TRUNCATED_CAVEAT);
    if (!this.#policy.captureAssets) caveats.push(ASSETS_NOT_CAPTURED_CAVEAT);
    if (this.#policy.mode === 'context') caveats.push(CONTEXT_MODE_CAVEAT);

    const counts: BundleCounts = {
      flows: this.#flows.size,
      resources: this.#resources.size,
      assets: this.#assets.size,
      unresolvedReferences,
      ...(this.#assets.size > 0 ? { assetBytes: this.#assetByteTotal } : {}),
    };

    // What could not be read, and of what kinds.
    //
    // A reference this capture could not resolve is a resource a migration
    // would have to recreate from nothing. Naming the types matters more than
    // the count: "520 unresolved" is alarming and useless, while "nluDomain,
    // knowledgeBase, contactList" tells a migration engineer exactly which
    // parts of the estate this bundle cannot carry.
    const unresolvedTypes = [
      ...new Set(
        (this.#graph?.nodes ?? [])
          .filter((node) => node.resolutionStatus !== 'resolved')
          .map((node) => node.type),
      ),
    ].sort();

    if (unresolvedReferences > 0 && this.#policy.mode === 'migration') {
      caveats.push(
        `${String(unresolvedReferences)} referenced resource(s) could not be read, across ` +
          `${String(unresolvedTypes.length)} type(s): ${unresolvedTypes.join(', ')}. ` +
          'A migration target will need these recreated by hand; they are not in this bundle.',
      );
    }

    const migrationReadiness: MigrationReadiness = {
      // Migration-ready means every referenced resource was actually read.
      //
      // This used to be `mode === 'migration' && flows > 0` -- mode and a
      // count, nothing about whether the capture succeeded at reading what the
      // flows point at. A whole-organization run then stamped itself
      // importable while 520 references across 39 resource types had resolved
      // `unsupported`, because this adapter has no reader for them. That is
      // the bundle claiming a capability it does not have, which is exactly
      // what ADR-018's readiness flags exist to prevent.
      //
      // It went unnoticed because the only migration bundle ever built by hand
      // held one flow with three unresolved references, and nobody read the
      // flag against them.
      archyImportableYaml:
        this.#policy.mode === 'migration' && this.#flows.size > 0 && unresolvedReferences === 0,
      assetsCaptured: this.#policy.captureAssets,
      ...(caveats.length > 0 ? { caveats } : {}),
    };

    const manifest: BundleManifest = {
      schemaVersion: '1.2',
      captureId: this.#captureId,
      sealedAt: this.#now().toISOString(),
      classification: 'restricted',
      organization: this.#organization,
      policy: this.#policy,
      versions: this.#versions,
      counts,
      migrationReadiness,
      contentHash: hash,
    };

    if (this.#assetStorePromise !== undefined) {
      await (await this.#assetStorePromise).writeIndex();
    }
    await this.#writeJson(['bundle-manifest.json'], manifest);

    return { captureId: this.#captureId, contentHash: hash, manifest };
  }

  async #ensureAssetStore(): Promise<AssetStore> {
    this.#assetStorePromise ??= (async () => {
      const dir = await resolveWithinRootReal(this.#root, ['assets']);
      return new AssetStore(dir);
    })();
    return this.#assetStorePromise;
  }

  async #writeJson(segments: readonly string[], value: unknown): Promise<void> {
    const path = await resolveWithinRootReal(this.#root, segments);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
  }

  async #writeText(segments: readonly string[], value: string): Promise<void> {
    const path = await resolveWithinRootReal(this.#root, segments);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, value, 'utf8');
  }
}
