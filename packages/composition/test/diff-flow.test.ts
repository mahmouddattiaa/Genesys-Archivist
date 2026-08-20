// packages/composition/test/diff-flow.test.ts
//
// `createDiffFlow` is the real implementation of `ArchivistPort['diffFlow']`:
// load both requested versions through a `GenesysSourceProvider`, normalize
// each, diff, classify, and map onto the `FlowDiff` DTO. This file drives it
// against a hand-built provider double (not `@genesys-archivist/testing`'s
// `FakeSourceProvider` -- that fake always reports `format: 'yaml'`, and the
// whole point of one of these tests is proving a `'json'`-declared source is
// parsed as JSON regardless of what YAML would make of the same bytes) and
// against a real, sanitized fixture from fixtures/flow-config/.
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  asFlowId,
  asFlowVersionId,
  asOrganizationId,
  asProfileId,
  type ConnectionIdentity,
  type DependencyRef,
  type DependencyResolution,
  type FlowDescriptor,
  type FlowDiscoveryQuery,
  type FlowVersionRef,
  type GenesysSourceProvider,
  type RawFlowSource,
} from '@genesys-archivist/domain';
import { createDiffFlow } from '../src/diff-flow.js';

const FIXTURE_PATH = 'fixtures/flow-config/inboundshortmessage-5-nodes.json';
const CANARY = 'CANARY-TENANT-TEXT-5d84';

/**
 * A minimal `GenesysSourceProvider` double, local to this file for the
 * reason given in the header comment above: `FakeSourceProvider` cannot
 * express a `'json'`-declared source, and adding that to a shared fake
 * outside `@genesys-archivist/testing` would be an edit outside this task's
 * file ownership.
 */
class FixtureProvider implements GenesysSourceProvider {
  readonly #versions = new Map<
    string,
    { readonly format: 'yaml' | 'json'; readonly body: string }
  >();

  seed(versionId: string, format: 'yaml' | 'json', body: string): void {
    this.#versions.set(versionId, { format, body });
  }

  validateConnection(): Promise<ConnectionIdentity> {
    return Promise.resolve({
      organizationId: asOrganizationId('org_test'),
      organizationName: null,
      region: 'us-east-1',
    });
  }

  // Not a generator: this double never lists, and an async generator with
  // no `yield` trips both `require-yield` and `require-await`. An
  // already-done iterator satisfies `AsyncIterable<FlowDescriptor>` without
  // either.
  listFlows(_query: FlowDiscoveryQuery): AsyncIterable<FlowDescriptor> {
    return {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<FlowDescriptor>> {
            return Promise.resolve({ done: true, value: undefined });
          },
        };
      },
    };
  }

  loadFlowSource(ref: FlowVersionRef): Promise<RawFlowSource> {
    const key = ref.versionId ?? '';
    const entry = this.#versions.get(key);
    if (entry === undefined) {
      return Promise.reject(new Error('FLOW_NOT_FOUND: no seeded version for the requested id'));
    }
    return Promise.resolve({
      flowId: ref.flowId,
      versionId: asFlowVersionId(key),
      format: entry.format,
      body: entry.body,
    });
  }

  resolveDependencies(refs: readonly DependencyRef[]): Promise<readonly DependencyResolution[]> {
    return Promise.resolve(
      refs.map((ref) => ({
        ref,
        status: 'not_found' as const,
        displayName: null,
        safeMetadata: {},
      })),
    );
  }
}

async function loadFixture(): Promise<string> {
  return readFile(FIXTURE_PATH, 'utf8');
}

/** The fixture's one uniquely-named action node (trackingId 13, so its
 * derived node id is `trk_13` -- see extract-nodes.ts's identity preference
 * chain), renamed. Exercises a real `action-changed`/`relabeled` semantic
 * change against a real, sanitized configuration rather than a hand-built
 * one. */
function renameNode(rawJson: string, replacement: string): string {
  const needle = '"Golf charlie"';
  expect(rawJson.split(needle)).toHaveLength(2); // guards the guard: still unique in the fixture
  return rawJson.replace(needle, JSON.stringify(replacement));
}

const PROFILE_ID = asProfileId('profile_1');
const FLOW_ID = asFlowId('flow_1');

describe('createDiffFlow', () => {
  it('surfaces a real change between two versions of a real fixture', async () => {
    const base = await loadFixture();
    const mutated = renameNode(base, 'Golf charlie MUTATED');

    const provider = new FixtureProvider();
    provider.seed('1', 'json', base);
    provider.seed('2', 'json', mutated);

    const diffFlow = createDiffFlow({ providerFor: () => Promise.resolve(provider) });
    const result = await diffFlow(PROFILE_ID, FLOW_ID, '1', '2');

    expect(result.flowId).toBe(FLOW_ID);
    expect(result.changedNodes.some((n) => n.includes('trk_13'))).toBe(true);
    expect(result.addedNodes).toEqual([]);
    expect(result.removedNodes).toEqual([]);
  });

  it('produces an empty diff for identical versions', async () => {
    const base = await loadFixture();

    const provider = new FixtureProvider();
    provider.seed('1', 'json', base);

    const diffFlow = createDiffFlow({ providerFor: () => Promise.resolve(provider) });
    const result = await diffFlow(PROFILE_ID, FLOW_ID, '1', '1');

    expect(result.addedNodes).toEqual([]);
    expect(result.removedNodes).toEqual([]);
    expect(result.changedNodes).toEqual([]);
    expect(result.addedVariables).toEqual([]);
    expect(result.removedVariables).toEqual([]);
    expect(result.dependencyChanges).toEqual([]);
    expect(result.promptChanges).toEqual([]);
    // materialJourneyChanges is not asserted empty: it always carries one
    // diff-wide node-matching-basis line (see diff-flow.ts), which is
    // metadata about the comparison, not a reported change.
  });

  it('parses a json-format source as JSON, not YAML', async () => {
    // Valid YAML block style, and NOT valid JSON (no braces/quotes) -- a
    // parser that ignored the declared format and always reached for YAML
    // (document-bundle.ts's header comment names this exact bug as
    // something this project has already shipped once) would parse this
    // successfully. A correct implementation must call JSON.parse for a
    // 'json'-declared source and reject when that throws.
    const yamlNotJson = [
      'name: Test Flow',
      'type: inboundcall',
      'flowSequenceItemList: []',
      'variables: []',
      '',
    ].join('\n');

    const provider = new FixtureProvider();
    provider.seed('bad', 'json', yamlNotJson);

    const diffFlow = createDiffFlow({ providerFor: () => Promise.resolve(provider) });

    await expect(diffFlow(PROFILE_ID, FLOW_ID, 'bad', 'bad')).rejects.toThrow();
  });

  it('reports an error, not an empty diff, when a version cannot be loaded', async () => {
    const base = await loadFixture();

    const provider = new FixtureProvider();
    provider.seed('1', 'json', base);
    // '2' is deliberately never seeded.

    const diffFlow = createDiffFlow({ providerFor: () => Promise.resolve(provider) });

    await expect(diffFlow(PROFILE_ID, FLOW_ID, '1', '2')).rejects.toThrow();
  });

  it('never lets a tenant-authored node name reach the returned FlowDiff', async () => {
    const base = await loadFixture();
    const mutated = renameNode(base, CANARY);

    const provider = new FixtureProvider();
    provider.seed('1', 'json', base);
    provider.seed('2', 'json', mutated);

    const diffFlow = createDiffFlow({ providerFor: () => Promise.resolve(provider) });
    const result = await diffFlow(PROFILE_ID, FLOW_ID, '1', '2');

    expect(JSON.stringify(result)).not.toContain(CANARY);
  });

  it('is deterministic: the same pair of versions produces byte-identical output', async () => {
    const base = await loadFixture();
    const mutated = renameNode(base, 'Golf charlie MUTATED');

    const provider = new FixtureProvider();
    provider.seed('1', 'json', base);
    provider.seed('2', 'json', mutated);

    const diffFlow = createDiffFlow({ providerFor: () => Promise.resolve(provider) });
    const first = await diffFlow(PROFILE_ID, FLOW_ID, '1', '2');
    const second = await diffFlow(PROFILE_ID, FLOW_ID, '1', '2');

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});
