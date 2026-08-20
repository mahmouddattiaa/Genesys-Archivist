// packages/capture/src/bundle-verifier.ts
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Options, ValidateFunction } from 'ajv';
import { contentHash } from '@genesys-archivist/domain';
import { BUNDLE_CANONICAL, definitionFileName } from './bundle-writer.js';

// packages/capture/src/bundle-verifier.ts -> <repo>/schemas/capture-bundle.schema.json.
// The build output (packages/capture/dist/bundle-verifier.js) sits at the same
// depth below the repo root as this source file does, so the same relative
// walk resolves correctly whether this runs from src (via the test runner) or
// from a compiled dist/.
const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(HERE, '..', '..', '..', 'schemas', 'capture-bundle.schema.json');

interface AjvInstance {
  compile(schema: unknown): ValidateFunction;
}
interface Ajv2020Constructor {
  new (opts?: Options): AjvInstance;
}
type AddFormatsFn = (ajv: AjvInstance) => void;

// ajv's compiled CJS output reassigns `module.exports` to the class itself
// (`module.exports = exports = Ajv2020`) while *also* setting
// `exports.default` and `exports.__esModule` on that same function object --
// a shape that trips up esModuleInterop's default-import unwrapping under
// this project's NodeNext resolution (confirmed via `tsc`: the static import
// resolves to the module's namespace type rather than the constructor, so
// `new Ajv2020(...)` fails to type-check even though it works at runtime).
// `createRequire` sidesteps the interop entirely and is the same fix already
// used in packages/rendering/src/playwright-renderer.ts for a CJS
// dependency that doesn't play well with static ESM import here.
const requireCjs = createRequire(import.meta.url);
const Ajv2020 = requireCjs('ajv/dist/2020.js') as Ajv2020Constructor;
const addFormats = requireCjs('ajv-formats') as AddFormatsFn;

let cachedValidator: Promise<ValidateFunction> | undefined;

async function getValidator(): Promise<ValidateFunction> {
  cachedValidator ??= (async () => {
    const schema: unknown = JSON.parse(await readFile(SCHEMA_PATH, 'utf8'));
    const ajv = new Ajv2020({ strict: true });
    addFormats(ajv);
    return ajv.compile(schema);
  })();
  return cachedValidator;
}

export type VerificationFindingCode =
  | 'MANIFEST_MISSING'
  | 'MANIFEST_SCHEMA_INVALID'
  | 'CONTENT_HASH_MISMATCH'
  | 'FILE_MISSING'
  | 'COUNTS_MISMATCH';

export interface VerificationFinding {
  readonly code: VerificationFindingCode;
  readonly message: string;
}

export interface VerificationResult {
  readonly ok: boolean;
  readonly findings: readonly VerificationFinding[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

async function listDirNames(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

async function listFileNames(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

interface ReconstructedFlow {
  readonly flowId: string;
  readonly versionId: string;
  readonly definition: string;
  readonly meta: unknown;
}

interface ReconstructedResource {
  readonly category: string;
  readonly id: string;
  readonly body: unknown;
}

interface ReconstructedRecord {
  readonly flows: readonly ReconstructedFlow[];
  readonly resources: readonly ReconstructedResource[];
  readonly graph: unknown;
  readonly assets: readonly unknown[];
}

/**
 * Re-walks the bundle directory, reconstructing the same shape
 * `BundleWriter.seal()` hashed. Never throws: every filesystem read that can
 * fail is caught locally and turned into a `FILE_MISSING` finding (or, for
 * `resource-graph.json` / `assets/index.json`, treated as "nothing captured"
 * -- both are legitimately absent from a bundle that never wrote them).
 */
async function reconstructFlows(
  dir: string,
  findings: VerificationFinding[],
): Promise<ReconstructedFlow[]> {
  const flows: ReconstructedFlow[] = [];
  const flowIds = await listDirNames(join(dir, 'flows'));
  for (const flowId of flowIds) {
    let meta: unknown;
    try {
      meta = await readJson(join(dir, 'flows', flowId, 'flow.json'));
    } catch {
      findings.push({ code: 'FILE_MISSING', message: 'A captured flow is missing flow.json.' });
      continue;
    }
    // The definition's filename follows the format recorded in flow.json, so
    // read the format first rather than assuming one and reporting the other
    // as missing.
    const format =
      isRecord(meta) && meta['format'] === 'json' ? ('json' as const) : ('yaml' as const);
    const versionIds = await listDirNames(join(dir, 'flows', flowId, 'versions'));
    for (const versionId of versionIds) {
      try {
        const definition = await readFile(
          join(dir, 'flows', flowId, 'versions', versionId, definitionFileName(format)),
          'utf8',
        );
        flows.push({ flowId, versionId, definition, meta });
      } catch {
        findings.push({
          code: 'FILE_MISSING',
          message: 'A captured flow version is missing its definition file.',
        });
      }
    }
  }
  return flows;
}

async function reconstructResources(
  dir: string,
  findings: VerificationFinding[],
): Promise<ReconstructedResource[]> {
  const resources: ReconstructedResource[] = [];
  const categories = await listDirNames(join(dir, 'resources'));
  for (const category of categories) {
    const files = await listFileNames(join(dir, 'resources', category));
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const id = file.slice(0, -'.json'.length);
      try {
        const body = await readJson(join(dir, 'resources', category, file));
        resources.push({ category, id, body });
      } catch {
        findings.push({ code: 'FILE_MISSING', message: 'A captured resource file is unreadable.' });
      }
    }
  }
  return resources;
}

async function reconstructGraph(dir: string): Promise<unknown> {
  try {
    const raw = await readJson(join(dir, 'resource-graph.json'));
    if (!isRecord(raw)) return null;
    // Only the fields BundleWriter.writeResourceGraph hashed -- schemaVersion
    // and captureId are metadata about the artifact, not part of its content.
    return { nodes: raw['nodes'], edges: raw['edges'], orphans: raw['orphans'] };
  } catch {
    return null;
  }
}

async function reconstructAssets(dir: string): Promise<unknown[]> {
  try {
    const raw = await readJson(join(dir, 'assets', 'index.json'));
    if (!isRecord(raw)) return [];
    const assets: unknown[] = [];
    for (const [digest, value] of Object.entries(raw)) {
      if (!isRecord(value)) continue;
      assets.push({
        digest,
        originalName: value['originalName'],
        mimeType: value['mimeType'],
        byteLength: value['byteLength'],
        usedBy: value['usedBy'],
      });
    }
    return assets;
  } catch {
    return [];
  }
}

async function reconstructRecord(
  dir: string,
  findings: VerificationFinding[],
): Promise<ReconstructedRecord> {
  const [flows, resources, graph, assets] = await Promise.all([
    reconstructFlows(dir, findings),
    reconstructResources(dir, findings),
    reconstructGraph(dir),
    reconstructAssets(dir),
  ]);
  return { flows, resources, graph, assets };
}

/**
 * Cross-checks the manifest's `counts` against what the bundle actually holds.
 *
 * The content hash covers the captured content, not the manifest that
 * describes it, so `counts` sits outside it: it can be edited freely, or
 * simply be wrong because the writer miscounted, and the hash still matches.
 *
 * That matters because `counts` is what a consumer reads to know what it is
 * looking at. The migration server uses `counts.flows` to know how many flows
 * to expect, and `counts.unresolvedReferences` is the honest-incompleteness
 * signal AGENTS.md requires — a bundle claiming zero unresolved references
 * while holding several is precisely "presenting an incomplete capture as
 * complete". Neither number is worth anything if nothing ever checks it
 * against the files on disk.
 *
 * Counts are integers about the bundle's shape, never captured content, so
 * naming the mismatched field and its two values leaks nothing restricted.
 */
function checkCounts(
  manifest: Record<string, unknown>,
  record: ReconstructedRecord,
  findings: VerificationFinding[],
): void {
  const counts = manifest['counts'];
  if (!isRecord(counts)) return;

  const graph = isRecord(record.graph) ? record.graph : null;
  const graphNodes = Array.isArray(graph?.['nodes']) ? graph['nodes'] : [];
  const unresolved = graphNodes.filter(
    (node) => isRecord(node) && node['resolutionStatus'] !== 'resolved',
  ).length;

  const actual: Record<string, number> = {
    flows: record.flows.length,
    resources: record.resources.length,
    assets: record.assets.length,
    unresolvedReferences: unresolved,
  };

  for (const [field, expected] of Object.entries(actual)) {
    const claimed = counts[field];
    if (typeof claimed !== 'number' || claimed === expected) continue;
    findings.push({
      code: 'COUNTS_MISMATCH',
      message:
        `bundle-manifest.json claims counts.${field} is ${String(claimed)}, ` +
        `but the bundle contains ${String(expected)}.`,
    });
  }
}

/**
 * Establishes that a bundle on disk is internally consistent and unmodified.
 *
 * A bundle is handed to a separate migration server, possibly months later,
 * possibly after being copied between machines -- this is how that server's
 * operator checks it before acting on it. It must never throw on a missing
 * or malformed bundle, and a finding's `message` must never quote captured
 * content (flow names, prompt text, expressions, resource bodies): those are
 * exactly the untrusted fields this tool exists to check, and echoing them
 * back into a finding would leak restricted data through the one tool meant
 * to audit it.
 */
export async function verifyBundle(dir: string): Promise<VerificationResult> {
  const manifestPath = join(dir, 'bundle-manifest.json');
  let manifestRaw: string;
  try {
    manifestRaw = await readFile(manifestPath, 'utf8');
  } catch {
    return {
      ok: false,
      findings: [{ code: 'MANIFEST_MISSING', message: 'bundle-manifest.json was not found.' }],
    };
  }

  const findings: VerificationFinding[] = [];
  let manifest: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = JSON.parse(manifestRaw);
    if (isRecord(parsed)) {
      manifest = parsed;
    } else {
      findings.push({
        code: 'MANIFEST_SCHEMA_INVALID',
        message: 'bundle-manifest.json did not parse to a JSON object.',
      });
    }
  } catch {
    findings.push({
      code: 'MANIFEST_SCHEMA_INVALID',
      message: 'bundle-manifest.json is not valid JSON.',
    });
  }

  if (manifest !== undefined) {
    const validate = await getValidator();
    if (!validate(manifest)) {
      findings.push({
        code: 'MANIFEST_SCHEMA_INVALID',
        message: 'bundle-manifest.json does not satisfy the published capture-bundle schema.',
      });
    }
  }

  const record = await reconstructRecord(dir, findings);

  if (manifest !== undefined) {
    const expected = manifest['contentHash'];
    const recomputed = contentHash(record, BUNDLE_CANONICAL);
    if (typeof expected !== 'string' || expected !== recomputed) {
      findings.push({
        code: 'CONTENT_HASH_MISMATCH',
        message: 'The recomputed content hash does not match bundle-manifest.json.',
      });
    }
    checkCounts(manifest, record, findings);
  }

  return { ok: findings.length === 0, findings };
}
