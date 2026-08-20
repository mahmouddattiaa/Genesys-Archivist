import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not URL.pathname: on Windows the latter yields
// "/d:/Personal%20Project" with the drive slash intact and spaces encoded.
export const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/**
 * Region enum to host mapping. The region is authoritative; never infer it from
 * an organization display name.
 */
export const REGIONS = {
  use1: { api: 'api.mypurecloud.com', login: 'login.mypurecloud.com' },
  use2: { api: 'api.use2.us-gov-pure.cloud', login: 'login.use2.us-gov-pure.cloud' },
  usw2: { api: 'api.usw2.pure.cloud', login: 'login.usw2.pure.cloud' },
  cac1: { api: 'api.cac1.pure.cloud', login: 'login.cac1.pure.cloud' },
  euw1: { api: 'api.mypurecloud.ie', login: 'login.mypurecloud.ie' },
  euw2: { api: 'api.euw2.pure.cloud', login: 'login.euw2.pure.cloud' },
  euc1: { api: 'api.mypurecloud.de', login: 'login.mypurecloud.de' },
  apne1: { api: 'api.mypurecloud.jp', login: 'login.mypurecloud.jp' },
  apne2: { api: 'api.apne2.pure.cloud', login: 'login.apne2.pure.cloud' },
  apse2: { api: 'api.mypurecloud.com.au', login: 'login.mypurecloud.com.au' },
  aps1: { api: 'api.aps1.pure.cloud', login: 'login.aps1.pure.cloud' },
  mec1: { api: 'api.mec1.pure.cloud', login: 'login.mec1.pure.cloud' },
  sae1: { api: 'api.sae1.pure.cloud', login: 'login.sae1.pure.cloud' },
};

/**
 * Reads .env.phase0.
 *
 * The secret is exposed through a non-enumerable getter with a toJSON override,
 * so `console.log(env)`, `JSON.stringify(env)`, and object spread cannot emit
 * it. Its one legitimate use is the Basic auth header in getAccessToken().
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

  const region = values.GENESYS_REGION;
  if (!REGIONS[region]) {
    throw new Error(`Unknown region "${region}". Known: ${Object.keys(REGIONS).join(', ')}`);
  }

  const secret = values.GENESYS_CLIENT_SECRET;

  const env = {
    region,
    hosts: REGIONS[region],
    clientId: values.GENESYS_CLIENT_ID,
    // Blank on the first ever run. The probe prints what it discovers so this
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
 * Exchanges client credentials for an access token.
 *
 * The token and the secret both stay in memory. Neither is returned to a caller
 * that might log it, and an auth failure reports the HTTP status only -- never
 * the response body, which has been observed to echo request parameters.
 */
export async function getAccessToken(env) {
  const credentials = Buffer.from(`${env.clientId}:${env.secret}`).toString('base64');
  const response = await fetch(`https://${env.hosts.login}/oauth/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  if (!response.ok) {
    throw new Error(
      `Authentication failed with HTTP ${response.status}. ` +
        'Check that the OAuth client uses the client credentials grant and that the region is correct. ' +
        'The response body is deliberately not shown.',
    );
  }

  const body = await response.json();
  return body.access_token;
}

/** GET a Platform API path. Returns { ok, status, body } and never throws on HTTP status. */
export async function apiGet(env, token, path) {
  const response = await fetch(`https://${env.hosts.api}${path}`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { ok: response.ok, status: response.status, body };
}
