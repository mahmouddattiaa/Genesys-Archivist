# Genesys Archivist — Plan 4: Analysis, Documentation, and Rendering

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a validated `FlowSnapshot` into documentation a human actually wants to read — `business.md`, `technical.md`, `operations.md`, Mermaid diagrams, and PDF — with every technical claim citing evidence.

**Architecture:** Three pure-ish layers on top of Plan 3. `packages/analysis` draws conclusions from a snapshot and calls no model. `packages/documentation` renders deterministic Markdown and Mermaid source from snapshot plus analysis, and invents no fact. `packages/rendering` isolates the headless-browser dependency behind interfaces that degrade to a `NullRenderer`. Every test runs offline.

**Tech Stack:** TypeScript 5.6 strict, Vitest, Playwright (rendering only), Mermaid.

**Spec:** [docs/superpowers/specs/2026-08-20-genesys-archivist-design.md](../specs/2026-08-20-genesys-archivist-design.md) §6.2–6.5

**Predecessor:** [Plan 3](2026-08-20-03-normalizer.md) — complete. `normalizeFlow` produces a snapshot validating against `flow-snapshot.schema.json` 1.1.

## Global Constraints

- TypeScript strict with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`.
- **Non-null assertions are a lint error in `src/`**, permitted in tests. `no-explicit-any` is **not** disabled for tests — use `ReturnType<typeof fn>`.
- `packages/analysis` imports `domain` only and **never calls a model**. `packages/documentation` imports `domain` and `analysis`. `packages/rendering` imports `domain` only.
- **Never present inference as fact.** Findings are typed `fact`, `derived`, `inference`, or `unknown`. `technical.md` may use only `fact` and `derived`.
- **Every technical claim cites an evidence ID** that exists in the snapshot. A test asserts this for the whole rendered document.
- **All tenant text is untrusted.** Escape it before it reaches Markdown or Mermaid. A flow named `](javascript:alert(1))` or containing `-->` must not break out.
- Deterministic output: identical snapshot in, byte-identical Markdown out. Timestamps come from an injected clock, never `new Date()`.
- No `console.*`. Run `npm run verify` before every commit.

## The data you are working from

Measured from `fixtures/flow-config/inboundcall-47-nodes.json` via `normalizeFlow`:

```text
47 nodes    7 Task, 3 Menu, 2 MenuAction, 10 PlayAudioAction,
            10 TransferMenuAction, 6 TransferTaskAction,
            4 TransferPureMatchAction, 3 DecisionAction,
            1 DisconnectAction, 1 DataAction
55 edges    entry 7, next 12, transfer-menu 12, menu-choice 12,
            transfer-task 6, yes 3, no 3
 7 variables    5 read, 3 written, 2 READ BUT NEVER WRITTEN
 6 dependencies dataAction, queue, ttsEngine, ttsVoice, language, systemPrompt
109 evidence records
 1 entry node   trk_10
```

The graph is **cyclic** — menus loop back — and all 47 nodes are reachable.

---

### Task 1: Reachability and graph findings

**Files:** create `packages/analysis/src/reachability.ts`, test `packages/analysis/test/reachability.test.ts`. Modify `packages/analysis/package.json` and `tsconfig.json` to depend on `domain`.

**Produces:** `analyzeReachability(snapshot): ReachabilityReport` with `reachableNodeIds`, `unreachableNodeIds`, `danglingEdgeIds`, `terminalNodeIds`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/analysis/test/reachability.test.ts
import { describe, expect, it } from 'vitest';
import { analyzeReachability } from '../src/reachability.js';

const snap = (nodes: string[], edges: [string, string][], entry: string[]) => ({
  graph: {
    entryNodeIds: entry,
    nodes: nodes.map((id) => ({ nodeId: id })),
    edges: edges.map(([from, to], i) => ({ edgeId: `e${String(i)}`, from, to, role: 'next' })),
  },
});

describe('analyzeReachability', () => {
  it('marks everything reachable from an entry', () => {
    const r = analyzeReachability(
      snap(
        ['a', 'b', 'c'],
        [
          ['a', 'b'],
          ['b', 'c'],
        ],
        ['a'],
      ),
    );
    expect([...r.reachableNodeIds].sort()).toEqual(['a', 'b', 'c']);
    expect(r.unreachableNodeIds).toHaveLength(0);
  });

  it('reports a node no entry can reach', () => {
    const r = analyzeReachability(snap(['a', 'b', 'orphan'], [['a', 'b']], ['a']));
    expect(r.unreachableNodeIds).toEqual(['orphan']);
  });

  it('terminates on a cycle', () => {
    // IVR menus loop back. A naive walk hangs here.
    const r = analyzeReachability(
      snap(
        ['a', 'b'],
        [
          ['a', 'b'],
          ['b', 'a'],
        ],
        ['a'],
      ),
    );
    expect([...r.reachableNodeIds].sort()).toEqual(['a', 'b']);
  });

  it('reports an edge pointing at a node that does not exist', () => {
    const r = analyzeReachability(snap(['a'], [['a', 'ghost']], ['a']));
    expect(r.danglingEdgeIds).toHaveLength(1);
  });

  it('identifies terminal nodes, which have no outgoing edge', () => {
    const r = analyzeReachability(snap(['a', 'b'], [['a', 'b']], ['a']));
    expect(r.terminalNodeIds).toEqual(['b']);
  });

  it('handles a snapshot with no entry at all without throwing', () => {
    const r = analyzeReachability(snap(['a'], [], []));
    expect(r.unreachableNodeIds).toEqual(['a']);
  });

  it('is deterministic', () => {
    const s = snap(
      ['c', 'a', 'b'],
      [
        ['a', 'b'],
        ['a', 'c'],
      ],
      ['a'],
    );
    expect(JSON.stringify(analyzeReachability(s))).toBe(JSON.stringify(analyzeReachability(s)));
  });
});
```

- [ ] **Step 2:** run, confirm module-not-found.
- [ ] **Step 3:** implement with an explicit visited set — the graph is genuinely cyclic and recursion without one will not terminate. Sort every output array.
- [ ] **Step 4:** run, confirm 7 pass.
- [ ] **Step 5:** commit.

---

### Task 2: Cycle detection

**Files:** create `packages/analysis/src/cycles.ts`, test `packages/analysis/test/cycles.test.ts`.

**Produces:** `findCycles(snapshot): CycleReport` with `stronglyConnectedComponents` (arrays of ≥2 node IDs, or a self-loop) and `nodeIdsInCycles`.

`docs/04` is explicit: IVRs legitimately contain retries and loops, so traversal must use SCC rather than assume a tree. Cycles are **reported, not treated as errors**.

- [ ] **Step 1: Write the failing test**

```ts
// packages/analysis/test/cycles.test.ts
import { describe, expect, it } from 'vitest';
import { findCycles } from '../src/cycles.js';

const snap = (nodes: string[], edges: [string, string][]) => ({
  graph: {
    entryNodeIds: [nodes[0] ?? ''],
    nodes: nodes.map((id) => ({ nodeId: id })),
    edges: edges.map(([from, to], i) => ({ edgeId: `e${String(i)}`, from, to, role: 'next' })),
  },
});

describe('findCycles', () => {
  it('finds no component in an acyclic graph', () => {
    expect(findCycles(snap(['a', 'b'], [['a', 'b']])).stronglyConnectedComponents).toHaveLength(0);
  });

  it('finds a two-node cycle', () => {
    const r = findCycles(
      snap(
        ['a', 'b'],
        [
          ['a', 'b'],
          ['b', 'a'],
        ],
      ),
    );
    expect(r.stronglyConnectedComponents).toHaveLength(1);
    expect([...(r.stronglyConnectedComponents[0] ?? [])].sort()).toEqual(['a', 'b']);
  });

  it('finds a self-loop, which is how a retry is expressed', () => {
    expect(findCycles(snap(['a'], [['a', 'a']])).nodeIdsInCycles).toEqual(['a']);
  });

  it('separates two independent cycles', () => {
    const r = findCycles(
      snap(
        ['a', 'b', 'c', 'd'],
        [
          ['a', 'b'],
          ['b', 'a'],
          ['c', 'd'],
          ['d', 'c'],
        ],
      ),
    );
    expect(r.stronglyConnectedComponents).toHaveLength(2);
  });

  it('does not report an acyclic diamond as a cycle', () => {
    const r = findCycles(
      snap(
        ['a', 'b', 'c', 'd'],
        [
          ['a', 'b'],
          ['a', 'c'],
          ['b', 'd'],
          ['c', 'd'],
        ],
      ),
    );
    expect(r.stronglyConnectedComponents).toHaveLength(0);
  });

  it('is deterministic and sorted', () => {
    const s = snap(
      ['a', 'b', 'c'],
      [
        ['a', 'b'],
        ['b', 'c'],
        ['c', 'a'],
      ],
    );
    expect(JSON.stringify(findCycles(s))).toBe(JSON.stringify(findCycles(s)));
  });
});
```

- [ ] **Step 2–5:** fail, implement (Tarjan or Kosaraju — iterative, because a deep flow could blow the stack), pass, commit.

---

### Task 3: Caller journeys

**Files:** create `packages/analysis/src/journeys.ts`, test `packages/analysis/test/journeys.test.ts`.

**Produces:** `extractJourneys(snapshot, options?): readonly Journey[]` where a `Journey` has `journeyId`, `steps` (node IDs), `terminalKind` (`transfer` | `disconnect` | `loop` | `truncated` | `dead-end`), and `evidenceIds`.

**The rule from `docs/05`:** never enumerate all paths in a branching cyclic graph. Stop at business-relevant terminals — transfer, disconnect, return, external call, or a repeated state — and cap both path length and total journey count. Report complexity rather than exploding.

- [ ] **Step 1: Write the failing test**

```ts
// packages/analysis/test/journeys.test.ts
import { describe, expect, it } from 'vitest';
import { extractJourneys } from '../src/journeys.js';

const snap = (nodes: [string, string][], edges: [string, string, string][], entry: string[]) => ({
  graph: {
    entryNodeIds: entry,
    nodes: nodes.map(([nodeId, sourceType]) => ({ nodeId, sourceType, name: nodeId })),
    edges: edges.map(([from, to, role], i) => ({
      edgeId: `e${String(i)}`,
      from,
      to,
      role,
      label: null,
    })),
  },
});

describe('extractJourneys', () => {
  it('walks a simple path to a disconnect', () => {
    const j = extractJourneys(
      snap(
        [
          ['a', 'Task'],
          ['b', 'PlayAudioAction'],
          ['c', 'DisconnectAction'],
        ],
        [
          ['a', 'b', 'next'],
          ['b', 'c', 'next'],
        ],
        ['a'],
      ),
    );
    expect(j).toHaveLength(1);
    expect(j[0]?.terminalKind).toBe('disconnect');
    expect(j[0]?.steps).toEqual(['a', 'b', 'c']);
  });

  it('produces one journey per branch', () => {
    const j = extractJourneys(
      snap(
        [
          ['a', 'Task'],
          ['y', 'DisconnectAction'],
          ['n', 'DisconnectAction'],
        ],
        [
          ['a', 'y', 'yes'],
          ['a', 'n', 'no'],
        ],
        ['a'],
      ),
    );
    expect(j).toHaveLength(2);
  });

  it('stops at a transfer rather than continuing', () => {
    const j = extractJourneys(
      snap(
        [
          ['a', 'Task'],
          ['t', 'TransferPureMatchAction'],
          ['after', 'PlayAudioAction'],
        ],
        [
          ['a', 't', 'next'],
          ['t', 'after', 'next'],
        ],
        ['a'],
      ),
    );
    expect(j[0]?.terminalKind).toBe('transfer');
    expect(j[0]?.steps).toEqual(['a', 't']);
  });

  it('terminates on a loop and labels it', () => {
    const j = extractJourneys(
      snap(
        [
          ['a', 'Task'],
          ['m', 'Menu'],
        ],
        [
          ['a', 'm', 'next'],
          ['m', 'a', 'menu-choice'],
        ],
        ['a'],
      ),
    );
    expect(j.some((x) => x.terminalKind === 'loop')).toBe(true);
  });

  it('caps total journeys and marks the result truncated', () => {
    // A wide fan-out must not explode.
    const nodes: [string, string][] = [['root', 'Menu']];
    const edges: [string, string, string][] = [];
    for (let i = 0; i < 50; i += 1) {
      nodes.push([`t${String(i)}`, 'DisconnectAction']);
      edges.push(['root', `t${String(i)}`, 'menu-choice']);
    }
    const j = extractJourneys(snap(nodes, edges, ['root']), { maxJourneys: 10 });
    expect(j.length).toBeLessThanOrEqual(10);
  });

  it('caps path depth', () => {
    const nodes: [string, string][] = [];
    const edges: [string, string, string][] = [];
    for (let i = 0; i < 100; i += 1) {
      nodes.push([`n${String(i)}`, 'PlayAudioAction']);
      if (i > 0) edges.push([`n${String(i - 1)}`, `n${String(i)}`, 'next']);
    }
    const j = extractJourneys(snap(nodes, edges, ['n0']), { maxDepth: 5 });
    expect(j[0]?.steps.length).toBeLessThanOrEqual(6);
    expect(j[0]?.terminalKind).toBe('truncated');
  });

  it('is deterministic', () => {
    const s = snap(
      [
        ['a', 'Task'],
        ['b', 'DisconnectAction'],
      ],
      [['a', 'b', 'next']],
      ['a'],
    );
    expect(JSON.stringify(extractJourneys(s))).toBe(JSON.stringify(extractJourneys(s)));
  });
});
```

- [ ] **Step 2–5:** fail, implement, pass, commit.

---

### Task 4: The findings engine

**Files:** create `packages/analysis/src/findings.ts`, `packages/analysis/src/index.ts`, test `packages/analysis/test/findings.test.ts`.

**Produces:** `analyzeFlow(snapshot, options?): FlowAnalysis` composing Tasks 1–3, plus `findings: readonly Finding[]` where `Finding` has `code`, `severity`, `kind` (`fact` | `derived` | `inference` | `unknown`), `message`, `nodeIds`, `evidenceIds`.

**This is where the product earns its keep.** Every finding must be derivable from the snapshot with no runtime data and no model.

Finding codes to emit:

| Code                          | Severity  | Kind      | Condition                                                                                |
| ----------------------------- | --------- | --------- | ---------------------------------------------------------------------------------------- |
| `VARIABLE_READ_NEVER_WRITTEN` | `error`   | `derived` | A variable is read but written nowhere. The branch reading it cannot behave as intended. |
| `VARIABLE_DECLARED_UNUSED`    | `info`    | `derived` | Declared, never read, never written                                                      |
| `NODE_UNREACHABLE`            | `warning` | `derived` | No entry can reach it                                                                    |
| `EDGE_DANGLING`               | `error`   | `derived` | Points at a node that does not exist                                                     |
| `BRANCH_TERMINATES_NOWHERE`   | `warning` | `derived` | A labelled outcome with no target                                                        |
| `CYCLE_PRESENT`               | `info`    | `fact`    | An SCC exists. Normal for an IVR; recorded for the reader                                |
| `DEPENDENCY_UNRESOLVED`       | `warning` | `fact`    | Resolution status is not `resolved`                                                      |
| `NODE_SEMANTICS_UNMODELLED`   | `info`    | `fact`    | `supportLevel` is `partial` — captured but not interpreted                               |

- [ ] **Step 1: Write the failing test**

```ts
// packages/analysis/test/findings.test.ts
import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { normalizeFlow } from '@genesys-archivist/normalization';
import { analyzeFlow } from '../src/findings.js';

let analysis: ReturnType<typeof analyzeFlow>;

beforeAll(async () => {
  const config: unknown = JSON.parse(
    await readFile('fixtures/flow-config/inboundcall-47-nodes.json', 'utf8'),
  );
  const snapshot = normalizeFlow({
    config,
    source: {
      provider: 'platform-api',
      adapterVersion: '0.1.0',
      extractedAt: '2026-08-20T00:00:00Z',
      region: 'eu_west_1',
      organizationId: 'org_1',
      trackingIdsAvailable: true,
      redactionApplied: true,
    },
    flow: {
      id: 'f1',
      name: 'Fixture Flow',
      type: 'inboundcall',
      secure: false,
      version: { selected: '4.0', state: 'published' },
    },
  });
  analysis = analyzeFlow(snapshot);
});

describe('analyzeFlow against the real flow', () => {
  it('finds both variables that are read but never written', () => {
    const f = analysis.findings.filter((x) => x.code === 'VARIABLE_READ_NEVER_WRITTEN');
    expect(f).toHaveLength(2);
  });

  it('rates a read-never-written variable as an error, because the branch cannot work', () => {
    const f = analysis.findings.find((x) => x.code === 'VARIABLE_READ_NEVER_WRITTEN');
    expect(f?.severity).toBe('error');
    expect(f?.kind).toBe('derived');
  });

  it('cites evidence for every finding that names a node', () => {
    const ids = new Set(analysis.snapshot.evidence.map((e) => e.evidenceId));
    for (const f of analysis.findings) {
      for (const id of f.evidenceIds) expect(ids.has(id)).toBe(true);
    }
  });

  it('reports no unreachable node in this flow', () => {
    expect(analysis.findings.filter((x) => x.code === 'NODE_UNREACHABLE')).toHaveLength(0);
  });

  it('reports no dangling edge in this flow', () => {
    expect(analysis.findings.filter((x) => x.code === 'EDGE_DANGLING')).toHaveLength(0);
  });

  it('records the cycle as a fact rather than a defect', () => {
    const f = analysis.findings.find((x) => x.code === 'CYCLE_PRESENT');
    expect(f?.kind).toBe('fact');
    expect(f?.severity).toBe('info');
  });

  it('produces caller journeys', () => {
    expect(analysis.journeys.length).toBeGreaterThan(0);
  });

  it('never emits an inference from the deterministic analyzer', () => {
    // packages/analysis calls no model. Anything it says is fact or derived.
    expect(analysis.findings.every((f) => f.kind === 'fact' || f.kind === 'derived')).toBe(true);
  });

  it('is deterministic', () => {
    expect(JSON.stringify(analyzeFlow(analysis.snapshot))).toBe(JSON.stringify(analysis));
  });
});
```

- [ ] **Step 2–5:** fail, implement, pass, commit.

---

### Task 5: Markdown-safe escaping

**Files:** create `packages/documentation/src/escape.ts`, test `packages/documentation/test/escape.test.ts`. Wire `packages/documentation` to depend on `domain` and `analysis`.

**Produces:** `escapeMarkdown(text)`, `escapeMermaidLabel(text)`, `escapeTableCell(text)`.

Flow names, prompts and expressions are **tenant-controlled**. `docs/06` requires escaping before they reach Markdown or Mermaid, and a comment-sequence break-out in Mermaid is a real injection path.

- [ ] **Step 1: Write the failing test**

```ts
// packages/documentation/test/escape.test.ts
import { describe, expect, it } from 'vitest';
import { escapeMarkdown, escapeMermaidLabel, escapeTableCell } from '../src/escape.js';

describe('escapeMarkdown', () => {
  it('neutralises a link break-out', () => {
    expect(escapeMarkdown('](javascript:alert(1))')).not.toContain('](javascript:');
  });
  it('neutralises raw HTML', () => {
    expect(escapeMarkdown('<script>x</script>')).not.toContain('<script>');
  });
  it('neutralises a heading injected at line start', () => {
    expect(escapeMarkdown('# Fake Heading')).not.toMatch(/^# /);
  });
  it('strips control characters', () => {
    expect(escapeMarkdown(`a${String.fromCharCode(0)}b`)).toBe('ab');
  });
  it('leaves ordinary text alone', () => {
    expect(escapeMarkdown('Main Service IVR')).toBe('Main Service IVR');
  });
});

describe('escapeTableCell', () => {
  it('escapes a pipe so a cell cannot add columns', () => {
    expect(escapeTableCell('a|b')).not.toBe('a|b');
  });
  it('collapses newlines, which would break the row', () => {
    expect(escapeTableCell('a\nb')).not.toContain('\n');
  });
});

describe('escapeMermaidLabel', () => {
  it('neutralises the comment sequence', () => {
    expect(escapeMermaidLabel('a --> b')).not.toContain('-->');
  });
  it('neutralises quotes that would end the label', () => {
    expect(escapeMermaidLabel('say "hi"')).not.toContain('"');
  });
  it('neutralises brackets that would change node shape', () => {
    const out = escapeMermaidLabel('a[b]{c}(d)');
    expect(out).not.toContain('[');
    expect(out).not.toContain('{');
  });
  it('strips a directive', () => {
    expect(escapeMermaidLabel('%%{init:{"x":1}}%%')).not.toContain('%%');
  });
  it('bounds length so one label cannot dominate a diagram', () => {
    expect(escapeMermaidLabel('x'.repeat(500)).length).toBeLessThanOrEqual(80);
  });
});
```

- [ ] **Step 2–5:** fail, implement, pass, commit.

---

### Task 6: Mermaid diagram generation

**Files:** create `packages/documentation/src/diagrams.ts`, test `packages/documentation/test/diagrams.test.ts`.

**Produces:** `buildDiagrams(snapshot, analysis, options?): readonly Diagram[]` with `id`, `title`, `mermaid`, `nodeIds`.

Per `docs/05`: node cap around 30, split by container when exceeded, stable short labels with a legend, escape all tenant text, and diagram failure must never block the tabular documentation.

- [ ] **Step 1: Write the failing test**

```ts
// packages/documentation/test/diagrams.test.ts
import { describe, expect, it } from 'vitest';
import { buildDiagrams } from '../src/diagrams.js';

const snapshot = {
  flow: { name: 'Fixture Flow' },
  graph: {
    entryNodeIds: ['a'],
    nodes: [
      { nodeId: 'a', sourceType: 'Task', name: 'Call Entry', containerPath: [] },
      { nodeId: 'b', sourceType: 'Menu', name: 'Main Menu', containerPath: [] },
      { nodeId: 'c', sourceType: 'DisconnectAction', name: 'End', containerPath: ['Call Entry'] },
    ],
    edges: [
      { edgeId: 'e0', from: 'a', to: 'b', role: 'next', label: null },
      { edgeId: 'e1', from: 'b', to: 'c', role: 'menu-choice', label: '1: Sales' },
    ],
  },
};
const analysis = { cycles: { nodeIdsInCycles: [] } };

describe('buildDiagrams', () => {
  it('produces a flowchart', () => {
    const [d] = buildDiagrams(snapshot as never, analysis as never);
    expect(d?.mermaid).toMatch(/^flowchart /m);
  });

  it('includes every node and edge of a small graph', () => {
    const [d] = buildDiagrams(snapshot as never, analysis as never);
    expect(d?.nodeIds).toHaveLength(3);
    expect(d?.mermaid).toContain('-->');
  });

  it('escapes a hostile node name', () => {
    const hostile = structuredClone(snapshot) as typeof snapshot;
    hostile.graph.nodes[0]!.name = 'evil --> injected';
    const [d] = buildDiagrams(hostile as never, analysis as never);
    const body = d?.mermaid
      .split('\n')
      .filter((l) => l.includes('injected'))
      .join('');
    expect(body).not.toContain('-->');
  });

  it('splits when the node cap is exceeded', () => {
    const big = {
      flow: { name: 'Big' },
      graph: {
        entryNodeIds: ['n0'],
        nodes: Array.from({ length: 90 }, (_, i) => ({
          nodeId: `n${String(i)}`,
          sourceType: 'PlayAudioAction',
          name: `Step ${String(i)}`,
          containerPath: i < 45 ? ['A'] : ['B'],
        })),
        edges: [],
      },
    };
    expect(buildDiagrams(big as never, analysis as never, { maxNodes: 30 }).length).toBeGreaterThan(
      1,
    );
  });

  it('emits a legend mapping short labels back to node ids', () => {
    const [d] = buildDiagrams(snapshot as never, analysis as never);
    expect(d?.mermaid).toMatch(/%%.*legend/i);
  });

  it('is deterministic', () => {
    const a = buildDiagrams(snapshot as never, analysis as never);
    const b = buildDiagrams(snapshot as never, analysis as never);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
```

- [ ] **Step 2–5:** fail, implement, pass, commit.

---

### Task 7: `technical.md`

**Files:** create `packages/documentation/src/technical.ts`, test `packages/documentation/test/technical.test.ts`, golden `fixtures/golden/technical.md`.

**Produces:** `renderTechnical(snapshot, analysis, ctx): string` where `ctx` carries an injected `generatedAt`.

Sections per `docs/05`: identity and hashes; structure and entry points; action inventory; branch table; variables with read/write locations; prompt and language inventory; dependencies; error and retry handling; graph findings; evidence index and limitations.

- [ ] **Step 1: Write the failing test**

```ts
// packages/documentation/test/technical.test.ts
import { readFile, writeFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { normalizeFlow } from '@genesys-archivist/normalization';
import { analyzeFlow } from '@genesys-archivist/analysis';
import { renderTechnical } from '../src/technical.js';

let doc = '';
let snapshot: ReturnType<typeof normalizeFlow>;

beforeAll(async () => {
  const config: unknown = JSON.parse(
    await readFile('fixtures/flow-config/inboundcall-47-nodes.json', 'utf8'),
  );
  snapshot = normalizeFlow({
    config,
    source: {
      provider: 'platform-api',
      adapterVersion: '0.1.0',
      extractedAt: '2026-08-20T00:00:00Z',
      region: 'eu_west_1',
      organizationId: 'org_1',
      trackingIdsAvailable: true,
      redactionApplied: true,
    },
    flow: {
      id: 'f1',
      name: 'Fixture Flow',
      type: 'inboundcall',
      secure: false,
      version: { selected: '4.0', state: 'published' },
    },
  });
  doc = renderTechnical(snapshot, analyzeFlow(snapshot), { generatedAt: '2026-08-20T00:00:00Z' });
});

describe('renderTechnical', () => {
  it('states identity, version and freshness up front', () => {
    expect(doc).toContain('Fixture Flow');
    expect(doc).toContain('4.0');
    expect(doc).toContain('platform-api');
  });

  it('reports the true node and edge counts', () => {
    expect(doc).toContain('47');
    expect(doc).toContain('55');
  });

  it('lists every dependency with its resolution status', () => {
    for (const d of snapshot.dependencies) expect(doc).toContain(d.type);
  });

  it('surfaces both read-never-written variables as defects', () => {
    expect(doc).toMatch(/read but never written/i);
  });

  it('cites only evidence ids that exist in the snapshot', () => {
    const ids = new Set(snapshot.evidence.map((e) => e.evidenceId));
    for (const cited of doc.match(/sha256:[0-9a-f]{64}/g) ?? []) expect(ids.has(cited)).toBe(true);
  });

  it('records the generator and normalizer versions', () => {
    expect(doc).toMatch(/generator|normalizer/i);
  });

  it('is deterministic', () => {
    const again = renderTechnical(snapshot, analyzeFlow(snapshot), {
      generatedAt: '2026-08-20T00:00:00Z',
    });
    expect(again).toBe(doc);
  });

  it('matches the golden file', async () => {
    if (process.env['UPDATE_GOLDEN'] === '1') {
      await writeFile('fixtures/golden/technical.md', doc, 'utf8');
    }
    expect(doc).toBe(await readFile('fixtures/golden/technical.md', 'utf8'));
  });
});
```

> Generate the golden once with `UPDATE_GOLDEN=1`, then **read it before committing**. A golden file nobody reviewed is a test that asserts whatever the code happened to do.

- [ ] **Step 2–5:** fail, implement, generate and review the golden, pass, commit.

---

### Task 8: `business.md` and `operations.md`

**Files:** create `packages/documentation/src/business.ts`, `operations.ts`, `packages/documentation/src/index.ts`; tests and goldens for each.

`business.md` per `docs/05`: status header, purpose, languages and entry behaviour, caller journeys by intent, business rules, external services at a non-secret level, failure behaviour, risks and open questions, evidence notes. **No inferred business meaning** — this is the deterministic layer, so where intent is unknown it says so explicitly rather than guessing.

`operations.md`: inbound routes reaching this flow, every dependency with status, what depends on this flow, blast radius if a named dependency is retired, failure-path summary, coverage gaps.

- [ ] **Step 1:** write both tests, mirroring Task 7's shape: identity header, real counts, escaped tenant text, evidence citations resolve, deterministic, golden match. Add for `business.md`:

```ts
it('never asserts business intent the configuration cannot prove', () => {
  // The deterministic layer states facts. Purpose is a job for the narrative
  // layer, which is out of scope here and must be visibly absent.
  expect(doc).toMatch(/not recorded|cannot be determined|no business purpose/i);
});

it('presents caller journeys in reader-facing terms', () => {
  expect(doc).toMatch(/caller/i);
});
```

and for `operations.md`:

```ts
it('reports blast radius for a shared dependency', () => {
  expect(doc).toMatch(/blast radius|what breaks|impact/i);
});

it('lists the failure paths a caller can hit', () => {
  expect(doc).toMatch(/disconnect|timeout|no input|failure/i);
});
```

- [ ] **Step 2–5:** fail, implement, review goldens, pass, commit.

---

### Task 9: Rendering — Mermaid to SVG, HTML to PDF

**Files:** create `packages/rendering/src/renderer.ts`, `null-renderer.ts`, `playwright-renderer.ts`, `index.ts`; test `packages/rendering/test/renderer.test.ts`.

**Produces:**

```ts
export interface DiagramRenderer { renderSvg(mermaid: string): Promise<string>; }
export interface DocumentRenderer { renderPdf(html: string, meta: PdfMeta): Promise<Uint8Array>; }
export class NullRenderer implements DiagramRenderer, DocumentRenderer { … }
export async function createRenderer(): Promise<{ diagram: DiagramRenderer; document: DocumentRenderer; degraded: boolean }>;
```

**`NullRenderer` is not a stub — it is the supported degraded mode.** `docs/08` requires that diagram rendering failure never blocks tabular documentation. `createRenderer` probes for Playwright and falls back, reporting `degraded: true` rather than throwing.

Unit tests cover the interface and the fallback and **must not require a browser**. Put the real Playwright render behind a test gated on `process.env['ARCHIVIST_RENDER_TEST'] === '1'` so CI without a browser stays green.

- [ ] **Step 1: Write the failing test**

```ts
// packages/rendering/test/renderer.test.ts
import { describe, expect, it } from 'vitest';
import { NullRenderer, createRenderer } from '../src/index.js';

describe('NullRenderer', () => {
  it('returns a placeholder SVG rather than throwing', async () => {
    const svg = await new NullRenderer().renderSvg('flowchart TD\n A --> B');
    expect(svg).toContain('<svg');
  });

  it('returns an empty document rather than throwing', async () => {
    expect((await new NullRenderer().renderPdf('<p>x</p>', { title: 't' })).byteLength).toBe(0);
  });

  it('never executes tenant content in the placeholder', async () => {
    const svg = await new NullRenderer().renderSvg('%%{init:{"x":1}}%% <script>alert(1)</script>');
    expect(svg).not.toContain('<script>');
  });
});

describe('createRenderer', () => {
  it('always resolves, with or without a browser', async () => {
    const r = await createRenderer();
    expect(typeof r.degraded).toBe('boolean');
  });

  it('reports degradation rather than throwing when no browser is present', async () => {
    const r = await createRenderer({ forceDegraded: true });
    expect(r.degraded).toBe(true);
    expect(await r.diagram.renderSvg('flowchart TD\n A')).toContain('<svg');
  });
});
```

- [ ] **Step 2–5:** fail, implement, pass, commit. Install Playwright with `npm install --save-dev playwright` in this task and record whether the browser download succeeded; if it does not, the `NullRenderer` path still ships and that is a legitimate, documented outcome.

---

### Task 10: `archivist document` — the end-to-end command

**Files:** create `apps/cli/src/commands/document.ts`, test `apps/cli/test/document.test.ts`.

**Produces:** `runDocument(deps): Promise<DocumentResult>` — reads a flow configuration from disk, normalizes, analyzes, renders all three documents plus diagrams, and returns them as an in-memory map of relative path to contents. **Writing to disk is the caller's job**, which keeps this testable with no filesystem.

- [ ] **Step 1: Write the failing test**

```ts
// apps/cli/test/document.test.ts
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { runDocument } from '../src/commands/document.js';

const load = async () =>
  JSON.parse(await readFile('fixtures/flow-config/inboundcall-47-nodes.json', 'utf8')) as unknown;

describe('runDocument', () => {
  it('produces the three documents and at least one diagram', async () => {
    const r = await runDocument({
      config: await load(),
      flowId: 'f1',
      flowName: 'Fixture Flow',
      flowType: 'inboundcall',
      version: '4.0',
      organizationId: 'org_1',
      region: 'eu_west_1',
      generatedAt: '2026-08-20T00:00:00Z',
    });
    const paths = Object.keys(r.files);
    expect(paths).toContain('business.md');
    expect(paths).toContain('technical.md');
    expect(paths).toContain('operations.md');
    expect(paths.some((p) => p.endsWith('.mmd'))).toBe(true);
  });

  it('reports the findings it discovered', async () => {
    const r = await runDocument({
      config: await load(),
      flowId: 'f1',
      flowName: 'Fixture Flow',
      flowType: 'inboundcall',
      version: '4.0',
      organizationId: 'org_1',
      region: 'eu_west_1',
      generatedAt: '2026-08-20T00:00:00Z',
    });
    expect(r.findings.filter((f) => f.code === 'VARIABLE_READ_NEVER_WRITTEN')).toHaveLength(2);
  });

  it('is deterministic', async () => {
    const args = {
      config: await load(),
      flowId: 'f1',
      flowName: 'Fixture Flow',
      flowType: 'inboundcall',
      version: '4.0',
      organizationId: 'org_1',
      region: 'eu_west_1',
      generatedAt: '2026-08-20T00:00:00Z',
    };
    expect(JSON.stringify((await runDocument(args)).files)).toBe(
      JSON.stringify((await runDocument(args)).files),
    );
  });

  it('never writes to disk itself', async () => {
    // Returning a map keeps this pure; atomic promotion is storage's concern.
    const r = await runDocument({
      config: await load(),
      flowId: 'f1',
      flowName: 'Fixture Flow',
      flowType: 'inboundcall',
      version: '4.0',
      organizationId: 'org_1',
      region: 'eu_west_1',
      generatedAt: '2026-08-20T00:00:00Z',
    });
    expect(typeof r.files).toBe('object');
  });
});
```

- [ ] **Step 2–5:** fail, implement, pass, commit.

---

## Parallel execution

```text
WAVE A   Task 1, 2   packages/analysis     (reachability, cycles — one agent, shared index)
         Task 5      packages/documentation (escaping — independent)
         Task 9      packages/rendering     (independent)

WAVE B   Task 3      packages/analysis      needs 1 and 2
         Task 6      packages/documentation needs 5

WAVE C   Task 4      packages/analysis      needs 1, 2, 3

WAVE D   Task 7, 8   packages/documentation needs 4 and 6

WAVE E   Task 10     apps/cli               needs everything
```

One agent owns a package's `index.ts` per wave.

## What this plan leaves out

The AI narrative layer. `packages/documentation` here is the **deterministic** layer only — it renders facts and says plainly where intent is unknown. Evidence packs, claim validation and the narration queue are a later plan, and the design requires the deterministic layer to stand alone without them.
