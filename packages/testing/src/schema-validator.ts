// packages/testing/src/schema-validator.ts
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { Options, ValidateFunction } from 'ajv';

interface AjvInstance {
  compile(schema: unknown): ValidateFunction;
}
interface Ajv2020Constructor {
  new (opts?: Options): AjvInstance;
}
type AddFormatsFn = (ajv: AjvInstance) => void;

// ajv's compiled CJS output reassigns `module.exports` to the class itself
// (`module.exports = exports = Ajv2020`) while also setting `exports.default`
// and `exports.__esModule` on that same function object -- a shape that trips
// up esModuleInterop's default-import unwrapping under this project's NodeNext
// resolution (`new Ajv2020(...)` fails to type-check even though it works at
// runtime). `createRequire` sidesteps the interop entirely and is the same
// fix already used in packages/capture/src/bundle-verifier.ts. Six test files
// were each repeating that incantation; this is the one place that owns it.
const requireCjs = createRequire(import.meta.url);
const Ajv2020 = requireCjs('ajv/dist/2020.js') as Ajv2020Constructor;
const addFormats = requireCjs('ajv-formats') as AddFormatsFn;

export interface SchemaValidatorOptions {
  /** Report every validation error rather than stopping at the first. */
  readonly allErrors?: boolean;
  /**
   * Permit `type: [...]` union declarations. A couple of published schemas
   * legitimately use them (a nullable id, an integer-or-string version
   * number), and ajv's strict mode otherwise refuses to compile any schema
   * keyword under a type union without this flag.
   */
  readonly allowUnionTypes?: boolean;
}

/**
 * Reads and compiles the JSON schema at `schemaPath` into an ajv
 * `ValidateFunction`, for tests that check a generated artifact (a bundle
 * manifest, a resource graph, a flow snapshot) against its published schema.
 *
 * `strict: true` always -- every published schema in this repo is expected
 * to compile clean under strict mode -- and ajv-formats is always registered,
 * since adding format support a schema does not use is harmless.
 */
export async function createSchemaValidator(
  schemaPath: string,
  options: SchemaValidatorOptions = {},
): Promise<ValidateFunction> {
  const schema: unknown = JSON.parse(await readFile(schemaPath, 'utf8'));
  const ajv = new Ajv2020({ strict: true, ...options });
  addFormats(ajv);
  return ajv.compile(schema);
}
