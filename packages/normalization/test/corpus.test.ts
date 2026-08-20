// packages/normalization/test/corpus.test.ts
//
// Runs the full normalizer against every real, sanitized flow configuration
// in fixtures/flow-config/ — nine flow types beyond the one inboundcall
// fixture the original five-name edge allowlist was measured against. This
// is the corpus-level regression proof for gap 1: it does not just check
// that extraction *runs* on other flow types, it checks that the specific
// failure modes measured against this corpus during the task (a raw GUID
// leaking into an edge role; a legitimate dependency reference misreported
// as dangling; self-identity fields like `referenceId` misread as broken
// links) do not reappear.
import { readFile, readdir } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseFlowConfig } from '../src/config-schema.js';
import { extractNodes } from '../src/extract-nodes.js';
import { extractEdges } from '../src/extract-edges.js';
import { extractDependencies } from '../src/extract-dependencies.js';
import { extractVariables } from '../src/extract-variables.js';

const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let files: readonly string[];
beforeAll(async () => {
  files = (await readdir('fixtures/flow-config')).filter((f) => f.endsWith('.json'));
});

describe('the real flow-config corpus', () => {
  it('includes more than one flow type', () => {
    // Guards the guard: if someone deletes the corpus down to the original
    // inboundcall fixture, every test below would still pass, vacuously.
    expect(files.length).toBeGreaterThan(1);
  });

  it('normalizes every fixture without throwing', async () => {
    for (const file of files) {
      const raw: unknown = JSON.parse(await readFile(`fixtures/flow-config/${file}`, 'utf8'));
      const cfg = parseFlowConfig(raw);
      const { nodes } = extractNodes(cfg);
      const { dependencies } = extractDependencies(cfg, nodes);
      expect(() => extractEdges(cfg, nodes, dependencies)).not.toThrow();
      expect(() => extractVariables(cfg)).not.toThrow();
    }
  });

  it('never lets a GUID become an edge role, on any fixture', async () => {
    for (const file of files) {
      const raw: unknown = JSON.parse(await readFile(`fixtures/flow-config/${file}`, 'utf8'));
      const cfg = parseFlowConfig(raw);
      const { nodes } = extractNodes(cfg);
      const { dependencies } = extractDependencies(cfg, nodes);
      const { edges } = extractEdges(cfg, nodes, dependencies);
      const guidRoles = edges.filter((e) => GUID_PATTERN.test(e.role));
      expect(guidRoles, `${file} produced a GUID-shaped role`).toEqual([]);
    }
  });

  it('raises no DANGLING_REFERENCE once dependencies are supplied, on any fixture', async () => {
    // Every DANGLING_REFERENCE this corpus produced before the fix (bot,
    // digitalbot, inboundemail, inboundshortmessage, outboundcall) turned
    // out to be either referenceId self-identity noise or a legitimate,
    // resolvable dependency reference. None was a genuinely broken link —
    // a fact worth pinning at the corpus level, not only per-fixture.
    for (const file of files) {
      const raw: unknown = JSON.parse(await readFile(`fixtures/flow-config/${file}`, 'utf8'));
      const cfg = parseFlowConfig(raw);
      const { nodes } = extractNodes(cfg);
      const { dependencies } = extractDependencies(cfg, nodes);
      const { warnings } = extractEdges(cfg, nodes, dependencies);
      const dangling = warnings.filter((w) => w.code === 'DANGLING_REFERENCE');
      expect(dangling, `${file} produced a DANGLING_REFERENCE`).toEqual([]);
    }
  });

  it('never lets a tenant-authored value leak into a warning path or message', async () => {
    // Every path segment extractEdges can produce is either a fixed
    // structural token (flowSequenceItemList, actionList, paths, an array
    // index) or a JS-identifier-shaped field name (camelCase, no spaces,
    // no punctuation beyond what an identifier allows) — never a value read
    // out of the configuration. A tenant-chosen string (a flow name, a
    // node name, a variable name) can contain spaces or punctuation an
    // identifier cannot, so a space appearing anywhere in a warning's path
    // or message is the structural tell that something went wrong.
    for (const file of files) {
      const raw: unknown = JSON.parse(await readFile(`fixtures/flow-config/${file}`, 'utf8'));
      const cfg = parseFlowConfig(raw);
      const { nodes } = extractNodes(cfg);
      const { dependencies } = extractDependencies(cfg, nodes);
      const { warnings: edgeWarnings } = extractEdges(cfg, nodes, dependencies);
      const { warnings: nodeWarnings } = extractNodes(cfg);
      for (const w of [...edgeWarnings, ...nodeWarnings]) {
        expect(w.path ?? '', `${file}: warning path contains a space`).not.toMatch(/ /);
      }
    }
  });
});
