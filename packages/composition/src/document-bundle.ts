// packages/composition/src/document-bundle.ts
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { safeSegment } from '@genesys-archivist/security';
import { escapeMarkdown } from '@genesys-archivist/documentation';
import { runDocument, type DocumentResult } from './document-flow.js';

/**
 * Turns a sealed capture bundle into a documentation set, one document set per
 * flow the bundle holds.
 *
 * `runDocument` documents a single flow from its parsed configuration. A
 * bundle holds many flows, each stored as text in whatever serialization the
 * source returned. Deciding which files constitute a bundle, and fanning out
 * across them, is composition's job rather than the CLI's — an app is supposed
 * to be thin, and this is real logic with real failure modes.
 *
 * Opens no socket. Stage 2 never does.
 */
export interface DocumentBundleOptions {
  /** The sealed bundle directory. */
  readonly bundleDir: string;
  /** Injected so a generated document is byte-identical across runs. */
  readonly generatedAt: string;
  /** Defaults to what the bundle manifest records. */
  readonly organizationId?: string;
  readonly region?: string;
}

export interface DocumentedFlow {
  readonly flowId: string;
  readonly versionId: string;
  /** Relative path to contents, already prefixed with this flow's directory. */
  readonly files: Readonly<Record<string, string>>;
}

/** A flow the bundle holds that could not be documented, and why. */
export interface UndocumentedFlow {
  readonly flowId: string;
  readonly versionId: string;
  readonly reason: string;
}

export interface DocumentBundleResult {
  readonly documented: readonly DocumentedFlow[];
  /**
   * Flows present in the bundle that produced no documentation.
   *
   * Reported, never omitted. A documentation set that silently covers four of
   * a bundle's five flows is worse than one that covers four and says so:
   * the reader has no way to notice the fifth is missing.
   */
  readonly skipped: readonly UndocumentedFlow[];
  /** Every file across every flow, ready for the caller to write and promote. */
  readonly files: Readonly<Record<string, string>>;
}

interface BundleFlow {
  readonly flowId: string;
  readonly versionId: string;
  readonly format: 'yaml' | 'json';
  readonly type: string;
  readonly definition: string;
}

/**
 * A readable directory name for one flow: its own name, slugged, plus a short
 * slice of its id.
 *
 * The id suffix is not decoration. Flow names are tenant-authored: two flows in
 * different divisions can legitimately share one, they change over time, and
 * they are untrusted input. A directory keyed on the name alone would collide
 * silently, which for a documentation set means one IVR's documents quietly
 * overwriting another's.
 *
 * The bundle's own `flows/<flowId>/` tree keeps pure ids and is untouched by
 * this -- that tree is the published contract a migration server consumes, and
 * a contract keyed on a mutable display name would be a defect. This is the
 * human-facing view, where a GUID is useless.
 */
function ivrDirectoryName(flowName: string | null, flowId: string): string {
  const shortId = safeSegment(flowId).slice(0, 8);
  const slug = safeSegment(flowName ?? '')
    .toLowerCase()
    .replace(/^-+|-+$/g, '');
  const composed = slug.length === 0 ? shortId : `${slug}-${shortId}`;

  // Re-sanitize the composed name, and collapse dot runs.
  //
  // Both halves are individually safe and the composition was not: safeSegment
  // strips leading and trailing dots but keeps interior ones, so a flow id like
  // `..hidden..flow` sanitizes to `hidden..flow`, and slicing that to eight
  // characters yields `hidden..` -- a directory name ending in `..`. The
  // path-safety test caught it.
  //
  // resolveWithinRootReal at the staging boundary would still have refused an
  // actual escape, but a segment containing `..` has no business being
  // constructed in the first place, and relying on one downstream check to
  // catch what this function should never emit is exactly the pattern this
  // codebase avoids elsewhere.
  return safeSegment(composed.replace(/\.{2,}/g, '.'));
}

/** The flow's own display name, as the captured definition records it. */
function flowNameFrom(config: unknown): string | null {
  if (!isRecord(config)) return null;
  const name = config['name'];
  return typeof name === 'string' && name.trim().length > 0 ? name : null;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

async function listDirs(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Reads the bundle's flows.
 *
 * The definition's filename follows the format `flow.json` records, which is
 * why the bundle records it: a JSON configuration stored in a file named
 * `definition.yaml` is exactly how the format got lost between the two stages
 * before.
 */
async function readBundleFlows(
  bundleDir: string,
  skipped: UndocumentedFlow[],
): Promise<BundleFlow[]> {
  const flows: BundleFlow[] = [];

  for (const flowId of await listDirs(join(bundleDir, 'flows'))) {
    let meta: unknown;
    try {
      meta = JSON.parse(await readFile(join(bundleDir, 'flows', flowId, 'flow.json'), 'utf8'));
    } catch {
      skipped.push({ flowId, versionId: '', reason: 'flow.json is missing or unreadable' });
      continue;
    }
    const format = isRecord(meta) && meta['format'] === 'json' ? 'json' : 'yaml';
    const type = isRecord(meta) && typeof meta['type'] === 'string' ? meta['type'] : 'unknown';
    const fileName = format === 'json' ? 'definition.json' : 'definition.yaml';

    for (const versionId of await listDirs(join(bundleDir, 'flows', flowId, 'versions'))) {
      try {
        const definition = await readFile(
          join(bundleDir, 'flows', flowId, 'versions', versionId, fileName),
          'utf8',
        );
        flows.push({ flowId, versionId, format, type, definition });
      } catch {
        skipped.push({ flowId, versionId, reason: `${fileName} is missing or unreadable` });
      }
    }
  }

  return flows;
}

function parseDefinition(flow: BundleFlow): unknown {
  return flow.format === 'json' ? JSON.parse(flow.definition) : parseYaml(flow.definition);
}

async function readManifest(bundleDir: string): Promise<Record<string, unknown> | null> {
  try {
    const raw: unknown = JSON.parse(
      await readFile(join(bundleDir, 'bundle-manifest.json'), 'utf8'),
    );
    return isRecord(raw) ? raw : null;
  } catch {
    return null;
  }
}

export async function documentBundle(
  options: DocumentBundleOptions,
): Promise<DocumentBundleResult> {
  const skipped: UndocumentedFlow[] = [];
  const flows = await readBundleFlows(options.bundleDir, skipped);

  const manifest = await readManifest(options.bundleDir);
  const organization = isRecord(manifest?.['organization']) ? manifest['organization'] : {};
  const organizationId =
    options.organizationId ??
    (typeof organization['id'] === 'string' ? organization['id'] : 'unknown');
  const region =
    options.region ?? (typeof organization['region'] === 'string' ? organization['region'] : '');

  const documented: DocumentedFlow[] = [];
  const files: Record<string, string> = {};

  for (const flow of flows) {
    let config: unknown;
    try {
      config = parseDefinition(flow);
    } catch {
      // The parse error is not echoed: a flow definition is tenant-authored
      // and a parser will happily quote the line it choked on.
      skipped.push({
        flowId: flow.flowId,
        versionId: flow.versionId,
        reason: `definition is not valid ${flow.format}`,
      });
      continue;
    }

    let result: DocumentResult;
    try {
      result = runDocument({
        config,
        flowId: flow.flowId,
        // Was `flow.flowId` -- every generated document was titled with a
        // GUID. The name lives in the captured definition; nothing had read it.
        flowName: flowNameFrom(config) ?? flow.flowId,
        flowType: flow.type,
        version: flow.versionId,
        organizationId,
        region,
        generatedAt: options.generatedAt,
      });
    } catch {
      skipped.push({
        flowId: flow.flowId,
        versionId: flow.versionId,
        reason: 'the definition did not validate as an Architect flow configuration',
      });
      continue;
    }

    // Flow ids and names come from the bundle, which came from Genesys, so
    // both are untrusted even here and both go through safeSegment.
    const flowName = flowNameFrom(config);
    const dir = `ivrs/${ivrDirectoryName(flowName, flow.flowId)}/${safeSegment(flow.versionId)}`;
    const scoped: Record<string, string> = {};
    for (const [path, contents] of Object.entries(result.files)) {
      scoped[`${dir}/${path}`] = contents;
      files[`${dir}/${path}`] = contents;
    }

    // A front page, so the folder explains itself and points back at the
    // canonical definition rather than duplicating it.
    const index = [
      `# ${escapeMarkdown(flowName ?? flow.flowId)}`,
      '',
      '| | |',
      '| --- | --- |',
      `| Flow id | \`${escapeMarkdown(flow.flowId)}\` |`,
      `| Version | \`${escapeMarkdown(flow.versionId)}\` |`,
      `| Type | \`${escapeMarkdown(flow.type)}\` |`,
      '',
      '## Documents',
      '',
      '- [Business overview](business.md) — what this IVR does, for a non-engineer',
      '- [Technical reference](technical.md) — nodes, edges, variables, evidence',
      '- [Operations](operations.md) — dependencies and failure behaviour',
      '- Diagrams: `diagrams/` — `.svg` to look at, `.mmd` to diff',
      '',
      '## Source',
      '',
      'Generated from the captured definition at:',
      '',
      `\`\`\`text`,
      `flows/${flow.flowId}/versions/${flow.versionId}/${flow.format === 'json' ? 'definition.json' : 'definition.yaml'}`,
      `\`\`\``,
      '',
      'That path is relative to the bundle root. The bundle keys flows by id',
      'rather than by name because names are tenant-authored: they change, and',
      'two flows in different divisions can share one.',
      '',
    ].join('\n');
    scoped[`${dir}/index.md`] = index;
    files[`${dir}/index.md`] = index;
    documented.push({ flowId: flow.flowId, versionId: flow.versionId, files: scoped });
  }

  return { documented, skipped, files };
}
