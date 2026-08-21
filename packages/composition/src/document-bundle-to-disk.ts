// packages/composition/src/document-bundle-to-disk.ts
//
// `documentBundle` (document-bundle.ts) turns a sealed capture bundle into a
// documentation set held entirely in memory -- it opens no socket and
// writes no file, by design (see its own doc comment). Something has to
// actually put that output on disk, obeying AGENTS.md's rule 4: never
// overwrite the last known-good documentation set in place. This is that
// something, shared by `archivist-port.ts`'s `startRun` and (per
// `apps/cli/src/bin.ts`'s `archivist document` command) the CLI, so the
// write-and-promote path exists exactly once.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { contentHash, type CanonicalOptions } from '@genesys-archivist/domain';

import { createStaging, promote } from '@genesys-archivist/storage';
import { createRenderer, type RendererBundle } from '@genesys-archivist/rendering';
import { analyzeFlow, type FlowAnalysis } from '@genesys-archivist/analysis';
import type { FlowSnapshot } from '@genesys-archivist/normalization';
import {
  buildEvidencePack,
  runNarrationQueue,
  type EvidencePackSnapshot,
  type NarrationJob,
  type NarrationProvider,
  type ValidationPolicy,
} from '@genesys-archivist/narrative';
import { documentBundle, type DocumentedFlow, type UndocumentedFlow } from './document-bundle.js';
import {
  createInMemoryNarrationJournal,
  type NarrationContentJournal,
} from './narration-journal.js';
import { renderNarrative } from './render-narrative.js';

/** Canonicalization for the written document set's content hash. Reuses
 * `packages/domain/src/canonical.ts`'s `contentHash` rather than a second
 * canonicalizer -- see `packages/capture/src/bundle-writer.ts`'s
 * `BUNDLE_CANONICAL` for the standing rule this follows. Nothing hashed here
 * is volatile or order-sensitive: the rendered files are a flat path ->
 * text map, not a sequence. */
const DOCUMENT_SET_CANONICAL: CanonicalOptions = {
  canonicalizerVersion: '1',
  volatileKeys: new Set(),
  orderSensitivePaths: new Set(),
};

export interface DocumentBundleToDiskOptions {
  readonly bundleDir: string;
  /** The profile's output root. Documents are written to
   * `<outputRoot>/documents`, alongside `<outputRoot>/bundle` (Stage 1's own
   * output) and `<outputRoot>/.archivist` (run manifests, locks, staging). */
  readonly outputRoot: string;
  readonly generatedAt: string;
  /**
   * Injected so this stays testable with no browser, and so a caller that
   * already knows one is unavailable can pass the degraded pair rather than
   * paying for a probe. Omitted, a real renderer is created and falls back to
   * the null pair if Playwright's browser is missing.
   */
  readonly renderer?: RendererBundle;
  /**
   * Render each Mermaid source to a sibling `.svg`. **Off by default.**
   *
   * Rendering launches a headless browser and draws every diagram: roughly
   * eleven per flow, so a 502-flow organization is ~5,500 renders and tens of
   * minutes. Documenting the same organization takes seconds. Tying the two
   * together meant nobody could have the fast one.
   *
   * The `.mmd` sources are always written, so rendering can be done later
   * against an existing documents tree -- see `archivist render`.
   */
  readonly renderDiagrams?: boolean;
  readonly organizationId?: string;
  readonly region?: string;
  /**
   * Also produce an AI-narrated `narrative.md` alongside each flow's
   * deterministic documents. **Off by default** -- the deterministic path
   * (`business.md`, `technical.md`, `operations.md`) is what a plain call
   * produces, exactly as `renderDiagrams` above is: this is a second,
   * independent opt-in, not a mode switch on the first one.
   *
   * A failure to narrate never loses the deterministic documents: this
   * function still writes and promotes them even if every narration job
   * fails outright (see `narration.failed` on the result, and the
   * per-flow warning it carries).
   */
  readonly narrate?: boolean;
  /** Required when `narrate` is `true`. `@genesys-archivist/narrative` opens
   * no socket of its own (see that package's narration-provider.ts header);
   * this is where the real model call is injected --
   * `createAnthropicNarrationProvider` (narration-provider.ts) for a real
   * run, a `ScriptedNarrationProvider` for a test. There is deliberately no
   * silent fallback to `NullNarrationProvider` here: a caller that asked for
   * narration and forgot to wire a provider should see a clear error, not a
   * narration step that quietly did nothing. */
  readonly narrationProvider?: NarrationProvider;
  /** Where the resumable narration queue persists what it has already
   * narrated, keyed on each flow's evidence-pack content hash (see
   * `@genesys-archivist/narrative`'s work-queue.ts). Defaults to an
   * in-memory journal (`createInMemoryNarrationJournal`) that does not
   * survive past this process -- a caller that wants a re-run in a later
   * process to skip unchanged flows supplies `createFileNarrationJournal`
   * explicitly (`apps/cli/src/bin.ts` always does). */
  readonly narrationJournal?: NarrationContentJournal;
  /** Overrides `@genesys-archivist/narrative`'s `DEFAULT_VALIDATION_POLICY`
   * for the grounding validator every narration claim passes through. */
  readonly narrationPolicy?: ValidationPolicy;
}

/** What one `documentBundleToDisk` call's opt-in narration step did, across
 * every flow it attempted. Modeled on `skipped` above: reported, never
 * silently folded away -- a rejected claim or a failed provider call is as
 * much a fact about this run as a flow this run could not document at all. */
export interface NarrationBundleReport {
  /** Jobs this call actually called the narration provider for (whether
   * they then completed or failed) -- never counts a job the resumable
   * queue skipped as unchanged. */
  readonly attempted: number;
  /** Jobs that completed a provider call and produced at least a validated,
   * possibly empty, set of sections. */
  readonly narrated: number;
  /** Jobs the resumable queue skipped because an unchanged evidence pack
   * for this flow was already narrated in a prior run. */
  readonly skipped: number;
  /** Jobs whose provider call itself threw. */
  readonly failed: number;
  readonly acceptedClaims: number;
  readonly rejectedClaims: number;
  /** Rejection counts by `RejectionCode` (packages/narrative/src/claim-validator.ts),
   * summed across every flow this call narrated. */
  readonly rejectionsByCode: Readonly<Record<string, number>>;
  /** One line per flow that needs a human's attention: a provider failure,
   * or previously narrated content this run could not locate to reuse. */
  readonly warnings: readonly string[];
}

export interface DocumentBundleToDiskResult {
  readonly documentsWritten: number;
  /** How many Mermaid sources became a real .svg. */
  readonly diagramsRendered: number;
  /** True if any diagram could not be rendered -- typically no browser. */
  readonly rendererDegraded: boolean;
  /** Flows the bundle held that produced no documentation. Reported, never
   * omitted -- see `documentBundle`'s own `skipped` field for why. */
  readonly skipped: readonly UndocumentedFlow[];
  readonly outputDir: string;
  /** Content hash of exactly what this call wrote (`result.files`, before
   * merging with anything already on disk) -- not a hash of the whole
   * promoted `documents` tree, which may also hold untouched output from
   * earlier runs this call never read the content of. */
  readonly contentHash: string;
  /** Present only when `options.narrate` was `true`. */
  readonly narration?: NarrationBundleReport;
}

/** Reconstructs the on-disk document tree into a flat map of relative path
 * -> contents, so a call that only (re)documents *some* flows can merge its
 * new output over the existing tree before promoting. Promoting the freshly
 * staged files alone would silently delete every other flow's last
 * known-good documentation -- the same "overwrite in place" AGENTS.md
 * forbids, just at directory rather than single-file granularity. */
async function collectExistingDocuments(documentsDir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function walk(dir: string, prefix: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // No prior documents directory: nothing to merge, first run.
    }
    for (const entry of entries) {
      const relPath = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(join(dir, entry.name), relPath);
      } else {
        try {
          out.set(relPath, await readFile(join(dir, entry.name), 'utf8'));
        } catch {
          // Vanished or became unreadable mid-walk: excluded from the merge
          // rather than failing the whole write over one stray file.
        }
      }
    }
  }
  await walk(documentsDir, '');
  return out;
}

// ---------------------------------------------------------------------------
// Narration wiring. Wired here, not in document-bundle.ts, on purpose: that
// module's own header states "Opens no socket. Stage 2 never does" -- true
// of the deterministic pipeline, and this function is where the one
// deliberate, opt-in exception (AGENTS.md: "AI narration in the middle")
// lives, exactly as diagram rendering above is wired here rather than in
// document-bundle.ts. `documentBundle` stays fully offline; only a caller
// that explicitly sets `narrate: true` ever causes a network call, and only
// through the `NarrationProvider` it supplies.
// ---------------------------------------------------------------------------

/** The evidence id that grounds this flow's own top-level fields (name,
 * description). Mirrors `packages/normalization/src/evidence.ts`'s
 * `flowLevelEvidence`, which always records the flow's `/name` field as its
 * own evidence entry -- this looks that entry back up rather than
 * re-deriving or guessing an id, so the pack cites exactly the evidence id
 * normalization itself minted. Falls back to any evidence id in the
 * snapshot (and, failing that, the snapshot id itself) only as a last
 * resort for a hand-built snapshot that skipped normalization entirely; a
 * pointer to real evidence-pack.ts code, `buildEvidencePack`'s own
 * dangling-evidence-id cross-check, drops a fabricated id from the pack
 * rather than trusting it, so a bad fallback here cannot smuggle anything
 * unsafe through.
 */
function flowLevelEvidenceId(snapshot: FlowSnapshot): string {
  const match = snapshot.evidence.find((e) => e.field === 'name' && e.sourcePointer === '/name');
  if (match !== undefined) return match.evidenceId;
  return snapshot.evidence[0]?.evidenceId ?? snapshot.snapshotId;
}

/** Builds the structural minimum `buildEvidencePack` (`@genesys-archivist/narrative`)
 * needs, from a `FlowSnapshot` plus the `FlowAnalysis` computed over it.
 * `analyzeFlow` is pure and deterministic -- recomputing it here (rather
 * than threading `document-flow.ts`'s own analysis result through
 * `document-bundle.ts`) costs nothing beyond CPU and keeps `DocumentedFlow`
 * (document-bundle.ts) carrying only the one extra field narration actually
 * needs: the snapshot. */
function toEvidencePackSnapshot(
  snapshot: FlowSnapshot,
  analysis: FlowAnalysis,
): EvidencePackSnapshot {
  return {
    snapshotId: snapshot.snapshotId,
    flow: {
      name: snapshot.flow.name,
      type: snapshot.flow.type,
      ...(snapshot.flow.description !== undefined
        ? { description: snapshot.flow.description }
        : {}),
      flowEvidenceId: flowLevelEvidenceId(snapshot),
    },
    graph: {
      entryNodeIds: snapshot.graph.entryNodeIds,
      nodes: snapshot.graph.nodes.map((n) => ({
        nodeId: n.nodeId,
        sourceType: n.sourceType,
        name: n.name,
        evidenceIds: n.evidenceIds,
      })),
      edges: snapshot.graph.edges.map((e) => ({ role: e.role, evidenceIds: e.evidenceIds })),
    },
    variables: snapshot.variables.map((v) => ({
      variableId: v.variableId,
      name: v.name,
      scope: v.scope,
      readNodeIds: v.readNodeIds,
      writeNodeIds: v.writeNodeIds,
      evidenceIds: v.evidenceIds,
    })),
    dependencies: snapshot.dependencies.map((d) => ({
      dependencyId: d.dependencyId,
      type: d.type,
      displayName: d.displayName,
      resolutionStatus: d.resolutionStatus,
      evidenceIds: d.evidenceIds,
    })),
    reachability: {
      terminalNodeIds: analysis.reachability.terminalNodeIds,
      unreachableNodeIds: analysis.reachability.unreachableNodeIds,
      danglingEdgeIds: analysis.reachability.danglingEdgeIds,
    },
    cycles: { stronglyConnectedComponents: analysis.cycles.stronglyConnectedComponents },
    evidence: snapshot.evidence.map((e) => ({ evidenceId: e.evidenceId })),
  };
}

/** The directory a documented flow's own files were written under
 * (`ivrs/<slug>-<shortId>/<version>`), recovered from its own `files` keys
 * rather than re-derived: `document-bundle.ts`'s `ivrDirectoryName` is not
 * exported, and re-implementing its slugging rules here would be a second
 * copy of that logic free to drift from the first. `business.md` is written
 * for every documented flow unconditionally, so it is always present to
 * anchor on. */
function flowDirOf(flow: DocumentedFlow): string | null {
  const suffix = '/business.md';
  const key = Object.keys(flow.files).find((path) => path.endsWith(suffix));
  return key === undefined ? null : key.slice(0, -suffix.length);
}

interface NarrationTarget {
  readonly flowId: string;
  readonly versionId: string;
  readonly dir: string;
  readonly job: NarrationJob;
}

/**
 * Runs the resumable narration queue over every documented flow and folds
 * the result into `merged` (the same flat path -> contents map the caller is
 * about to stage and promote) as a `narrative.md` sibling of each flow's
 * `business.md`. Returns the bundle-level report; never throws on a
 * per-flow narration failure -- see `runNarrationQueue`'s own contract for
 * why a provider throwing only fails that one job, not this call.
 */
async function narrateDocumentedFlows(
  documented: readonly DocumentedFlow[],
  merged: Map<string, string>,
  narrationProvider: NarrationProvider,
  narrationJournal: NarrationContentJournal,
  narrationPolicy: ValidationPolicy | undefined,
): Promise<NarrationBundleReport> {
  const targets: NarrationTarget[] = [];
  for (const flow of documented) {
    const dir = flowDirOf(flow);
    if (dir === null) continue; // Defensive: every documented flow has a business.md.
    const analysis = analyzeFlow(flow.snapshot);
    const packSnapshot = toEvidencePackSnapshot(flow.snapshot, analysis);
    const pack = buildEvidencePack(packSnapshot, analysis.findings);
    targets.push({
      flowId: flow.flowId,
      versionId: flow.versionId,
      dir,
      job: { flowId: flow.flowId, version: flow.versionId, pack },
    });
  }

  const queueResult = await runNarrationQueue({
    jobs: targets.map((t) => t.job),
    provider: narrationProvider,
    journal: narrationJournal,
    ...(narrationPolicy !== undefined ? { policy: narrationPolicy } : {}),
  });

  let narratedCount = 0;
  let failedCount = 0;
  let acceptedClaims = 0;
  let rejectedClaims = 0;
  const rejectionsByCode = new Map<string, number>();
  const warnings: string[] = [];

  // `runNarrationQueue` produces exactly one result per job, in the same
  // order `jobs` was given -- see work-queue.ts's own loop -- so zipping by
  // index is exact, not a best-effort match.
  for (let i = 0; i < targets.length; i += 1) {
    const target = targets[i];
    const jobResult = queueResult.results[i];
    if (target === undefined || jobResult === undefined) continue;

    if (jobResult.skipped) {
      // An unchanged flow: reuse the sections a prior, completed run of this
      // exact evidence pack already validated, rather than either
      // re-narrating it or letting its narrative.md silently vanish from
      // this run's output -- AGENTS.md's "never overwrite the last
      // known-good output in place" applies to a skipped narration job
      // exactly as it does to a document file.
      const sections = await narrationJournal.loadSections(jobResult.jobKey);
      if (sections !== null) {
        const markdown = renderNarrative(sections, []);
        if (markdown !== null) merged.set(`${target.dir}/narrative.md`, markdown);
      } else {
        warnings.push(
          `flow ${target.flowId} version ${target.versionId}: this flow was already narrated in ` +
            'a prior run, but that content could not be located to reuse; it will be re-narrated ' +
            'on the next run.',
        );
      }
      continue;
    }

    if (jobResult.status === 'failed') {
      failedCount += 1;
      warnings.push(
        `flow ${target.flowId} version ${target.versionId}: the narration provider failed; ` +
          'deterministic documentation for this flow is unaffected.',
      );
      continue;
    }

    // 'completed': the provider was called and its draft was validated,
    // however few (possibly zero) claims survived.
    const outcome = jobResult.outcome;
    if (outcome === undefined) continue; // Defensive; work-queue.ts always sets this for 'completed'.
    narratedCount += 1;
    for (const section of outcome.sections.sections) acceptedClaims += section.claims.length;
    rejectedClaims += outcome.rejections.length;
    for (const rejection of outcome.rejections) {
      rejectionsByCode.set(rejection.code, (rejectionsByCode.get(rejection.code) ?? 0) + 1);
    }

    try {
      await narrationJournal.saveSections(jobResult.jobKey, outcome.sections);
    } catch {
      // Caching the sections is an optimization for the *next* run, not a
      // correctness requirement for this one -- this run's own narrative.md
      // (built from the same `outcome.sections` below) is unaffected.
      warnings.push(
        `flow ${target.flowId} version ${target.versionId}: narrated content could not be cached ` +
          'for reuse on the next run; it will be re-narrated then.',
      );
    }

    const markdown = renderNarrative(outcome.sections, outcome.rejections);
    if (markdown !== null) merged.set(`${target.dir}/narrative.md`, markdown);
  }

  return {
    attempted: queueResult.processedCount,
    narrated: narratedCount,
    skipped: queueResult.skippedCount,
    failed: failedCount,
    acceptedClaims,
    rejectedClaims,
    rejectionsByCode: Object.fromEntries(rejectionsByCode),
    warnings,
  };
}

/**
 * Documents a sealed capture bundle and atomically promotes the result into
 * `<outputRoot>/documents`.
 *
 * Every flow id and version id this function touches on a path comes from
 * `documentBundle`'s own `documented`/`files` output, which in turn comes
 * from the bundle's `flows/` directory listing -- a real filesystem
 * directory name, which the OS itself already refuses to let be `..` or
 * contain a `/` or a null byte, and which `document-bundle.ts` additionally
 * routes through `safeSegment` before it ever becomes part of a `files` key
 * (see its own `dir = \`ivrs/${ivrDirectoryName(...)}/...\`` line).
 * `safeSegment` is applied again here, independently, when deriving which
 * existing paths this run's flows "own" for the merge step above -- defense
 * in depth, not reliance on a single upstream check holding.
 *
 * Stages the merged tree via `createStaging`, then promotes it via
 * `promote` (both `@genesys-archivist/storage`) -- the same atomic
 * two-rename primitive every other staged write in this codebase uses. A
 * failure at any point before `promote` succeeds discards the staging area
 * and leaves the previous `documents` directory completely untouched.
 */
export async function documentBundleToDisk(
  options: DocumentBundleToDiskOptions,
): Promise<DocumentBundleToDiskResult> {
  const result = await documentBundle({
    bundleDir: options.bundleDir,
    generatedAt: options.generatedAt,
    ...(options.organizationId !== undefined ? { organizationId: options.organizationId } : {}),
    ...(options.region !== undefined ? { region: options.region } : {}),
  });

  const documentsDir = join(options.outputRoot, 'documents');
  const existing = await collectExistingDocuments(documentsDir);

  // Derived from the paths this run actually produced rather than rebuilt
  // from ids. The scoping lives in document-bundle.ts and is now
  // `ivrs/<name-slug>-<shortId>/<version>/`; reconstructing it here from
  // flowId would have silently stopped matching the moment that changed, and
  // a merge that owns no prefixes leaves every stale document in place.
  const touchedPrefixes = [
    ...new Set(
      result.documented.flatMap((d) =>
        Object.keys(d.files).map((relPath) => relPath.split('/').slice(0, 3).join('/') + '/'),
      ),
    ),
  ];
  const merged = new Map<string, string>();
  for (const [relPath, contents] of existing) {
    if (touchedPrefixes.some((prefix) => relPath.startsWith(prefix))) continue;
    merged.set(relPath, contents);
  }
  for (const [relPath, contents] of Object.entries(result.files)) {
    merged.set(relPath, contents);
  }

  // Render each Mermaid source to a sibling .svg.
  //
  // `packages/rendering` existed, was tested, and was called from nowhere --
  // the documentation set shipped .mmd source files that a reader had to paste
  // into a Mermaid viewer to see anything. A diagram nobody can look at is not
  // a diagram.
  //
  // The .mmd is deliberately kept alongside the .svg: it is the reviewable,
  // diffable form, and it is what still works when no browser is available.
  const diagrams = [...merged.keys()].filter((relPath) => relPath.endsWith('.mmd'));
  let diagramsRendered = 0;
  let rendererDegraded = false;

  if (diagrams.length > 0 && options.renderDiagrams === true) {
    const renderer = options.renderer ?? (await createRenderer());
    rendererDegraded = renderer.degraded;
    for (const relPath of diagrams) {
      const source = merged.get(relPath);
      if (source === undefined) continue;
      try {
        const svg = await renderer.diagram.renderSvg(source);
        // NullRenderer returns a placeholder rather than throwing, so an empty
        // or non-SVG result means "not really rendered" and must not be
        // written as though it were a picture.
        if (svg.trimStart().startsWith('<svg')) {
          merged.set(relPath.replace(/\.mmd$/, '.svg'), svg);
          diagramsRendered += 1;
        }
      } catch {
        // One unrenderable diagram must not lose the other ten, and must not
        // lose the documents either. The .mmd survives regardless, and the
        // count below reports the shortfall rather than hiding it.
        rendererDegraded = true;
      }
    }
  }

  // Opt-in AI narration: builds one evidence pack per documented flow, runs
  // the resumable narration queue, and folds each flow's validated
  // `narrative.md` into `merged` alongside its deterministic documents. See
  // this file's own "Narration wiring" section above for why this lives
  // here rather than in document-bundle.ts, and `narrateDocumentedFlows`'s
  // doc comment for what happens to a rejected claim or a failed provider
  // call. Off by default: `options.narrate` must be `true` for any of this
  // to run, and nothing above this point ever depended on it.
  let narrationReport: NarrationBundleReport | undefined;
  if (options.narrate === true) {
    if (options.narrationProvider === undefined) {
      throw new Error(
        'documentBundleToDisk: narrate is true but no narrationProvider was supplied. ' +
          'There is no silent fallback -- a caller that asks for narration must wire a provider.',
      );
    }
    const journal = options.narrationJournal ?? createInMemoryNarrationJournal();
    narrationReport = await narrateDocumentedFlows(
      result.documented,
      merged,
      options.narrationProvider,
      journal,
      options.narrationPolicy,
    );
  }

  // The staging id is generated here, not taken from any bundle or
  // caller-supplied content, so it carries no untrusted input for
  // createStaging's own (unsanitized) directory-name parameter.
  const staging = await createStaging(options.outputRoot, `document-set-${randomUUID()}`);
  try {
    for (const [relPath, contents] of merged) {
      // relPath's segments were already sanitized above; resolveWithinRootReal
      // inside staging.write is the actual enforcement boundary against a
      // hostile segment, exactly as it is for every other staged writer in
      // this codebase (profile-store.ts, bundle-writer.ts, capture-run.ts).
      await staging.write(relPath.split('/'), contents);
    }
    await promote(staging, documentsDir);
  } catch (error) {
    await staging.discard();
    throw error;
  }

  return {
    documentsWritten: result.documented.length,
    diagramsRendered,
    rendererDegraded,
    skipped: result.skipped,
    outputDir: documentsDir,
    contentHash: contentHash(result.files, DOCUMENT_SET_CANONICAL),
    ...(narrationReport !== undefined ? { narration: narrationReport } : {}),
  };
}
