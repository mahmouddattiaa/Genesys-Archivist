// packages/normalization/test/config-schema.test.ts
import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { ConfigValidationError, parseFlowConfig } from '../src/config-schema.js';

let fixture: unknown;
beforeAll(async () => {
  fixture = JSON.parse(await readFile('fixtures/flow-config/inboundcall-47-nodes.json', 'utf8'));
});

describe('parseFlowConfig', () => {
  it('accepts the real-shaped fixture', () => {
    expect(() => parseFlowConfig(fixture)).not.toThrow();
  });

  it('exposes the fields the normalizer needs', () => {
    const cfg = parseFlowConfig(fixture);
    expect(cfg.name).toBeTruthy();
    expect(cfg.type).toBeTruthy();
    expect(cfg.flowSequenceItemList.length).toBe(10);
    expect(cfg.variables.length).toBe(4);
    expect(Number(cfg.nextTrackingNumber)).toBe(57);
  });

  it('tolerates unknown keys, because Genesys adds fields', () => {
    expect(() => parseFlowConfig({ ...(fixture as object), someNewField2027: true })).not.toThrow();
  });

  it('rejects a configuration with no flowSequenceItemList', () => {
    const { flowSequenceItemList: _omit, ...rest } = fixture as Record<string, unknown>;
    expect(() => parseFlowConfig(rest)).toThrow(ConfigValidationError);
  });

  it('rejects a non-object', () => {
    expect(() => parseFlowConfig(null)).toThrow(ConfigValidationError);
    expect(() => parseFlowConfig('nope')).toThrow(ConfigValidationError);
  });

  it('does not echo configuration content in the error message', () => {
    try {
      parseFlowConfig({ name: 'SECRET-CUSTOMER-FLOW' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as Error).message).not.toContain('SECRET-CUSTOMER-FLOW');
    }
  });
});
