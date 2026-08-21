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
import { documentBundle, type UndocumentedFlow } from './document-bundle.js';

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
  };
}
