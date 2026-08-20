// apps/mcp-server/src/port.ts
//
// `ArchivistPort` and every DTO it uses now live in
// `@genesys-archivist/application`. `packages/composition` cannot import
// from `apps/*` (dependency direction is enforced by ESLint the other way
// around), so the interface had to move somewhere both this server and the
// composition root can see -- see that package's `port.ts` for the full
// interface, every DTO, and the comments that record why each one is shaped
// the way it is.
//
// This file is now a pure re-export. None of the nine files under
// `tools/`, `resources.ts`, or `wire.ts` change: they all import from
// `../port.js` (or `./port.js`), and that import still resolves to exactly
// the same names it always did.
export type {
  ArchivistPort,
  ConnectionCheckResult,
  FlowDescriptor,
  FlowDiff,
  FlowInspection,
  FlowListPage,
  FlowListQuery,
  FlowPublicationState,
  Plan,
  PlanFlowSelector,
  PlanInput,
  PlanPreview,
  PlanResult,
  PlanScope,
  ProfileSummary,
  ResourceDocument,
  ResourceLocator,
  RunError,
  RunState,
  RunStatus,
} from '@genesys-archivist/application';
export { PlanRejectedError } from '@genesys-archivist/application';
