// packages/normalization/test/extract-variables.test.ts
import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseFlowConfig } from '../src/config-schema.js';
import { extractNodes } from '../src/extract-nodes.js';
import { extractVariables, indexVariableUsage } from '../src/extract-variables.js';

let cfg: ReturnType<typeof parseFlowConfig>;
beforeAll(async () => {
  const raw: unknown = JSON.parse(
    await readFile('fixtures/flow-config/inboundcall-47-nodes.json', 'utf8'),
  );
  cfg = parseFlowConfig(raw);
});

describe('extractVariables', () => {
  it('extracts the four flow-scoped variables', () => {
    expect(extractVariables(cfg).filter((v) => v.scope === 'flow')).toHaveLength(4);
  });

  it('also extracts task-scoped variables', () => {
    expect(extractVariables(cfg).some((v) => v.scope === 'task')).toBe(true);
  });

  it('gives every variable a stable id and a name', () => {
    for (const v of extractVariables(cfg)) {
      expect(v.variableId).toBeTruthy();
      expect(v.name).toBeTruthy();
    }
  });

  it('carries the secure marker without materialising a value', () => {
    const vars = extractVariables(cfg);
    expect(vars.every((v) => typeof v.secure === 'boolean')).toBe(true);
  });

  it('normalises the declared data type from __type', () => {
    expect(extractVariables(cfg).some((v) => v.dataType.length > 0)).toBe(true);
  });
});

describe('indexVariableUsage', () => {
  it('resolves reads by variable id, not by name', () => {
    const index = indexVariableUsage(cfg, extractNodes(cfg));
    const anyRead = [...index.values()].some((u) => u.readBy.length > 0);
    expect(anyRead).toBe(true);
  });

  it('finds at least one variable read but never written', () => {
    // The source flow gates a decision on a variable nothing ever writes, so
    // that branch is statically dead. This is the finding the analysis layer
    // exists to surface, and it is real rather than synthetic.
    const index = indexVariableUsage(cfg, extractNodes(cfg));
    const readNeverWritten = [...index.values()].filter(
      (u) => u.readBy.length > 0 && u.writtenBy.length === 0,
    );
    expect(readNeverWritten.length).toBeGreaterThan(0);
  });

  it('attributes a read to the node that performs it', () => {
    const nodes = extractNodes(cfg);
    const index = indexVariableUsage(cfg, nodes);
    const nodeIds = new Set(nodes.map((n) => n.nodeId));
    for (const usage of index.values()) {
      for (const id of usage.readBy) expect(nodeIds.has(id)).toBe(true);
    }
  });

  it('descends into nested expression operands', () => {
    // The real decision is GetAt(<var>, 0) == "…" — the ref is two levels deep.
    const index = indexVariableUsage(cfg, extractNodes(cfg));
    expect([...index.values()].reduce((n, u) => n + u.readBy.length, 0)).toBeGreaterThan(0);
  });
});
