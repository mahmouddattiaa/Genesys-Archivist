// packages/composition/src/diff-flow.ts
//
// The real implementation of `ArchivistPort['diffFlow']`: loads both
// requested flow versions through an injected `GenesysSourceProvider`,
// normalizes each into a `FlowSnapshot`, computes the semantic diff
// (`@genesys-archivist/analysis`'s `diffSnapshots`), classifies it
// (`classifyChanges`), and maps the result onto the `FlowDiff` DTO.
//
// `createDiffFlow` takes the provider resolver by injection, exactly the
// way `createArchivistPort` takes `deps.providerFor` -- see that file's
// header comment for why: it is what keeps this file provable against a
// hand-built `GenesysSourceProvider` (or `FakeSourceProvider`) with no
// network and no real credential. `wire.ts` wires the same
// `providerFor: (profileId) => createGenesysProvider(...)` closure into
// both this factory and `createArchivistPort`.
//
// AGENTS.md: node, variable, and dependency *names* are tenant-authored and
// are prompt-injection vectors. `diff.ts` already keeps them out of its
// structural layer (`SemanticChange` carries none at all -- see that
// module's header comment) and wraps everything else in `UntrustedText`,
// bounded. `FlowDiff` (packages/application/src/port.ts) crosses an MCP
// boundary and reaches a model, and its list fields are typed as bare
// `readonly string[]` -- not `UntrustedText` -- so this module deliberately
// never reads an entry's `.value` out of any `UntrustedText` it receives
// from `diff.ts`. Every string this module returns is built only from
// structural facts: node/variable/dependency ids, Architect's own field and
// role names, match basis, and review classification. A tenant-authored
// name has nowhere safe to go until a dedicated diff-detail resource exists
// to carry it the way `flow-snapshot`/`flow-evidence` already do for other
// content (see this task's final report).
import {
  asFlowVersionId,
  type FlowId,
  type GenesysSourceProvider,
  type ProfileId,
  type RawFlowSource,
} from '@genesys-archivist/domain';
import type { ArchivistPort, FlowDiff } from '@genesys-archivist/application';
import {
  classifyChanges,
  diffSnapshots,
  type ChangeClassification,
  type ClassifiedChange,
  type DependencyDiffEntry,
  type NodeDiffEntry,
  type SemanticChange,
  type SemanticDiff,
  type VariableDiffEntry,
} from '@genesys-archivist/analysis';
import { normalizeFlow, type FlowSnapshot } from '@genesys-archivist/normalization';
import { parse as parseYaml } from 'yaml';

export interface DiffFlowDeps {
  /** Resolves a real `GenesysSourceProvider` for one profile. Mirrors
   * `ArchivistPortDeps.providerFor` exactly (archivist-port.ts) -- a real
   * caller wires the same `createGenesysProvider` closure into both. */
  readonly providerFor: (profileId: ProfileId) => Promise<GenesysSourceProvider>;
  /** Overridable for deterministic tests; defaults to the wall clock. Only
   * feeds `FlowSnapshot.source.extractedAt`, which `diffSnapshots` never
   * reads -- see `loadSnapshot` -- so this has no effect on the diff
   * itself, only on the intermediate snapshot's own record of when it was
   * built. */
  readonly now?: () => Date;
}

/** The most list items any single `FlowDiff` field returns. `docs/03`'s
 * "large detail is exposed as a resource, never inlined" applies once a
 * real diff-detail resource kind exists (it does not yet -- see this file's
 * header comment); until then, this is the only bound standing between a
 * large flow and an unbounded tool result, so it is enforced here rather
 * than left to the MCP tool layer. */
const MAX_LIST_ITEMS = 50;

function capped(items: readonly string[]): readonly string[] {
  if (items.length <= MAX_LIST_ITEMS) return items;
  const omitted = items.length - MAX_LIST_ITEMS;
  return [
    ...items.slice(0, MAX_LIST_ITEMS),
    `… ${String(omitted)} further item(s) omitted (no diff-detail resource exists yet).`,
  ];
}

/** Mirrors `archivist-port.ts`'s own `parseDefinition` exactly, including
 * its reason for existing as a third small copy rather than a shared
 * export: `document-bundle.ts` already carries the identical two-line
 * function for the same reason (that file's own header comment), and
 * `archivist-port.ts` is outside this task's file ownership so its version
 * cannot be exported and reused here. */
function parseDefinition(format: 'yaml' | 'json', body: string): unknown {
  return format === 'json' ? (JSON.parse(body) as unknown) : (parseYaml(body) as unknown);
}

interface LoadedVersion {
  readonly snapshot: FlowSnapshot;
  readonly resolvedVersionId: string;
}

/**
 * Loads and normalizes one flow version. Every failure (the provider
 * rejecting, the body not parsing as its declared format, or the parsed
 * config not validating as an Architect flow configuration) is rethrown as
 * a fresh, sanitized `Error` naming which side (`'from'`/`'to'`) failed --
 * never the underlying error's own message. A flow definition is
 * tenant-authored, and a JSON/YAML parser or schema validator will happily
 * quote the exact value it choked on (`document-bundle.ts`'s identical
 * choice, for the identical reason).
 *
 * Throwing here -- rather than returning some "could not load" sentinel --
 * is deliberate: `createDiffFlow`'s caller must see a version that could
 * not be loaded as an error, never as "nothing changed". An empty
 * `FlowDiff` is indistinguishable from "identical versions" to anyone who
 * only reads the result, and AGENTS.md forbids exactly that kind of silent
 * substitution.
 */
async function loadSnapshot(
  provider: GenesysSourceProvider,
  flowId: FlowId,
  requestedVersion: string,
  label: 'from' | 'to',
  now: () => Date,
): Promise<LoadedVersion> {
  const versionId = asFlowVersionId(requestedVersion);

  let source: RawFlowSource;
  try {
    source = await provider.loadFlowSource({ flowId, versionId });
  } catch {
    throw new Error(
      `genesys_flow_diff: could not load the "${label}" flow version from the source provider.`,
    );
  }

  let config: unknown;
  try {
    config = parseDefinition(source.format, source.body);
  } catch {
    throw new Error(
      `genesys_flow_diff: the "${label}" flow version's definition is not valid ${source.format}.`,
    );
  }

  let snapshot: FlowSnapshot;
  try {
    snapshot = normalizeFlow({
      config,
      source: {
        provider: 'platform-api',
        adapterVersion: 'diff-flow-0.1.0',
        extractedAt: now().toISOString(),
        // Neither field is consumed by diffSnapshots (it never reads
        // `.source` at all) or returned in the FlowDiff DTO; both are
        // placeholders rather than fabricated real values. A caller that
        // needs the profile's real region/organization for this purpose
        // would have to thread a ProfileStore lookup through
        // DiffFlowDeps -- not done here because nothing downstream reads
        // it (see this file's header comment for the wider "no field
        // silently dropped" discipline, which does not apply to values
        // that were never derived from anything in the first place).
        region: '',
        organizationId: 'unknown',
        trackingIdsAvailable: true,
        redactionApplied: true,
      },
      flow: {
        // RawFlowSource carries no separate display name; the flow id is
        // used as an honest fallback, matching archivist-port.ts's
        // inspectFlow and document-bundle.ts's identical choice for the
        // identical reason.
        id: flowId,
        name: flowId,
        type: 'unknown',
        secure: false,
        version: { selected: String(source.versionId), state: 'published' },
      },
    });
  } catch {
    throw new Error(
      `genesys_flow_diff: the "${label}" flow version did not validate as an Architect flow configuration.`,
    );
  }

  return { snapshot, resolvedVersionId: String(source.versionId) };
}

// ---------------------------------------------------------------------------
// FlowDiff field builders. Every function below reads only structural facts
// (ids, Architect's own field/role names, basis, review classification) --
// see this file's header comment for why no `UntrustedText.value` is ever
// read here.
// ---------------------------------------------------------------------------

function nodeLabel(entry: NodeDiffEntry): string {
  const nodeId = entry.afterNodeId ?? entry.beforeNodeId ?? 'unknown-node';
  return `${nodeId} (basis=${entry.basis})`;
}

function variableLabel(entry: VariableDiffEntry): string {
  const variableId = entry.afterVariableId ?? entry.beforeVariableId ?? 'unknown-variable';
  return entry.secure ? `${variableId} (secure)` : variableId;
}

function dependencyLabel(
  entry: DependencyDiffEntry,
  verb: 'added' | 'removed' | 'changed',
): string {
  const dependencyId = entry.afterDependencyId ?? entry.beforeDependencyId ?? 'unknown-dependency';
  const type = entry.type ?? 'unknown-type';
  const fields = entry.changedFields.length > 0 ? ` fields=${entry.changedFields.join(',')}` : '';
  return `${verb} ${dependencyId} type=${type}${fields}`;
}

/** Diff-wide metadata -- not itself a reported change -- so it is not
 * subject to `capped` the way the change lists are; there is always
 * exactly one of these. AGENTS.md: "never present inference as fact". A
 * diff computed on `derivedIdentity` (or `mixed`/`none`) is a strictly
 * weaker claim than one computed entirely on `trackingId` (diff.ts's own
 * `NodeIdentityBasis` doc comment), and `FlowDiff` has no dedicated field
 * for it, so it travels here, first, on every call -- the closest fit
 * among the DTO's existing fields, and the only one guaranteed to reach
 * every caller regardless of whether anything else changed.
 */
function basisNote(diff: SemanticDiff): string {
  return (
    `diff basis: node-matching=${diff.matching.overallBasis}, ` +
    `graphHashChanged=${String(diff.graphHashChanged)}, ` +
    `positionalOnlyReorder=${String(diff.positionalOnlyReorder)}`
  );
}

/** `classifyChanges`'s `blocksApproval` is a hard gate (its own doc
 * comment: never derive "should this block?" from string comparison on
 * `highestReviewLevel` alone). `FlowDiff` has no field for it either, so it
 * is surfaced the same way `basisNote` is -- as an explicit line, not
 * folded silently into a count. */
function blockNote(classification: ChangeClassification): string | null {
  if (!classification.blocksApproval) return null;
  const count = classification.counts['coverage-regression'];
  return `BLOCKED: ${String(count)} coverage-regression change(s) require resolution before approval.`;
}

function describeChangeDetail(change: SemanticChange): string {
  switch (change.category) {
    case 'flow-metadata-changed':
      return `field=${change.field}`;
    case 'entry-point-changed':
      return `nodeId=${change.nodeId} basis=${change.basis}`;
    case 'menu-choice-changed':
      return `fromNodeId=${change.fromNodeId} aspect=${change.aspect}`;
    case 'action-changed':
      return `nodeId=${change.nodeId} basis=${change.basis} aspect=${change.aspect}`;
    case 'condition-expression-changed':
      return `fromNodeId=${change.fromNodeId}`;
    case 'variable-changed':
      return `variableId=${change.variableId} aspect=${change.aspect} secure=${String(change.secure)}`;
    case 'prompt-reference-changed':
      return change.subject.kind === 'node' ? `nodeId=${change.subject.nodeId}` : 'flow-languages';
    case 'dependency-changed':
      return (
        `dependencyId=${change.dependencyId} type=${change.dependencyType ?? 'unknown'} ` +
        `aspect=${change.aspect}`
      );
    case 'outcome-path-changed':
      return `fromNodeId=${change.fromNodeId} outcomeKind=${change.outcomeKind}`;
    case 'published-version-only-changed':
      return 'no semantic graph change';
    case 'coverage-changed':
      return (
        `nodeId=${change.nodeId ?? 'unknown'} basis=${change.basis ?? 'unmatched'} ` +
        `direction=${change.direction} ${change.beforeSupportLevel ?? '?'}->${change.afterSupportLevel ?? '?'}`
      );
    case 'unclassified-change':
      // `note` is a structural description diff.ts wrote itself (a field
      // name, a role string) -- never tenant text (diff.ts's own doc
      // comment on `UnclassifiedChanged`).
      return change.note;
  }
}

/**
 * One line per classified change: operation, docs/07 category, the
 * structural detail above, and the review classification. This is the
 * source `materialJourneyChanges` is built from, in full -- see this file's
 * header comment on why `changedNodes`/`dependencyChanges`/etc. carry
 * identity only: this is the one field that carries the *shape* of every
 * change (docs/03's "material caller-journey changes"), because
 * `SemanticChange` itself is structural-only by construction and therefore
 * safe to place here without narrowing it further.
 */
function describeClassifiedChange(entry: ClassifiedChange): string {
  const detail = describeChangeDetail(entry.change);
  return `${entry.change.operation} ${entry.change.category} (${detail}) [${entry.category}/${entry.reviewLevel}]`;
}

/**
 * Builds `ArchivistPort['diffFlow']`. See this file's header comment for
 * the injection pattern and the tenant-text policy every field builder
 * above follows.
 */
export function createDiffFlow(deps: DiffFlowDeps): ArchivistPort['diffFlow'] {
  const now = deps.now ?? ((): Date => new Date());

  return async (profileId, flowId, fromVersion, toVersion): Promise<FlowDiff> => {
    const provider = await deps.providerFor(profileId);

    const [before, after] = await Promise.all([
      loadSnapshot(provider, flowId, fromVersion, 'from', now),
      loadSnapshot(provider, flowId, toVersion, 'to', now),
    ]);

    const diff = diffSnapshots(before.snapshot, after.snapshot);
    const classification = classifyChanges(diff);

    const materialJourneyChanges: string[] = [basisNote(diff)];
    const block = blockNote(classification);
    if (block !== null) materialJourneyChanges.push(block);
    for (const entry of classification.classified) {
      materialJourneyChanges.push(describeClassifiedChange(entry));
    }

    const dependencyChanges: string[] = [
      ...diff.dependencies.added.map((d) => dependencyLabel(d, 'added')),
      ...diff.dependencies.removed.map((d) => dependencyLabel(d, 'removed')),
      ...diff.dependencies.changed.map((d) => dependencyLabel(d, 'changed')),
    ];

    const promptChanges: string[] = [
      ...diff.prompts.added.map((p) => `added promptId=${p.promptId} nodeId=${p.nodeId}`),
      ...diff.prompts.removed.map((p) => `removed promptId=${p.promptId} nodeId=${p.nodeId}`),
    ];

    return {
      flowId,
      fromVersion: before.resolvedVersionId,
      toVersion: after.resolvedVersionId,
      addedNodes: capped(diff.nodes.added.map(nodeLabel)),
      removedNodes: capped(diff.nodes.removed.map(nodeLabel)),
      changedNodes: capped(diff.nodes.changed.map(nodeLabel)),
      addedVariables: capped(diff.variables.added.map(variableLabel)),
      removedVariables: capped(diff.variables.removed.map(variableLabel)),
      dependencyChanges: capped(dependencyChanges),
      promptChanges: capped(promptChanges),
      materialJourneyChanges: capped(materialJourneyChanges),
      // No `ResourceLocator` kind exists yet for diff detail
      // (packages/application/src/port.ts only has flow-snapshot/
      // flow-evidence/flow-business/flow-technical/run-report/run-errors),
      // so there is nowhere to point this at. `capped` above is this
      // module's own bound in its place; see this task's final report.
      detailResourceUri: null,
    };
  };
}
