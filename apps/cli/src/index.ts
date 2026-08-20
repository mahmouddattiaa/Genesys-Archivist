// @genesys-archivist/cli
// The `archivist` CLI.
// Implemented by the tasks in docs/superpowers/plans/.
export { runDoctor } from './commands/doctor.js';
export { runDocument } from './commands/document.js';
export { parseCaptureArgs } from './commands/capture.js';
export { buildProgram } from './bin.js';
export type { DoctorCheck, DoctorDeps, DoctorReport } from './commands/doctor.js';
export type { DocumentDeps, DocumentResult } from './commands/document.js';
export type {
  CaptureCommand,
  CaptureMode,
  CaptureOutcome,
  CaptureParseError,
  CaptureParseResult,
  CaptureScope,
} from './commands/capture.js';
export type { CliDeps, DocumentBundleOutcome, VerificationOutcome } from './bin.js';
