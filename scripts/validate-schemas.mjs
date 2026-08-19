#!/usr/bin/env node
/**
 * Validates every JSON Schema under schemas/ and every fixture under fixtures/
 * that declares an `$archivistSchema` pointer.
 *
 * Ajv is an optional dependency here on purpose: this script must run from a
 * bare checkout before `npm install` has pulled anything, so `npm run verify`
 * is never blocked by a missing dev dependency. When Ajv is present the
 * validation is real; when it is absent the script does structural checks and
 * says clearly that it degraded.
 */
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not URL.pathname: on Windows the latter yields "/d:/Personal%20Project"
// with the drive slash intact and spaces still percent-encoded.
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCHEMA_DIR = join(ROOT, 'schemas');
const FIXTURE_DIR = join(ROOT, 'fixtures');

let failures = 0;
const fail = (msg) => { console.error(`FAIL  ${msg}`); failures += 1; };
const pass = (msg) => console.log(`ok    ${msg}`);

async function loadJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function walk(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (entry.name.endsWith('.json')) out.push(full);
  }
  return out;
}

let Ajv = null;
let addFormats = null;
try {
  ({ default: Ajv } = await import('ajv/dist/2020.js'));
  ({ default: addFormats } = await import('ajv-formats'));
} catch {
  console.warn('WARN  ajv not installed - running structural checks only.');
  console.warn('WARN  Install ajv and ajv-formats to enable real validation.');
}

const schemaFiles = (await walk(SCHEMA_DIR)).filter((f) => f.endsWith('.schema.json'));
if (schemaFiles.length === 0) fail('no schemas found under schemas/');

const schemas = new Map();
for (const file of schemaFiles) {
  const rel = relative(ROOT, file);
  let doc;
  try {
    doc = await loadJson(file);
  } catch (err) {
    fail(`${rel} is not valid JSON: ${err.message}`);
    continue;
  }
  if (!doc.$id) fail(`${rel} is missing $id`);
  if (!doc.$schema) fail(`${rel} is missing $schema`);
  if (!doc.title) fail(`${rel} is missing title`);
  schemas.set(doc.$id ?? rel, { doc, rel });
  pass(`${rel} parsed`);
}

let ajv = null;
if (Ajv) {
  ajv = new Ajv({ strict: true, allErrors: true, allowUnionTypes: true });
  addFormats(ajv);
  for (const [id, { doc, rel }] of schemas) {
    try {
      ajv.addSchema(doc, id);
      pass(`${rel} compiled`);
    } catch (err) {
      fail(`${rel} failed to compile: ${err.message}`);
    }
  }
}

// Fixtures opt in by declaring which schema they claim to satisfy.
for (const file of await walk(FIXTURE_DIR)) {
  const rel = relative(ROOT, file);
  let doc;
  try {
    doc = await loadJson(file);
  } catch (err) {
    fail(`${rel} is not valid JSON: ${err.message}`);
    continue;
  }
  const target = doc.$archivistSchema;
  if (!target) continue;
  if (!schemas.has(target)) {
    fail(`${rel} claims unknown schema ${target}`);
    continue;
  }
  if (!ajv) continue;
  const validate = ajv.getSchema(target);
  const { $archivistSchema: _ignored, ...payload } = doc;
  if (validate(payload)) pass(`${rel} validates against ${target}`);
  else fail(`${rel} does not validate: ${ajv.errorsText(validate.errors, { separator: '; ' })}`);
}

console.log(failures === 0 ? '\nSchemas OK.' : `\n${failures} schema failure(s).`);
process.exit(failures === 0 ? 0 : 1);
