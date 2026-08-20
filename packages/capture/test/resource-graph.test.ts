// packages/capture/test/resource-graph.test.ts
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { DependencyRef, DependencyResolution } from '@genesys-archivist/domain';
import { createSchemaValidator } from '@genesys-archivist/testing';
import { buildResourceGraph, type ResourceResolver } from '../src/resource-graph.js';

/** Resolver over a static adjacency map. Anything absent resolves not_found. */
function resolverFrom(
  graph: Record<string, readonly string[]>,
  forbidden: readonly string[] = [],
): ResourceResolver {
  const parse = (key: string): DependencyRef => {
    const [type = '', id = ''] = key.split(':');
    return { type, id: id as DependencyRef['id'] };
  };
  return {
    resolve: (refs) =>
      Promise.resolve(
        refs.map((ref): DependencyResolution => {
          const key = `${ref.type}:${ref.id}`;
          if (forbidden.includes(key)) {
            return { ref, status: 'forbidden', displayName: null, safeMetadata: {} };
          }
          if (!(key in graph)) {
            return { ref, status: 'not_found', displayName: null, safeMetadata: {} };
          }
          return { ref, status: 'resolved', displayName: key, safeMetadata: {} };
        }),
      ),
    outwardRefs: (resolution) =>
      (graph[`${resolution.ref.type}:${resolution.ref.id}`] ?? []).map(parse),
  };
}

const seed = (key: string): DependencyRef => {
  const [type = '', id = ''] = key.split(':');
  return { type, id: id as DependencyRef['id'] };
};

describe('buildResourceGraph', () => {
  it('walks to closure across a reference three hops out from the seed', async () => {
    // flow -> dataaction -> integration -> queue is 3 hops from the seed flow.
    // A walker that stops one level early is the failure mode that silently
    // ships an incomplete migration bundle, so we assert on the far end.
    const resolver = resolverFrom({
      'flow:f1': ['dataaction:da1'],
      'dataaction:da1': ['integration:i1'],
      'integration:i1': ['queue:q1'],
      'queue:q1': [],
    });
    const { graph } = await buildResourceGraph([seed('flow:f1')], resolver);
    expect(graph.nodes.map((n) => n.key).sort()).toEqual([
      'dataaction:da1',
      'flow:f1',
      'integration:i1',
      'queue:q1',
    ]);
    const farNode = graph.nodes.find((n) => n.key === 'queue:q1');
    expect(farNode?.resolutionStatus).toBe('resolved');
  });

  it('terminates on a cyclic reference', async () => {
    const resolver = resolverFrom({ 'flow:a': ['flow:b'], 'flow:b': ['flow:a'] });
    const { graph } = await buildResourceGraph([seed('flow:a')], resolver);
    expect(graph.nodes).toHaveLength(2);
  });

  it('terminates and stays within the reachable universe on arbitrary cyclic graphs', async () => {
    // A hand-written cycle example proves nothing about the general case.
    // Generate random directed graphs over a fixed small universe of node
    // ids -- including self-loops, mutual cycles, and longer cycles -- and
    // prove the walk always finishes and never reports more nodes than the
    // universe contains or a duplicate node key.
    const universe = ['a', 'b', 'c', 'd', 'e'] as const;
    const pairs = universe.flatMap((from) =>
      universe.filter((to) => to !== from).map((to) => [from, to] as const),
    );

    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.boolean(), { minLength: pairs.length, maxLength: pairs.length }),
        fc.constantFrom(...universe),
        async (edgePresence, seedNode) => {
          const adjacency: Record<string, string[]> = Object.fromEntries(
            universe.map((n) => [`flow:${n}`, []]),
          );
          pairs.forEach(([from, to], i) => {
            if (edgePresence[i] === true) adjacency[`flow:${from}`]?.push(`flow:${to}`);
          });

          const { graph } = await buildResourceGraph(
            [seed(`flow:${seedNode}`)],
            resolverFrom(adjacency),
          );

          const keys = graph.nodes.map((n) => n.key);
          expect(new Set(keys).size).toBe(keys.length);
          expect(graph.nodes.length).toBeLessThanOrEqual(universe.length);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('records an edge for a repeated reference without duplicating the node', async () => {
    const resolver = resolverFrom({
      'flow:f1': ['queue:q1'],
      'flow:f2': ['queue:q1'],
      'queue:q1': [],
    });
    const { graph } = await buildResourceGraph([seed('flow:f1'), seed('flow:f2')], resolver);
    expect(graph.nodes.filter((n) => n.key === 'queue:q1')).toHaveLength(1);
    expect(graph.edges.filter((e) => e.to === 'queue:q1')).toHaveLength(2);
  });

  it('preserves a forbidden node instead of dropping it', async () => {
    const resolver = resolverFrom({ 'flow:f1': ['queue:q1'] }, ['queue:q1']);
    const { graph } = await buildResourceGraph([seed('flow:f1')], resolver);
    const node = graph.nodes.find((n) => n.key === 'queue:q1');
    expect(node).toBeDefined();
    expect(node?.resolutionStatus).toBe('forbidden');
  });

  it('preserves a not_found reference so a broken link stays visible', async () => {
    const resolver = resolverFrom({ 'flow:f1': ['queue:gone'] });
    const { graph } = await buildResourceGraph([seed('flow:f1')], resolver);
    const node = graph.nodes.find((n) => n.key === 'queue:gone');
    expect(node).toBeDefined();
    expect(node?.resolutionStatus).toBe('not_found');
  });

  it('reports orphans that nothing references', async () => {
    const resolver = resolverFrom({ 'flow:f1': [], 'queue:unused': [] });
    const { graph } = await buildResourceGraph([seed('flow:f1'), seed('queue:unused')], resolver);
    expect(graph.orphans).toContain('queue:unused');
  });

  it('stops at the request budget rather than running unbounded', async () => {
    const chain: Record<string, readonly string[]> = {};
    for (let i = 0; i < 200; i += 1) chain[`flow:f${String(i)}`] = [`flow:f${String(i + 1)}`];
    const { graph } = await buildResourceGraph([seed('flow:f0')], resolverFrom(chain), {
      maxRequests: 10,
    });
    expect(graph.nodes.length).toBeLessThanOrEqual(11);
  });

  it('produces byte-identical output regardless of seed order (no Map/Set iteration leak)', async () => {
    const resolver = resolverFrom({
      'flow:f1': ['queue:q1', 'queue:q2'],
      'flow:f2': ['queue:q2', 'queue:q1'],
      'queue:q1': [],
      'queue:q2': [],
    });
    const { graph: forward } = await buildResourceGraph(
      [seed('flow:f1'), seed('flow:f2')],
      resolver,
    );
    const { graph: reversed } = await buildResourceGraph(
      [seed('flow:f2'), seed('flow:f1')],
      resolver,
    );
    expect(JSON.stringify(forward)).toBe(JSON.stringify(reversed));
  });

  it('produces output that validates against the published schema', async () => {
    const validate = await createSchemaValidator('schemas/resource-graph.schema.json');
    const { graph } = await buildResourceGraph([seed('flow:f1')], resolverFrom({ 'flow:f1': [] }));
    // The graph itself must conform without alteration once schemaVersion and
    // captureId (owned by the bundle writer, not the walker) are attached --
    // no extra fields the walker returns are allowed to leak past this gate.
    const payload = { ...graph, schemaVersion: '1.0', captureId: 'c1' };
    const valid = validate(payload);
    expect(validate.errors).toBeNull();
    expect(valid).toBe(true);
  });
});

describe('a truncated walk is distinguishable from a complete one', () => {
  // A graph stopped by the request budget is structurally identical to a
  // complete one: every node it reached is present and honestly statused.
  // The incompleteness is in the CLOSURE, which is the whole promise of this
  // walker. If the caller cannot tell, it seals a migration bundle that is
  // missing resources while believing it is whole.
  const chain: Record<string, readonly string[]> = {};
  for (let i = 0; i < 200; i += 1) chain[`flow:f${String(i)}`] = [`flow:f${String(i + 1)}`];

  it('reports truncated when the budget stopped the walk', async () => {
    const result = await buildResourceGraph([seed('flow:f0')], resolverFrom(chain), {
      maxRequests: 10,
    });
    expect(result.truncated).toBe(true);
    expect(result.requests).toBeLessThanOrEqual(10);
  });

  it('reports not truncated when the walk reached closure on its own', async () => {
    const result = await buildResourceGraph([seed('flow:f1')], resolverFrom({ 'flow:f1': [] }));
    expect(result.truncated).toBe(false);
  });

  it('the artifact itself still validates, carrying no extra field', async () => {
    const validate = await createSchemaValidator('schemas/resource-graph.schema.json');
    const result = await buildResourceGraph([seed('flow:f0')], resolverFrom(chain), {
      maxRequests: 10,
    });
    // The truncation flag lives on the result, never on the document, so a
    // truncated graph is still a schema-valid artifact.
    expect(
      validate({
        schemaVersion: '1.0',
        captureId: '2026-08-20T00-00-00Z_aaaaaa',
        ...result.graph,
      }),
    ).toBe(true);
  });
});
