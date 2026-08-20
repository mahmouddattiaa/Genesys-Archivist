import { describe, expect, it } from 'vitest';
import { REGION_KEYS, UnknownRegionError, resolveRegion } from '../src/region.js';

describe('resolveRegion', () => {
  it('resolves every canonical SDK region key, with the API host on the api. subdomain', () => {
    for (const key of REGION_KEYS) {
      const resolved = resolveRegion(key);
      expect(resolved.key).toBe(key);
      expect(resolved.apiHost).toMatch(/^api\./);
      expect(resolved.loginHost).toMatch(/^login\./);
      // Both hosts are derived from the same region domain.
      expect(resolved.apiHost.replace(/^api\./, '')).toBe(
        resolved.loginHost.replace(/^login\./, ''),
      );
    }
  });

  it('accepts short forms used in Architect UI and docs', () => {
    expect(resolveRegion('euw1')).toEqual({
      key: 'eu_west_1',
      apiHost: 'api.mypurecloud.ie',
      loginHost: 'login.mypurecloud.ie',
    });
    expect(resolveRegion('usw2').key).toBe('us_west_2');
  });

  it('throws a typed error for an unknown region instead of guessing a host', () => {
    expect(() => resolveRegion('mars_1')).toThrow(UnknownRegionError);
    expect(() => resolveRegion('mars_1')).toThrow(/mars_1/);
  });

  it('lists at least the eighteen regions the pinned SDK ships', () => {
    expect(REGION_KEYS.length).toBeGreaterThanOrEqual(18);
  });
});
