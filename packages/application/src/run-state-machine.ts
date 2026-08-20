// packages/application/src/run-state-machine.ts
//
// The durable run state machine docs/03-mcp-contract.md describes:
//
//   planned -> queued -> extracting -> normalizing -> analyzing -> rendering
//   -> validating -> promoting -> completed
//
// with terminal alternatives `failed`, `cancelled`, and
// `completed_with_warnings`. This module is the single source of truth for
// which transitions are legal; `packages/composition/src/archivist-port.ts`
// drives it, `packages/composition/src/run-store.ts` persists the resulting
// `state` field into a run manifest, and neither of those is allowed to
// invent a transition this file does not grant.
//
// Deliberately pure: no clock, no I/O, nothing but data in and data out. That
// is what makes "every legal transition is exercised and every illegal one
// is rejected" exhaustively testable without a filesystem or a fake timer.
//
// Reconciling this vocabulary against `packages/capture/src/capture-run.ts`'s
// own phase names (`discovering`, `fetching_definitions`, `walking_resources`,
// `downloading_assets`, `sealing`) is discussed in this task's final report:
// the short version is that they do not merge into one enum, and
// `schemas/run-manifest.schema.json`'s `stage` discriminator already exists
// so that they do not have to -- a capture run's own manifest uses capture's
// phase words, and this state machine's `RunState` (the vocabulary docs/03
// promises an MCP client) treats the whole of Stage 1 as one coarse
// `extracting` phase from the client's point of view.
import type { RunState } from './port.js';

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * Every event this machine accepts.
 *
 * The eight `BEGIN_*`/`COMPLETE*`/`ENQUEUE` events each correspond to exactly
 * one edge in docs/03's single linear chain -- naming them individually
 * (rather than one generic `{type: 'advance'; to: RunState}`) is what lets
 * `transition`'s switch be exhaustively checked by
 * `@typescript-eslint/switch-exhaustiveness-check` and lets a caller's intent
 * ("I am beginning the rendering phase") be visible in its own call site
 * instead of encoded only in a string it passes.
 */
export type RunEventType =
  | 'ENQUEUE'
  | 'BEGIN_EXTRACTING'
  | 'BEGIN_NORMALIZING'
  | 'BEGIN_ANALYZING'
  | 'BEGIN_RENDERING'
  | 'BEGIN_VALIDATING'
  | 'BEGIN_PROMOTING'
  | 'COMPLETE'
  | 'COMPLETE_WITH_WARNINGS'
  | 'FAIL'
  | 'REQUEST_CANCEL'
  | 'CHECKPOINT';

export interface RunEvent {
  readonly type: RunEventType;
}

// ---------------------------------------------------------------------------
// Progress counters
// ---------------------------------------------------------------------------

/**
 * Per-flow progress. `totalFlows` is set once, at planning time, and must
 * never decrease afterward -- a run cannot un-plan a flow mid-execution.
 * `completedFlows`/`failedFlows`/`skippedFlows` only ever increase: an
 * outcome, once recorded for a flow, is never retracted by this machine
 * (a later re-attempt of the *run* after a resume is a fresh
 * `RunProgress`, not a mutation of a stale one -- see run-store.ts).
 */
export interface RunProgress {
  readonly totalFlows: number;
  readonly completedFlows: number;
  readonly failedFlows: number;
  readonly skippedFlows: number;
}

export function emptyProgress(): RunProgress {
  return { totalFlows: 0, completedFlows: 0, failedFlows: 0, skippedFlows: 0 };
}

export class NonMonotonicProgressError extends Error {
  constructor(field: string) {
    super(`Progress field "${field}" must not decrease.`);
    this.name = 'NonMonotonicProgressError';
  }
}

/** Sets the planned flow count. Throws rather than silently clamping if a
 * caller ever passes a smaller total than is already recorded -- that would
 * hide a real bug (a plan shrinking after execution began) behind a number
 * that looks merely conservative. */
export function withTotalFlows(progress: RunProgress, total: number): RunProgress {
  if (total < progress.totalFlows) throw new NonMonotonicProgressError('totalFlows');
  return { ...progress, totalFlows: total };
}

export type FlowOutcome = 'completed' | 'failed' | 'skipped';

/** Records one flow's terminal outcome. Each call increments exactly one
 * counter by one; there is no way to decrement, which is the whole of what
 * "monotonic" means for this type. */
export function recordFlowOutcome(progress: RunProgress, outcome: FlowOutcome): RunProgress {
  switch (outcome) {
    case 'completed':
      return { ...progress, completedFlows: progress.completedFlows + 1 };
    case 'failed':
      return { ...progress, failedFlows: progress.failedFlows + 1 };
    case 'skipped':
      return { ...progress, skippedFlows: progress.skippedFlows + 1 };
  }
}

// ---------------------------------------------------------------------------
// The machine
// ---------------------------------------------------------------------------

export interface RunMachineState {
  readonly runState: RunState;
  /** Recorded the instant a cancellation is requested; only actually moves
   * `runState` to `cancelled` at the next `CHECKPOINT` event -- that gap is
   * the entire meaning of "cooperative". */
  readonly cancellationRequested: boolean;
  readonly progress: RunProgress;
}

export function initialRunMachineState(): RunMachineState {
  return { runState: 'planned', cancellationRequested: false, progress: emptyProgress() };
}

export class IllegalRunTransitionError extends Error {
  readonly fromState: RunState;
  readonly event: RunEventType;
  constructor(fromState: RunState, event: RunEventType) {
    super(`Cannot apply event "${event}" to a run in state "${fromState}".`);
    this.name = 'IllegalRunTransitionError';
    this.fromState = fromState;
    this.event = event;
  }
}

const TERMINAL_STATES: ReadonlySet<RunState> = new Set([
  'completed',
  'failed',
  'cancelled',
  'completed_with_warnings',
]);

export function isTerminalRunState(state: RunState): boolean {
  return TERMINAL_STATES.has(state);
}

interface LinearEdge {
  readonly from: RunState;
  readonly to: RunState;
}

/** The one legal linear successor for each sequencing event, keyed by the
 * exact state it may fire from. `FAIL`, `REQUEST_CANCEL`, and `CHECKPOINT`
 * are not part of this chain -- they are handled as their own cases in
 * `transition` below, since none of them has a single fixed "from" state. */
const LINEAR_TRANSITIONS: ReadonlyMap<RunEventType, LinearEdge> = new Map([
  ['ENQUEUE', { from: 'planned', to: 'queued' }],
  ['BEGIN_EXTRACTING', { from: 'queued', to: 'extracting' }],
  ['BEGIN_NORMALIZING', { from: 'extracting', to: 'normalizing' }],
  ['BEGIN_ANALYZING', { from: 'normalizing', to: 'analyzing' }],
  ['BEGIN_RENDERING', { from: 'analyzing', to: 'rendering' }],
  ['BEGIN_VALIDATING', { from: 'rendering', to: 'validating' }],
  ['BEGIN_PROMOTING', { from: 'validating', to: 'promoting' }],
  ['COMPLETE', { from: 'promoting', to: 'completed' }],
  ['COMPLETE_WITH_WARNINGS', { from: 'promoting', to: 'completed_with_warnings' }],
]);

/**
 * Applies one event to one state, returning the next state or throwing
 * `IllegalRunTransitionError`. Never silently ignores an illegal transition
 * -- AGENTS.md's "never silently drop" rule applies to state transitions
 * exactly as much as it applies to an unsupported flow node.
 */
export function transition(current: RunMachineState, event: RunEvent): RunMachineState {
  switch (event.type) {
    case 'ENQUEUE':
    case 'BEGIN_EXTRACTING':
    case 'BEGIN_NORMALIZING':
    case 'BEGIN_ANALYZING':
    case 'BEGIN_RENDERING':
    case 'BEGIN_VALIDATING':
    case 'BEGIN_PROMOTING':
    case 'COMPLETE':
    case 'COMPLETE_WITH_WARNINGS': {
      const edge = LINEAR_TRANSITIONS.get(event.type);
      if (edge === undefined || current.runState !== edge.from) {
        throw new IllegalRunTransitionError(current.runState, event.type);
      }
      return { ...current, runState: edge.to };
    }

    case 'FAIL': {
      // A run may fail from anywhere in the pipeline -- that is the entire
      // point of a failure path -- but never from a state that is already
      // terminal: a completed or cancelled run has nothing left to fail.
      if (isTerminalRunState(current.runState)) {
        throw new IllegalRunTransitionError(current.runState, event.type);
      }
      return { ...current, runState: 'failed' };
    }

    case 'REQUEST_CANCEL': {
      // docs/03: "cancellation ... is idempotent" and a terminal run's
      // cancellation is "a no-op that succeeds" -- not an error, and not a
      // state change, since a terminal run has no further checkpoint at
      // which the request could ever take effect.
      if (isTerminalRunState(current.runState)) return current;
      return { ...current, cancellationRequested: true };
    }

    case 'CHECKPOINT': {
      // A checkpoint on an already-terminal run is meaningless -- there is
      // no further execution for it to gate -- so it is rejected rather than
      // silently accepted, unlike REQUEST_CANCEL above. Only a run that is
      // still actually executing calls CHECKPOINT on itself.
      if (isTerminalRunState(current.runState)) {
        throw new IllegalRunTransitionError(current.runState, event.type);
      }
      if (!current.cancellationRequested) return current;
      return { ...current, runState: 'cancelled', cancellationRequested: false };
    }
  }
}
