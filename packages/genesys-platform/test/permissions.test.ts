import { describe, expect, it } from 'vitest';
import { PERMISSION_MATRIX, permissionForOperation } from '../src/permissions.js';

describe('PERMISSION_MATRIX', () => {
  it('lists a permission requirement for every operation this adapter defines', () => {
    expect(PERMISSION_MATRIX.length).toBeGreaterThan(15);
    for (const row of PERMISSION_MATRIX) {
      expect(row.endpoint).toMatch(/^GET \//);
    }
  });

  it('holds only read permissions -- never edit, publish, delete, or a credential scope', () => {
    for (const row of PERMISSION_MATRIX) {
      if (row.permission === '') continue;
      expect(row.permission.toLowerCase()).not.toMatch(
        /edit|publish|delete|add|remove|secret|credential/,
      );
      expect(row.permission.toLowerCase()).toMatch(/view/);
    }
  });

  it('maps a known operation to its permission', () => {
    expect(permissionForOperation('routing.queues.get')).toBe('routing:queue:view');
    expect(permissionForOperation('flows.versions.configuration')).toBe('architect:flow:view');
  });

  it('reports organizations.me as requiring no permission, not a missing entry', () => {
    expect(PERMISSION_MATRIX.some((row) => row.operation === 'organizations.me')).toBe(true);
    expect(permissionForOperation('organizations.me')).toBeNull();
  });

  it('has no duplicate operations', () => {
    const operations = PERMISSION_MATRIX.map((r) => r.operation);
    expect(new Set(operations).size).toBe(operations.length);
  });
});
