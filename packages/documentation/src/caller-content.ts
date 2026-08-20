// packages/documentation/src/caller-content.ts
//
// Shared by business.ts and technical.ts: both need to answer "what does
// this node play or say", from two different sources that must never be
// conflated:
//
//  1. A resolved prompt-library reference -- `FlowSnapshotNode.promptRefs`,
//     joined onto `dependencies[].displayName` (the same id space,
//     normalize.ts / extract-prompts.ts). This is the answer for a node
//     that plays a recorded/managed prompt asset.
//  2. Architect's own inline TTS/communication construct, preserved bounded
//     and structural inside `settings` by extract-settings.ts. This is the
//     answer for a node that speaks text composed directly in its own
//     configuration rather than pointing at a library asset (measured
//     across the corpus: inboundcall-47, bot-187, and securecall-39 all
//     play everything this way -- see extract-prompts.test.ts).
//
// Per AGENTS.md, neither source is guessed at. A `promptRefs` entry this
// snapshot's own `dependencies` cannot resolve is reported as unresolved
// rather than silently dropped -- `extractPromptReferences` guarantees this
// never happens for a real capture, but this module does not trust that
// invariant blindly, the same defensive stance `technical.ts` already takes
// for `Finding.kind`. Inline content that is entirely variable- or
// unrecognised-construct-driven is reported as "not recorded" rather than
// invented.
//
// This module returns raw (unescaped) structural facts only. Every value it
// returns that originated in tenant-authored configuration -- a
// dependency's `displayName`, a literal string fragment out of `settings`
// -- is exactly as untrusted as any other tenant text this package handles,
// and callers MUST route it through `escapeMarkdown` / `escapeTableCell`
// themselves before it reaches a document, the same as every other
// tenant-authored string in this package.

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Settings fields Architect uses to carry genuinely caller-playable
 * content, as opposed to internal logic (a `DecisionAction`'s `expression`)
 * or bookkeeping. Measured against the corpus's field-name survey:
 * `PlayAudioAction` and `Menu` nest their audio one level down, under
 * `prompts.defaultAudio` (extract-settings.ts's own motivating case for its
 * one-level container recursion); `CommunicateAction` carries it directly
 * as `communication`; every `AskFor*`/`WaitForInputAction`/
 * `DigitalMenuAction`/`AskSurveyQuestionAction` carries the text read to
 * the caller directly as `question`.
 *
 * This is a deliberately bounded whitelist, not a full per-node-type model
 * of Architect's schema. Fields it does not (yet) cover -- for example
 * `TransferPureMatchAction`'s `preTransferAudio`/`failureTransferAudio` --
 * are not surfaced by this module; see this task's final report.
 */
const PLAYABLE_TOP_LEVEL_FIELDS: readonly string[] = ['communication', 'question'];

const MAX_DESCRIBED_VALUE_DEPTH = 12;

/**
 * Walks a `describeValueRef`-shaped value (extract-settings.ts) collecting
 * every `str`-typed literal fragment it carries, in encounter order.
 * Returns `true` if the walk also passed through a variable read or an
 * unrecognised ("opaque") construct -- content this module cannot render as
 * text -- so a caller can say the recovered fragments are partial rather
 * than presenting them as the whole story.
 *
 * `depth` is a defensive bound, not a load-bearing one: extract-settings.ts
 * already caps expression depth/width before this value ever reaches
 * `settings`. This guards against a shape this module has not seen rather
 * than against anything the corpus is known to produce.
 */
function collectLiteralFragments(value: unknown, depth: number, into: string[]): boolean {
  if (depth > MAX_DESCRIBED_VALUE_DEPTH || !isRecord(value)) return false;
  const kind = value['kind'];
  if (kind === 'literal' && value['dataType'] === 'str' && typeof value['text'] === 'string') {
    if (value['text'].length > 0) into.push(value['text']);
    return false;
  }
  if (kind === 'variableRef' || kind === 'opaque') return true;
  if (kind === 'expression' && Array.isArray(value['operands'])) {
    let sawUnrepresented = false;
    for (const operand of value['operands']) {
      if (collectLiteralFragments(operand, depth + 1, into)) sawUnrepresented = true;
    }
    return sawUnrepresented;
  }
  return false;
}

export interface InlineAudioContent {
  /** Literal spoken-text fragments recovered, in encounter order. May be
   * empty even when this node does carry inline audio content -- when the
   * content is composed entirely from a variable or an unrecognised
   * construct, there is no literal wording to show. */
  readonly fragments: readonly string[];
  /** `true` when at least part of the underlying content could not be
   * rendered as literal text (a variable substitution, or a construct this
   * module does not recognise). Never omit this from a rendered document --
   * showing only the recovered fragments without it would present a
   * partial fact as the complete one. */
  readonly partial: boolean;
}

/**
 * Finds inline caller-playable content on a node's `settings`, per
 * `PLAYABLE_TOP_LEVEL_FIELDS` above. Returns `null` when the node carries
 * none of the recognised fields at all -- distinct from
 * `{ fragments: [], partial: true }`, which means the field exists but this
 * module could not recover any of its literal wording.
 */
export function findInlineAudioContent(
  settings: Readonly<Record<string, unknown>>,
): InlineAudioContent | null {
  const candidates: unknown[] = [];
  const prompts = settings['prompts'];
  if (isRecord(prompts) && 'defaultAudio' in prompts) candidates.push(prompts['defaultAudio']);
  for (const field of PLAYABLE_TOP_LEVEL_FIELDS) {
    if (field in settings) candidates.push(settings[field]);
  }
  if (candidates.length === 0) return null;

  const fragments: string[] = [];
  let partial = false;
  for (const candidate of candidates) {
    if (collectLiteralFragments(candidate, 0, fragments)) partial = true;
  }
  return { fragments, partial };
}

/** Structural minimum this module needs from a dependency, to resolve a
 * `promptRefs` entry. */
export interface PromptLibraryDependency {
  readonly dependencyId: string;
  readonly displayName: string | null;
  readonly evidenceIds: readonly string[];
}

export interface ResolvedPromptReference {
  readonly resolved: true;
  readonly promptId: string;
  readonly displayName: string | null;
  readonly evidenceIds: readonly string[];
}

/** A `promptRefs` entry with no matching entry in `dependencies`. Per
 * AGENTS.md this is reported, never silently dropped -- even though a real
 * capture never produces it (`extractPromptReferences`'s own guarantee),
 * this module does not trust that invariant blindly. */
export interface UnresolvedPromptReference {
  readonly resolved: false;
  readonly promptId: string;
}

export type PromptReference = ResolvedPromptReference | UnresolvedPromptReference;

/**
 * Joins a node's `promptRefs` onto `dependencies[].displayName` -- the same
 * id space (normalize.ts / extract-prompts.ts), so this is a direct lookup,
 * never a heuristic or fuzzy match. Sorted by prompt id for deterministic
 * output regardless of `promptRefs`'s own (already-deduplicated-but-
 * insertion-ordered) array order.
 */
export function resolvePromptReferences(
  promptRefs: readonly string[],
  dependenciesById: ReadonlyMap<string, PromptLibraryDependency>,
): readonly PromptReference[] {
  return [...promptRefs].sort(compareStrings).map((promptId): PromptReference => {
    const dep = dependenciesById.get(promptId);
    if (dep === undefined) return { resolved: false, promptId };
    return {
      resolved: true,
      promptId,
      displayName: dep.displayName,
      evidenceIds: dep.evidenceIds,
    };
  });
}
