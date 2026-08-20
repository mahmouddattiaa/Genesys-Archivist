// @genesys-archivist/cli
// The `archivist` CLI.
// Implemented by the tasks in docs/superpowers/plans/.
export { runDoctor } from './commands/doctor.js';
export { runDocument } from './commands/document.js';
export type { DoctorCheck, DoctorDeps, DoctorReport } from './commands/doctor.js';
export type { DocumentDeps, DocumentResult } from './commands/document.js';
