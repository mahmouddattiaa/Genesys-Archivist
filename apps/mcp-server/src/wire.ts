// apps/mcp-server/src/wire.ts
//
// Shows how a real `ArchivistPort` would be constructed from
// `@genesys-archivist/composition` -- and documents exactly why it cannot be
// built for real yet. `packages/composition/src/index.ts` is owned by
// another agent this wave and currently re-exports only the Stage 2
// document pipeline (`runDocument`, `documentBundle`) and Stage 1 capture
// (`runCapture`, `resumeCapture`, `verifyBundle`). None of that is an
// `ArchivistPort`: there is no profile store, no connection check, no flow
// discovery/inspection, no plan/run state machine, and no resource reader
// behind a Genesys-facing adapter anywhere in this repository yet (see
// CLAUDE.md's Status section -- `packages/genesys-source` and
// `packages/genesys-platform` are still empty).
//
// TODO(wave-2): once `packages/application` grows the use cases this port
// needs (list profiles, check a connection, list/inspect flows, plan/start/
// get/cancel a run, diff two versions, read a resource) and composition
// re-exports them, replace every method body below with a real call through
// those exports. Nothing in `server.ts`, any `tools/*.ts` file, or any test
// should need to change -- they depend on `ArchivistPort` (port.ts), not on
// this file.
import type { FlowId, ProfileId } from '@genesys-archivist/domain';
import type {
  ArchivistPort,
  ConnectionCheckResult,
  FlowInspection,
  FlowListPage,
  FlowListQuery,
  FlowDiff,
  PlanInput,
  PlanResult,
  ProfileSummary,
  ResourceDocument,
  ResourceLocator,
  RunStatus,
} from './port.js';

/** A fixed, content-free message: matches the house style in
 * apps/cli/src/bin.ts's `notYetAvailable`, which exists for the identical
 * reason -- faking a successful result here would violate the same rule
 * this whole codebase is built around (never claim an operation completed
 * when it did not). */
function notWiredYet(operation: string): Error {
  return new Error(
    `genesys-archivist-mcp's ${operation} is not wired to a real implementation yet: ` +
      'packages/application does not yet expose the use case this operation needs, and ' +
      'packages/composition does not yet re-export it. See wire.ts TODO(wave-2).',
  );
}

// Every parameter below is required by `ArchivistPort`'s shape but genuinely
// unused: each method only rejects. Keeping the full, correctly-typed
// parameter list (rather than `(...args: unknown[])`) is deliberate --
// wave-2 fills in one real implementation at a time, and a parameter that is
// already named and typed is one fewer thing to get right under a
// signature that TypeScript would otherwise let drift.
/* eslint-disable @typescript-eslint/no-unused-vars */
class UnwiredArchivistPort implements ArchivistPort {
  listProfiles(): Promise<readonly ProfileSummary[]> {
    return Promise.reject(notWiredYet('genesys_profiles_list'));
  }

  checkConnection(_profileId: ProfileId): Promise<ConnectionCheckResult> {
    return Promise.reject(notWiredYet('genesys_connection_check'));
  }

  listFlows(_profileId: ProfileId, _query: FlowListQuery): Promise<FlowListPage> {
    return Promise.reject(notWiredYet('genesys_flows_list'));
  }

  inspectFlow(_profileId: ProfileId, _flowId: FlowId, _version?: string): Promise<FlowInspection> {
    return Promise.reject(notWiredYet('genesys_flow_inspect'));
  }

  createPlan(_input: PlanInput): Promise<PlanResult> {
    return Promise.reject(notWiredYet('genesys_docs_plan'));
  }

  startRun(_planId: string, _planHash: string): Promise<RunStatus> {
    return Promise.reject(notWiredYet('genesys_docs_run_start'));
  }

  getRun(_runId: string): Promise<RunStatus> {
    return Promise.reject(notWiredYet('genesys_docs_run_get'));
  }

  cancelRun(_runId: string): Promise<RunStatus> {
    return Promise.reject(notWiredYet('genesys_docs_run_cancel'));
  }

  diffFlow(
    _profileId: ProfileId,
    _flowId: FlowId,
    _fromVersion: string,
    _toVersion: string,
  ): Promise<FlowDiff> {
    return Promise.reject(notWiredYet('genesys_flow_diff'));
  }

  readResource(_locator: ResourceLocator): Promise<ResourceDocument | null> {
    return Promise.reject(notWiredYet('a genesys-docs:// resource read'));
  }
}

/**
 * Builds the port `bin.ts` wires into the real server. Every method rejects
 * with a specific, actionable error today; the server still starts and
 * completes MCP initialization, because nothing about the `initialize`
 * handshake calls into the port -- only an actual tool call reaches
 * `UnwiredArchivistPort`, the same "safe to start, honest on first real use"
 * shape `archivist doctor` uses in apps/cli.
 */
export function buildRealPort(): ArchivistPort {
  return new UnwiredArchivistPort();
}
