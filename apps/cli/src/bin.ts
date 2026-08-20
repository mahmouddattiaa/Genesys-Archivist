#!/usr/bin/env node
// apps/cli/src/bin.ts
//
// The `archivist` executable. `buildProgram` assembles the whole command
// tree from an injected `CliDeps` and returns it unparsed, so a test can
// exercise every command without spawning a process or touching a real
// credential store, filesystem, or Genesys organization. The bottom of this
// file is the only part that runs a real process: it builds real
// dependencies and calls `program.parseAsync(process.argv)`, guarded so that
// importing this module (as the tests do, for `buildProgram`) never
// triggers it.
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import commanderPkg from 'commander';
import { createOsSecretStore, type SecretStore } from '@genesys-archivist/security';
import { asProfileId } from '@genesys-archivist/domain';
import { parseCaptureArgs, type CaptureCommand, type CaptureOutcome } from './commands/capture.js';
import { runDoctor, type DoctorReport } from './commands/doctor.js';

// commander v7's typings model a CJS `export = commander` namespace rather
// than true ESM named exports (see node_modules/commander/typings/index.d.ts).
// `import { Command } from 'commander'` resolves at runtime but confuses the
// type checker's `this`-returning fluent methods into two structurally
// distinct "Command" types. Destructuring the default import instead gives a
// single, unambiguous binding for both the constructor and the `Command`
// type derived from it.
const { Command, CommanderError } = commanderPkg;
type Command = InstanceType<typeof Command>;

// ---------------------------------------------------------------------------
// Dependencies. Every command's actual work — talking to disk, the OS
// credential store, or (eventually) Genesys — happens behind one of these,
// never inline in an action handler. That is what makes buildProgram
// testable without a real bundle, a real keyring, or a real organization.
// ---------------------------------------------------------------------------

export interface VerificationOutcome {
  readonly ok: boolean;
  readonly findings: readonly { readonly code: string; readonly message: string }[];
}

export interface DocumentBundleOutcome {
  readonly ok: boolean;
  readonly documentsWritten: number;
  readonly warnings?: readonly string[];
}

export interface CliDeps {
  readonly write: (line: string) => void;
  readonly exit: (code: number) => void;
  readonly doctor: () => Promise<DoctorReport>;
  readonly capture: (command: CaptureCommand) => Promise<CaptureOutcome>;
  readonly verifyBundle: (bundleDir: string) => Promise<VerificationOutcome>;
  readonly documentBundle: (bundleDir: string) => Promise<DocumentBundleOutcome>;
}

export type { CaptureCommand, CaptureOutcome } from './commands/capture.js';

// ---------------------------------------------------------------------------
// Exit codes.
//
//   0  success
//   1  failure — bad arguments, a run that failed or was cancelled, a bundle
//      that does not verify, doctor reporting a hard failure
//   2  completed, but with warnings — the operation finished, but the result
//      (a capture bundle, most often) may be incomplete. An operator
//      scripting this needs to tell "worked" from "worked but incomplete";
//      collapsing this into exit 0 would hide exactly that distinction.
// ---------------------------------------------------------------------------

const EXIT_OK = 0;
const EXIT_FAILURE = 1;
const EXIT_COMPLETED_WITH_WARNINGS = 2;

function readVersion(): string {
  // Same relative-depth trick used in bundle-verifier.ts: this file and its
  // compiled dist/bin.js sit at the same depth below apps/cli, so one
  // relative path resolves correctly from either src (vitest) or dist (the
  // published bin). createRequire sidesteps needing --resolve-json-module.
  const require = createRequire(import.meta.url);
  const pkg = require('../package.json') as { readonly version: string };
  return pkg.version;
}

// ---------------------------------------------------------------------------
// capture --help text
// ---------------------------------------------------------------------------

const CAPTURE_DESCRIPTION =
  'Capture flows from a Genesys Cloud organization into a sealed capture bundle.';

const CAPTURE_HELP_DETAIL = [
  '',
  'Two modes (see docs/adr/ADR-018-capture-modes.md). Choose deliberately: they',
  'produce bundles that are not interchangeable.',
  '',
  '  --mode context    Fast, safe to run across a whole organization routinely.',
  '                     Captures flow definitions and the resource manifest',
  '                     (names, ids) that already travels with them, at no extra',
  '                     cost. Never fetches resource bodies, prompt audio, or',
  '                     data-table rows. A context bundle CANNOT be migrated —',
  '                     it is missing everything a rebuild would need.',
  '',
  '  --mode migration   Slower and much larger. Walks every referenced resource',
  '                     to full depth and downloads prompt audio and data-table',
  '                     rows, so the sealed bundle is sufficient on its own to',
  '                     rebuild these flows on another platform or org.',
  '',
  'Omit --flow to capture every flow in the organization (optionally narrowed',
  'by --flow-type). Give one or more --flow to capture only those flows —',
  '--flow and --flow-type cannot be combined.',
].join('\n');

function toCaptureArgv(opts: {
  readonly mode?: string;
  readonly org?: string;
  readonly flow?: readonly string[];
  readonly flowType?: readonly string[];
  readonly profile?: string;
}): string[] {
  const argv: string[] = [];
  if (opts.mode !== undefined) argv.push('--mode', opts.mode);
  if (opts.org !== undefined) argv.push('--org', opts.org);
  for (const flowId of opts.flow ?? []) argv.push('--flow', flowId);
  for (const flowType of opts.flowType ?? []) argv.push('--flow-type', flowType);
  if (opts.profile !== undefined) argv.push('--profile', opts.profile);
  return argv;
}

function collect(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

function reportCaptureOutcome(deps: CliDeps, outcome: CaptureOutcome): void {
  switch (outcome.state) {
    case 'completed': {
      deps.write(
        `Capture completed.${outcome.contentHash !== undefined ? ` ${outcome.contentHash}` : ''}`,
      );
      deps.exit(EXIT_OK);
      return;
    }
    case 'completed_with_warnings': {
      deps.write('Capture completed with warnings; the bundle may be incomplete.');
      for (const warning of outcome.warnings ?? []) deps.write(`  warning: ${warning.message}`);
      deps.exit(EXIT_COMPLETED_WITH_WARNINGS);
      return;
    }
    case 'failed':
    case 'cancelled': {
      deps.write(`Capture ${outcome.state}.`);
      for (const error of outcome.errors ?? []) deps.write(`  error: ${error.message}`);
      deps.exit(EXIT_FAILURE);
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// The command tree
// ---------------------------------------------------------------------------

export function buildProgram(deps: CliDeps): Command {
  const program: Command = new Command();
  program.name('archivist');
  program.description(
    'Capture Genesys Cloud Architect flows and generate documentation from a sealed bundle.',
  );
  program.version(readVersion());
  // exitOverride must be set before any subcommand is created: commander
  // copies inherited settings onto a subcommand at the moment .command()
  // creates it, so setting this afterward would not reach commands
  // registered earlier. With it set here, every subcommand below throws a
  // CommanderError instead of calling process.exit directly, which is what
  // lets both this file's own real entry point and every test share one
  // error-handling path.
  program.exitOverride();
  program.configureOutput({
    writeOut: (str) => {
      deps.write(str.replace(/\n$/, ''));
    },
    writeErr: (str) => {
      deps.write(str.replace(/\n$/, ''));
    },
  });

  program
    .command('doctor')
    .description(
      'Check that this machine is ready to run archivist: Node version, output root, credential store, profiles.',
    )
    .action(async () => {
      const report = await deps.doctor();
      for (const check of report.checks) {
        deps.write(`[${check.status.toUpperCase()}] ${check.name}: ${check.detail}`);
      }
      deps.exit(report.ok ? EXIT_OK : EXIT_FAILURE);
    });

  program
    .command('capture')
    .description(CAPTURE_DESCRIPTION)
    .addHelpText('after', CAPTURE_HELP_DETAIL)
    .option(
      '--mode <mode>',
      'context (fast, org-wide, documentation only; cannot be migrated) or ' +
        'migration (full depth; bundle can rebuild these flows elsewhere)',
    )
    .option('--org <organizationId>', 'Genesys Cloud organization id to capture from')
    .option(
      '--flow <flowId>',
      'capture only this flow (repeatable); omit to capture every flow in the organization',
      collect,
      [],
    )
    .option(
      '--flow-type <flowType>',
      'restrict scope to this flow type when --flow is omitted (repeatable)',
      collect,
      [],
    )
    .option('--profile <profileId>', 'stored profile supplying credentials and the output root')
    .allowUnknownOption(false)
    .action(
      async (opts: {
        readonly mode?: string;
        readonly org?: string;
        readonly flow?: readonly string[];
        readonly flowType?: readonly string[];
        readonly profile?: string;
      }) => {
        const parsed = parseCaptureArgs(toCaptureArgv(opts));
        if (parsed.kind === 'error') {
          deps.write(`error: ${parsed.message}`);
          deps.exit(EXIT_FAILURE);
          return;
        }
        const outcome = await deps.capture(parsed);
        reportCaptureOutcome(deps, outcome);
      },
    );

  program
    .command('verify')
    .description(
      'Verify a sealed capture bundle: recompute its content hash and check it against bundle-manifest.json.',
    )
    .requiredOption('--bundle <dir>', 'path to a capture bundle directory')
    .action(async (opts: { readonly bundle: string }) => {
      const result = await deps.verifyBundle(opts.bundle);
      if (result.ok) {
        deps.write('Bundle verified: contents match bundle-manifest.json.');
      } else {
        deps.write(`Bundle verification failed with ${String(result.findings.length)} finding(s):`);
        for (const finding of result.findings) deps.write(`  [${finding.code}] ${finding.message}`);
      }
      deps.exit(result.ok ? EXIT_OK : EXIT_FAILURE);
    });

  program
    .command('document')
    .description(
      'Generate business.md, technical.md, and operations.md for every flow in a captured bundle.',
    )
    .requiredOption('--bundle <dir>', 'path to a capture bundle directory')
    .action(async (opts: { readonly bundle: string }) => {
      const result = await deps.documentBundle(opts.bundle);
      deps.write(
        result.ok
          ? `Generated documentation for ${String(result.documentsWritten)} flow(s).`
          : 'Documentation generation did not complete.',
      );
      for (const warning of result.warnings ?? []) deps.write(`  warning: ${warning}`);
      deps.exit(result.ok ? EXIT_OK : EXIT_FAILURE);
    });

  return program;
}

// ---------------------------------------------------------------------------
// Real dependency wiring.
//
// Only what is genuinely available today is wired for real:
//
//   - doctor is fully real: Node version, output root writability, and a
//     live (never secret-reading) probe of the OS credential store.
//   - capture, verify, and document are NOT yet wired to real
//     implementations. `runCapture`/`resumeCapture`/`verifyBundle` live in
//     `@genesys-archivist/capture`, which apps/** may not import directly
//     (eslint.config.mjs) — they must be re-exported through
//     `@genesys-archivist/composition`, which does not yet do so.
//     `document --bundle <dir>` additionally needs something that does not
//     exist yet at all: an orchestrator that reads every flow out of a
//     bundle directory and calls `runDocument` (composition, single-flow)
//     once per flow. Faking success here would violate the same rule this
//     whole codebase is built around — never claim a run completed when it
//     did not — so each of the three fails loudly with a specific,
//     actionable message instead of silently doing nothing.
// ---------------------------------------------------------------------------

function notYetAvailable(command: string, need: string): Error {
  return new Error(
    `archivist ${command} is not wired to a real implementation yet: ${need} ` +
      'This command is fully implemented and tested against injected dependencies; ' +
      'only the production wiring is pending.',
  );
}

const DOCTOR_PROBE_PROFILE = asProfileId('archivist-doctor-probe');

async function probeSecretStore(store: SecretStore): Promise<boolean> {
  try {
    // .has() on a profile id that (almost certainly) has no stored secret
    // never reads a real secret: a miss returns false without touching
    // credential material. It still exercises the same call path a real
    // lookup would, so an unreachable keyring is caught here rather than on
    // the first real capture.
    await store.has(DOCTOR_PROBE_PROFILE);
    return true;
  } catch {
    return false;
  }
}

async function realDoctorReport(): Promise<DoctorReport> {
  const secretStoreAvailable = await probeSecretStore(createOsSecretStore());
  return runDoctor({
    nodeVersion: process.version,
    outputRoot: process.cwd(),
    // No production output root has been chosen yet (see CLAUDE.md status:
    // Phase 0 has not run). Reporting cwd as unconditionally writable would
    // be a fabricated pass; this is deliberately conservative until a real
    // configured output root exists to check.
    outputRootWritable: false,
    profiles: [],
    secretStoreAvailable,
  });
}

function buildRealDeps(): CliDeps {
  return {
    write: (line) => {
      process.stdout.write(`${line}\n`);
    },
    exit: (code) => {
      process.exitCode = code;
    },
    doctor: realDoctorReport,
    capture: () =>
      Promise.reject(
        notYetAvailable(
          'capture',
          'packages/composition must re-export runCapture/resumeCapture from ' +
            '@genesys-archivist/capture, and a production GenesysSourceProvider must exist ' +
            '(pending Phase 0).',
        ),
      ),
    verifyBundle: () =>
      Promise.reject(
        notYetAvailable(
          'verify',
          'packages/composition must re-export verifyBundle from @genesys-archivist/capture.',
        ),
      ),
    documentBundle: () =>
      Promise.reject(
        notYetAvailable(
          'document',
          'a bundle-level document orchestrator does not exist yet: something that reads every ' +
            'flow out of a bundle directory and calls the existing single-flow runDocument ' +
            '(composition) once per flow.',
        ),
      ),
  };
}

// ---------------------------------------------------------------------------
// Real entry point. Guarded so importing this module for `buildProgram` (as
// every test does) never triggers a real run against process.argv.
// ---------------------------------------------------------------------------

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return fileURLToPath(import.meta.url) === resolve(entry);
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const deps = buildRealDeps();
  const program = buildProgram(deps);
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    if (error instanceof CommanderError) {
      deps.exit(error.exitCode);
      return;
    }
    // Anything else is this file's own bug or a rejected deps.* call that
    // was not already turned into a report by the command's own handler.
    // Never let a stack trace (which can carry a filesystem path with a
    // customer name in it) reach the terminal.
    deps.write(
      `error: ${error instanceof Error ? error.message : 'an unexpected error occurred.'}`,
    );
    deps.exit(EXIT_FAILURE);
  }
}

if (isMainModule()) {
  await main();
}
