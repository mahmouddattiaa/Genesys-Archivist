#!/usr/bin/env node
/**
 * Produces a committable test fixture from a real flow configuration.
 *
 *   node scripts/spike/sanitize-config.mjs [flowId] [version] > fixtures/...
 *
 * AGENTS.md forbids real customer configuration in fixtures/. A purely
 * synthetic fixture would miss the structural quirks that matter, so this
 * preserves shape exactly and replaces every tenant-authored string.
 *
 * PRESERVED, because it is structure the normalizer must handle:
 *   - every key, every nesting level, every array length
 *   - __type, type, mode and other discriminators
 *   - trackingId values (ordinals, not identifying)
 *   - all numbers and booleans
 *   - language tags, which are enum-like and not tenant-authored
 *
 * REPLACED, deterministically so the fixture is stable across runs:
 *   - names, descriptions, labels, TTS text
 *   - GUIDs and resource ids
 *   - expressions: operators and function names kept, identifiers renamed
 */
import { createHash } from 'node:crypto';
import { attempt, authenticate, loadSpikeEnv, platformClient } from './env.mjs';

/** Discriminators and enum-like values the normalizer branches on. */
const STRUCTURAL_KEYS = new Set([
  '__type',
  'type',
  'mode',
  'outputId',
  'required',
  'isCategory',
  'collapsed',
  'customExpressionMode',
  'trackingId',
  'nextTrackingNumber',
  'version',
  'defaultLanguage',
  'schemaVersion',
]);

/** Language tags and similar enum-like literals are not tenant-authored. */
const KEEP_PATTERNS = [
  /^[a-z]{2}-[A-Z]{2}$/, // en-US
  /^[a-z]{2}-[a-z]{2}$/, // en-us
  /^[A-Z][A-Za-z]*Action$/, // PlayAudioAction
  /^(true|false|none|noValue)$/,
];

export const det = (s, n = 8) => createHash('sha256').update(String(s)).digest('hex').slice(0, n);

const fakeGuid = (s) => {
  const h = createHash('sha256').update(String(s)).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

const WORDS = [
  'alpha',
  'bravo',
  'charlie',
  'delta',
  'echo',
  'foxtrot',
  'golf',
  'hotel',
  'india',
  'juliet',
  'kilo',
  'lima',
  'mike',
  'november',
  'oscar',
  'papa',
];

/** Deterministic pseudonym of a similar shape and rough length. */
function pseudonym(value, keyHint) {
  const h = createHash('sha256')
    .update(keyHint + '|' + value)
    .digest();
  const wordCount = Math.max(1, Math.min(6, Math.round(value.split(/\s+/).length)));
  const out = [];
  for (let i = 0; i < wordCount; i += 1) out.push(WORDS[h[i % h.length] % WORDS.length]);
  const joined = out.join(' ');
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}

/**
 * Rewrites an expression, keeping every operator, function name and literal
 * shape while renaming identifiers. `GetAt(Task.user_type,0) == "blocked"`
 * becomes `GetAt(Task.v_3f1a,0) == "alpha"` — same parse tree, no tenant data.
 */
function sanitizeExpression(expr) {
  return expr
    .replace(
      /"([^"]*)"/g,
      (_m, s) => `"${s.length === 0 ? '' : WORDS[s.charCodeAt(0) % WORDS.length]}"`,
    )
    .replace(
      /\b(Flow|Task|Call|State|System)\.([A-Za-z_][A-Za-z0-9_]*)/g,
      (_m, scope, name) => `${scope}.v_${det(name, 4)}`,
    );
}

export const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PREFIXED_ID_RE = /^([a-z_]+_-_)([0-9a-f-]{20,})$/i;

function sanitizeString(value, key, path) {
  // A structural key keeps its value -- unless that value is a GUID.
  //
  // Measured, not assumed: on inbound-call flows `outputId` holds `__YES__` /
  // `__NO__` / `__DEFAULT__`, which is why it was listed as structural. On
  // bot, digitalbot and inboundemail flows it holds a GUID instead, and
  // `version` holds a GUID rather than "4.0" on bot, digitalbot and
  // voicesurvey. Preserving those verbatim leaked 9-13 real resource
  // identifiers per fixture, which the GUID guard at the end of main() caught.
  //
  // Substituting the deterministic fake keeps the reference graph intact --
  // the same source GUID always maps to the same fake one -- so a fixture
  // still resolves internally while naming nothing real.
  if (STRUCTURAL_KEYS.has(key)) return GUID_RE.test(value) ? fakeGuid(value) : value;
  if (KEEP_PATTERNS.some((re) => re.test(value))) return value;
  if (GUID_RE.test(value)) return fakeGuid(value);

  const prefixed = PREFIXED_ID_RE.exec(value);
  if (prefixed) return `${prefixed[1]}${fakeGuid(value)}`;

  // Expressions live under `exp`, or under keys that name a condition.
  if (key === 'exp' || /expression|condition/i.test(key)) return sanitizeExpression(value);

  // Everything else tenant-authored: names, text, descriptions, TTS.
  if (value.length === 0) return value;
  return pseudonym(value, key + '|' + path);
}

/**
 * Parent keys that introduce a free-form map whose KEYS are tenant-authored.
 *
 * A data action contract encodes the customer's records-system schema in its
 * keys -- "data.USER_TYPE", "data.MOBILE_NO" -- so sanitizing only values
 * leaves that schema intact. The production redactor has the same obligation:
 * it must consider object keys, not just values.
 */
const TENANT_KEYED_MAPS = new Set([
  'properties',
  'successOutputs',
  'errorOutputs',
  'inputs',
  'outputs',
  // Added after a measured leak. A digital-bot flow keys `nluMetaData.intents`
  // and `nluMetaData.mappings.intentsToReusableTasks` by the customer's own
  // intent taxonomy -- "cancel service", "inquire about prices", "change
  // plan". Sixteen of those survived into a candidate fixture because this set
  // listed only the five parents an inbound-call flow happens to use.
  'intents',
  'intentsToReusableTasks',
  'slots',
  'slotsToReusableTasks',
  'entities',
  'knowledgeBases',
]);

/**
 * A key is structural only if it *looks* structural.
 *
 * Enumerating tenant-keyed parents was the wrong default and the digital-bot
 * leak proved it: the list can only ever describe the flow types someone has
 * already looked at, and the corpus was one inbound-call flow. This rule is
 * safe in the other direction -- an unrecognised key is treated as tenant data
 * rather than as structure.
 *
 * Every structural key in this API is an ASCII camelCase identifier. Customer
 * text is not: it carries spaces, punctuation, or non-Latin script. A key that
 * is not identifier-shaped is pseudonymised no matter where it appears.
 */
const IDENTIFIER_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function sanitizeKey(key, parentKey) {
  if (STRUCTURAL_KEYS.has(key)) return key;

  const tenantKeyed = TENANT_KEYED_MAPS.has(parentKey);
  if (!tenantKeyed && IDENTIFIER_KEY.test(key)) return key;

  // Preserve any dotted namespace prefix so the shape stays recognisable.
  const m = /^([A-Za-z]+\.)?(.+)$/.exec(key);
  const prefix = m?.[1] ?? '';
  return `${prefix}F_${det(key, 6).toUpperCase()}`;
}

export function sanitize(node, key = '', path = '') {
  if (typeof node === 'string') return sanitizeString(node, key, path);
  if (node === null || typeof node !== 'object') return node;

  // The "[]" suffix matters. `properties` is an object map whose KEYS are
  // tenant field names, so those keys get pseudonymised. But `outputs` and
  // `inputs` are ARRAYS of {name, value} records whose keys are structural.
  // Without this suffix an array element inherits the tenant-keyed parent and
  // its `name`/`value` keys get renamed, which corrupts the structure the
  // normalizer depends on.
  if (Array.isArray(node)) return node.map((x, i) => sanitize(x, `${key}[]`, `${path}[${i}]`));

  const out = {};
  for (const [k, v] of Object.entries(node)) {
    out[sanitizeKey(k, key)] = sanitize(v, k, path ? `${path}.${k}` : k);
  }
  return out;
}

async function main() {
  const flowId = process.argv[2] ?? 'b97e0e67-65fd-4d9a-a899-da5f24e702ba';
  const version = process.argv[3] ?? null;

  const env = await loadSpikeEnv();
  await authenticate(env);
  const arch = new platformClient.ArchitectApi();

  const flow = await attempt('f', () => arch.getFlow(flowId, {}));
  if (!flow.ok) throw new Error(`flow lookup failed (${flow.status})`);
  const v = version ?? flow.body.publishedVersion?.id;

  const res = await attempt('c', () => arch.getFlowVersionConfiguration(flowId, v, {}));
  if (!res.ok) throw new Error(`configuration unavailable (${res.status})`);

  const clean = sanitize(res.body);

  // Guard against exactly the bug this check was written for: a key listed as
  // structural preserved a real GUID verbatim, and a name-only leak sweep did
  // not notice. Collect every GUID in the source and assert none survives.
  const originalGuids = new Set();
  const collect = (v) => {
    if (Array.isArray(v)) return v.forEach(collect);
    if (!v || typeof v !== 'object') return;
    for (const val of Object.values(v)) {
      if (typeof val === 'string' && GUID_RE.test(val)) originalGuids.add(val.toLowerCase());
      else collect(val);
    }
  };
  collect(res.body);
  const serialized = JSON.stringify(clean).toLowerCase();
  const survivors = [...originalGuids].filter((g) => serialized.includes(g));
  if (survivors.length > 0) {
    throw new Error(
      `${survivors.length} original GUID(s) survived sanitization. ` +
        'A key is almost certainly listed in STRUCTURAL_KEYS that actually holds a reference.',
    );
  }
  clean.$archivistFixture = {
    note: 'Sanitized from a real Architect flow configuration. Structure preserved exactly; every tenant-authored string replaced deterministically.',
    sourceFlowIdHash: det(flowId, 12),
    sourceType: flow.body.type,
    sourceVersion: String(v),
    generatedBy: 'scripts/spike/sanitize-config.mjs',
  };

  process.stdout.write(JSON.stringify(clean, null, 2));
}

// Guarded so make-fixtures.mjs can import `sanitize` without this script
// authenticating and writing a fixture to stdout as an import side effect.
if (process.argv[1] && process.argv[1].endsWith('sanitize-config.mjs')) {
  main().catch((err) => {
    console.error(`FAILED  ${err.message}`);
    process.exit(1);
  });
}
