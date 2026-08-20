import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import platformClient from 'purecloud-platform-client-v2';

// fileURLToPath, not URL.pathname: on Windows the latter yields
// "/d:/Personal%20Project" with the drive slash intact and spaces encoded.
export const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/**
 * Region hosts come from the SDK, never from a local table.
 *
 * An earlier version of this file hand-coded thirteen regions. The SDK ships
 * eighteen, so that table was already wrong, which is exactly the failure
 * docs/02 warns about when it says the adapter must map the region enum using
 * official SDK configuration.
 */
export const REGION_KEYS = Object.keys(platformClient.PureCloudRegionHosts);

/** Accepts the SDK form (eu_west_1) and the short form (euw1). */
const SHORT_FORM = {
  use1: 'us_east_1',
  use2: 'us_east_2',
  usw2: 'us_west_2',
  cac1: 'ca_central_1',
  euw1: 'eu_west_1',
  euw2: 'eu_west_2',
  euc1: 'eu_central_1',
  apne1: 'ap_northeast_1',
  apne2: 'ap_northeast_2',
  apne3: 'ap_northeast_3',
  apse2: 'ap_southeast_2',
  aps1: 'ap_south_1',
  mec1: 'me_central_1',
  sae1: 'sa_east_1',
};

export function resolveRegion(raw) {
  const key = SHORT_FORM[raw] ?? raw;
  const host = platformClient.PureCloudRegionHosts[key];
  if (!host) {
    throw new Error(
      `Unknown region "${raw}". The SDK knows: ${REGION_KEYS.join(', ')}\n` +
        'Short forms such as euw1 are also accepted.',
    );
  }
  return { key, host };
}

/**
 * Reads .env.phase0.
 *
 * The secret is exposed through a non-enumerable getter with a toJSON override,
 * so console.log, JSON.stringify, object spread, Object.keys, Object.entries,
 * util.inspect and template interpolation all cannot emit it. Its one
 * legitimate use is the argument to loginClientCredentialsGrant.
 */
export async function loadSpikeEnv() {
  let raw;
  try {
    raw = await readFile(join(REPO_ROOT, '.env.phase0'), 'utf8');
  } catch {
    throw new Error(
      'Missing .env.phase0. Copy .env.example and fill it in. Never paste credentials into a chat.',
    );
  }

  const values = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    values[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }

  const required = ['GENESYS_REGION', 'GENESYS_CLIENT_ID', 'GENESYS_CLIENT_SECRET'];
  const missing = required.filter((k) => !values[k]);
  if (missing.length > 0) {
    throw new Error(
      `.env.phase0 is missing a value for: ${missing.join(', ')}\n` +
        'Fill it in with your editor. Do not paste it into a chat.',
    );
  }

  const region = resolveRegion(values.GENESYS_REGION);
  const secret = values.GENESYS_CLIENT_SECRET;

  const env = {
    region: region.key,
    host: region.host,
    clientId: values.GENESYS_CLIENT_ID,
    // Blank on the very first run. The probe prints what it discovers so this
    // can be filled in, after which the tenant guard is armed.
    expectedOrgId: values.GENESYS_EXPECTED_ORG_ID || null,
    targetIvrId: values.GENESYS_TARGET_IVR_ID || null,
    toJSON() {
      return {
        region: this.region,
        clientId: this.clientId,
        expectedOrgId: this.expectedOrgId,
        secret: '[never serialized]',
      };
    },
    toString() {
      return '[SpikeEnv]';
    },
  };

  // Non-enumerable: excluded from spread, Object.keys, and JSON.stringify.
  Object.defineProperty(env, 'secret', {
    get: () => secret,
    enumerable: false,
    configurable: false,
  });

  return env;
}

/**
 * Authenticates the shared SDK client with the client credentials grant.
 *
 * The SDK owns token lifecycle and retry metadata, which is most of why
 * docs/01 mandates it over hand-rolled HTTP. On failure only the status and
 * a short message are surfaced: Genesys auth errors have been observed to
 * echo request parameters back in the body.
 */
export async function authenticate(env) {
  const client = platformClient.ApiClient.instance;
  client.setEnvironment(env.host);

  try {
    await client.loginClientCredentialsGrant(env.clientId, env.secret);
  } catch (err) {
    const status = err?.status ?? err?.code ?? 'unknown';
    throw new Error(
      `Authentication failed (${status}). Check that the OAuth client uses the ` +
        'client credentials grant and that the region is correct. ' +
        'The response body is deliberately not shown.',
    );
  }
  return client;
}

export { platformClient };

/**
 * Calls an SDK method and converts a rejection into a status, so a probe can
 * discover what is reachable instead of dying on the first permission gap.
 */
export async function attempt(label, fn) {
  try {
    return { ok: true, status: 200, body: await fn(), label };
  } catch (err) {
    return { ok: false, status: err?.status ?? 0, body: null, label };
  }
}
