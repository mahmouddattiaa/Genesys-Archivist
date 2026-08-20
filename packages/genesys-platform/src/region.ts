// packages/genesys-platform/src/region.ts
//
// Genesys Cloud region -> API host / login host mapping.
//
// Copied from `PureCloudRegionHosts.js` in the pinned `purecloud-platform-client-v2`
// SDK (see AGENTS.md: "read its source... but do not import it"). An earlier probe
// (scripts/spike/env.mjs) hand-coded thirteen regions and was already wrong -- the
// SDK ships eighteen. Region mapping must never be extended by guessing a hostname:
// an unknown region is a typed error, not a fallback host.

/** Every region key the pinned SDK knows, mapped to its API host. */
const API_HOSTS: Readonly<Record<string, string>> = {
  us_east_1: 'mypurecloud.com',
  eu_west_1: 'mypurecloud.ie',
  ap_southeast_2: 'mypurecloud.com.au',
  ap_northeast_1: 'mypurecloud.jp',
  eu_central_1: 'mypurecloud.de',
  us_west_2: 'usw2.pure.cloud',
  ca_central_1: 'cac1.pure.cloud',
  ap_northeast_2: 'apne2.pure.cloud',
  eu_west_2: 'euw2.pure.cloud',
  ap_south_1: 'aps1.pure.cloud',
  us_east_2: 'use2.us-gov-pure.cloud',
  sa_east_1: 'sae1.pure.cloud',
  me_central_1: 'mec1.pure.cloud',
  ap_northeast_3: 'apne3.pure.cloud',
  eu_central_2: 'euc2.pure.cloud',
  mx_central_1: 'mxc1.pure.cloud',
  ap_southeast_1: 'apse1.pure.cloud',
  eusc_de_east_1: 'edee1.eusc-pure.cloud',
};

/**
 * Short forms Genesys documentation and the Architect UI use interchangeably
 * with the SDK's canonical `snake_case` keys (e.g. "euw1" for "eu_west_1").
 * Accepted as input, never used as an output key -- `resolveRegion` always
 * returns the canonical key so a captured bundle records one spelling.
 */
const SHORT_FORMS: Readonly<Record<string, string>> = {
  use1: 'us_east_1',
  use2: 'us_east_2',
  usw2: 'us_west_2',
  cac1: 'ca_central_1',
  euw1: 'eu_west_1',
  euw2: 'eu_west_2',
  euc1: 'eu_central_1',
  euc2: 'eu_central_2',
  apne1: 'ap_northeast_1',
  apne2: 'ap_northeast_2',
  apne3: 'ap_northeast_3',
  apse1: 'ap_southeast_1',
  apse2: 'ap_southeast_2',
  aps1: 'ap_south_1',
  mec1: 'me_central_1',
  sae1: 'sa_east_1',
  mxc1: 'mx_central_1',
  edee1: 'eusc_de_east_1',
};

/** Every canonical region key this adapter recognizes. */
export const REGION_KEYS: readonly string[] = Object.keys(API_HOSTS);

export class UnknownRegionError extends Error {
  constructor(readonly raw: string) {
    // `raw` is operator-supplied configuration (a CLI flag or profile field),
    // never tenant-controlled content, so it is safe to echo -- unlike
    // PlatformApiError, which must never echo anything upstream returned.
    super(
      `Unknown Genesys Cloud region "${raw}". Known regions: ${REGION_KEYS.join(', ')} ` +
        '(short forms such as "euw1" are also accepted).',
    );
    this.name = 'UnknownRegionError';
  }
}

export interface ResolvedRegion {
  readonly key: string;
  readonly apiHost: string;
  readonly loginHost: string;
}

/**
 * Resolves a region key (canonical or short form) to its API and login
 * hosts. Throws `UnknownRegionError` rather than guessing -- a wrong host is
 * a silent data-exfiltration risk (credentials sent to the wrong domain),
 * not a recoverable default.
 */
export function resolveRegion(raw: string): ResolvedRegion {
  const key = SHORT_FORMS[raw] ?? raw;
  const regionDomain = API_HOSTS[key];
  if (regionDomain === undefined) {
    throw new UnknownRegionError(raw);
  }
  // `purecloud-platform-client-v2`'s `Configuration.js` builds
  // `basePath = https://api.${environment}` -- the REST API lives on an
  // `api.` subdomain of the region domain, not the region domain itself.
  // `API_HOSTS` above is deliberately keyed to the bare region domain
  // (matching the SDK's own `PureCloudRegionHosts` table) so both the API
  // and login hosts are derived from one source rather than duplicated.
  return { key, apiHost: `api.${regionDomain}`, loginHost: `login.${regionDomain}` };
}
