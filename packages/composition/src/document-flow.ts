// packages/composition/src/document-flow.ts
import { analyzeFlow, type Finding } from '@genesys-archivist/analysis';
import {
  buildDiagrams,
  renderBusiness,
  renderOperations,
  renderTechnical,
} from '@genesys-archivist/documentation';
import {
  normalizeFlow,
  type FlowSnapshot,
  type SourceMetadata,
} from '@genesys-archivist/normalization';
import { safeSegment } from '@genesys-archivist/security';

/**
 * Everything `runDocument` needs, supplied by the caller.
 *
 * `config` is `unknown` on purpose. It arrives from a capture bundle written
 * by Stage 1 or from a fixture, and per AGENTS.md every byte of it is
 * untrusted data. `normalizeFlow` is the validating boundary; nothing here
 * reads a field off it directly.
 */
export interface DocumentDeps {
  readonly config: unknown;
  readonly flowId: string;
  readonly flowName: string;
  readonly flowType: string;
  readonly version: string;
  readonly organizationId: string;
  readonly region: string;
  /** Injected so a generated document is byte-identical across runs. */
  readonly generatedAt: string;
  readonly provider?: SourceMetadata['provider'];
  readonly adapterVersion?: string;
  readonly maxDiagramNodes?: number;
}

export interface DocumentResult {
  /**
   * Relative path to file contents.
   *
   * Writing is deliberately **not** done here. AGENTS.md forbids overwriting
   * last known-good output in place, so promotion is a staged, atomic step
   * owned by the storage layer. Returning a map keeps this function pure,
   * keeps its tests filesystem-free, and keeps a half-finished render from
   * ever reaching a directory a reader might be looking at.
   */
  readonly files: Readonly<Record<string, string>>;
  readonly findings: readonly Finding[];
  readonly snapshot: FlowSnapshot;
}

const DOCUMENT_SET_VERSION = '0.1.0';

/**
 * Normalize, analyze, render. The whole Stage 2 pipeline for one flow.
 *
 * Synchronous on purpose. Stage 2 opens no socket, and this function writes
 * no file, so a `Promise`-returning signature would advertise I/O the design
 * forbids. Callers that `await` the result still work unchanged.
 *
 * It lives in the composition root rather than in `apps/cli`, where Plan 4
 * put it, because the dependency rule keeps normalization, analysis and
 * documentation out of an app's reach — apps import `application` and
 * `composition` only. Wiring three packages together is exactly this
 * package's job, and the CLI command is a thin delegate over it.
 */
export function runDocument(deps: DocumentDeps): DocumentResult {
  const snapshot = normalizeFlow({
    config: deps.config,
    source: {
      provider: deps.provider ?? 'platform-api',
      adapterVersion: deps.adapterVersion ?? DOCUMENT_SET_VERSION,
      extractedAt: deps.generatedAt,
      region: deps.region,
      organizationId: deps.organizationId,
      trackingIdsAvailable: true,
      redactionApplied: true,
    },
    flow: {
      id: deps.flowId,
      name: deps.flowName,
      type: deps.flowType,
      secure: false,
      version: { selected: deps.version, state: 'published' },
    },
  });

  const analysis = analyzeFlow(snapshot);
  const ctx = { generatedAt: deps.generatedAt };

  const files: Record<string, string> = {};

  // Insertion order is the map's key order, and the determinism test compares
  // serialized maps — so this sequence is part of the contract, not incidental.
  files['business.md'] = renderBusiness(snapshot, analysis, ctx);
  files['technical.md'] = renderTechnical(snapshot, analysis, ctx);
  files['operations.md'] = renderOperations(snapshot, analysis, ctx);

  const diagramOptions =
    deps.maxDiagramNodes === undefined ? undefined : { maxNodes: deps.maxDiagramNodes };
  const diagrams = [...buildDiagrams(snapshot, analysis, diagramOptions)].sort((a, b) =>
    a.id.localeCompare(b.id),
  );

  // `buildDiagrams` mints synthetic ids (`flow`, `diagram-3-part-2`), so no
  // tenant text reaches a path here today. It still goes through safeSegment:
  // a path builder that is only safe because of what its caller happens to
  // pass is one refactor away from a traversal.
  for (const diagram of diagrams) {
    files[`diagrams/${safeSegment(diagram.id)}.mmd`] = diagram.mermaid;
  }

  // The documents cite evidence ids. Without the snapshot alongside them a
  // reader has no way to resolve a citation, which would make the evidence
  // model decorative.
  files['flow-snapshot.json'] = `${JSON.stringify(snapshot, null, 2)}\n`;

  return { files, findings: analysis.findings, snapshot };
}
