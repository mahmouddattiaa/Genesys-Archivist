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
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { access, constants as fsConstants, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import commanderPkg from 'commander';
import { createOsSecretStore, type SecretStore } from '@genesys-archivist/security';
import { asFlowId, asOrganizationId, asProfileId } from '@genesys-archivist/domain';
import {
  createGenesysProvider,
  documentBundleToDisk,
  renderDiagrams,
  openProfileStore,
  resolveSecretStore,
  runCapture,
  runIncrementalCapture,
  verifyBundle,
  type CaptureRunOptions,
} from '@genesys-archivist/composition';
import { parseCaptureArgs, type CaptureCommand, type CaptureOutcome } from './commands/capture.js';
import { runDoctor, type DoctorReport } from './commands/doctor.js';
import {
  confirmFromStdin,
  parseProfileArgs,
  readSecretFromStdin,
  runProfileAdd,
  runProfileList,
  runProfileRemove,
  runProfileSetSecret,
  runProfileShow,
  runProfileValidate,
  type ProfileCommandDeps,
} from './commands/profile.js';
import { createRealUpdateDeps, runUpdate, type UpdateCommandDeps } from './commands/update.js';

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

export interface RenderOutcome {
  readonly found: number;
  readonly rendered: number;
  readonly skipped: number;
  readonly failed: readonly { readonly path: string; readonly reason: string }[];
  readonly rendererDegraded: boolean;
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
  readonly documentBundle: (
    bundleDir: string,
    options?: { readonly renderDiagrams?: boolean },
  ) => Promise<DocumentBundleOutcome>;
  readonly renderDiagrams?: (bundleDir: string, force: boolean) => Promise<RenderOutcome>;
  /**
   * Optional so every existing `CliDeps` fake in this codebase's own test
   * suite -- none of which exercise `profile` -- keeps type-checking
   * unchanged. `buildRealDeps` always supplies it; `profile`'s own action
   * handler below fails loudly, not silently, on the one path where it could
   * ever be missing (a fake in a future test that adds a `profile` case
   * without wiring this field).
   */
  readonly profile?: ProfileCommandDeps;
  /**
   * Optional for the same reason `profile` above is: existing `CliDeps`
   * fakes in this codebase's own suite that don't exercise `update` keep
   * type-checking unchanged. `buildRealDeps` always supplies it; `update`'s
   * own action handler fails loudly, not silently, if it is ever missing.
   */
  readonly update?: UpdateCommandDeps;
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

// ---------------------------------------------------------------------------
// profile --help text
// ---------------------------------------------------------------------------

const PROFILE_HELP_DETAIL = [
  '',
  'Subcommands:',
  '',
  '  add --id <id> --display-name <name> --region <region> --org <organizationId>',
  '      --client-id <clientId> --output-root <path>',
  '                            Register a new profile. The client secret is read',
  '                            from stdin (a single line) or, on a TTY, an',
  '                            interactive prompt with the input hidden — never a',
  '                            flag, never an environment variable read here.',
  '  list                      List stored profiles: safe fields only.',
  '  show <id>                 Show one profile: safe fields only.',
  '  remove <id> [--yes]       Remove a profile. Confirms unless --yes is given.',
  '  set-secret <id>           Rotate the stored secret for a profile. Same',
  '                            stdin rule as add.',
  '  validate <id>             Check the profile parses, a secret is stored, and',
  '                            the output root is writable. Never contacts',
  '                            Genesys — use `archivist doctor` for that.',
  '',
  'The client secret is never accepted as a flag: --client-secret (or anything',
  'matching --secret/--password/--token/--credential) is refused with an',
  'explanation, on every subcommand.',
].join('\n');

// ---------------------------------------------------------------------------
// update --help text
// ---------------------------------------------------------------------------

const UPDATE_HELP_DETAIL = [
  '',
  'Unlike every other command here, this one executes code fetched from the',
  'internet on this machine: a fast-forward git merge, then whatever npm ci',
  'and the build script decide to run. It refuses outright on a dirty',
  'working tree or a remote that is not this repository, never resets or',
  'cleans the checkout, and never merges anything but a fast-forward.',
  '',
  'With no flags: checks for updates, shows what would land, asks to',
  'confirm, then pulls, installs, and rebuilds. --check stops after showing',
  'what would land. --yes skips the confirmation prompt.',
].join('\n');

function toCaptureArgv(opts: {
  readonly mode?: string;
  readonly org?: string;
  readonly flow?: readonly string[];
  readonly flowType?: readonly string[];
  readonly profile?: string;
  readonly sinceLast?: boolean;
}): string[] {
  const argv: string[] = [];
  if (opts.mode !== undefined) argv.push('--mode', opts.mode);
  if (opts.org !== undefined) argv.push('--org', opts.org);
  for (const flowId of opts.flow ?? []) argv.push('--flow', flowId);
  for (const flowType of opts.flowType ?? []) argv.push('--flow-type', flowType);
  if (opts.profile !== undefined) argv.push('--profile', opts.profile);
  // Every flag commander accepts has to be re-emitted here, because this is
  // what the real parser sees. A flag registered on the command but missing
  // from this function is accepted silently and then does nothing at all --
  // which is exactly how --since-last first appeared to work while changing
  // nothing about the run.
  if (opts.sinceLast === true) argv.push('--since-last');
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
    .option(
      '--since-last',
      're-fetch only flows that changed since the last capture, carrying the rest forward ' +
        'from the previous bundle (context mode only)',
    )
    .allowUnknownOption(false)
    .action(
      async (opts: {
        readonly mode?: string;
        readonly org?: string;
        readonly flow?: readonly string[];
        readonly flowType?: readonly string[];
        readonly profile?: string;
        readonly sinceLast?: boolean;
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
    .option(
      '--svg',
      'also draw each diagram as an .svg (slow: launches a browser, ~11 renders per flow). ' +
        'Omit this and run "archivist render" later if you decide you want pictures.',
    )
    .action(async (opts: { readonly bundle: string; readonly svg?: boolean }) => {
      const result = await deps.documentBundle(opts.bundle, { renderDiagrams: opts.svg === true });
      deps.write(
        result.ok
          ? `Generated documentation for ${String(result.documentsWritten)} flow(s).`
          : 'Documentation generation did not complete.',
      );
      for (const warning of result.warnings ?? []) deps.write(`  warning: ${warning}`);
      if (opts.svg !== true) {
        // Said once, here, rather than left for the reader to discover a
        // folder full of .mmd files they cannot open.
        deps.write(
          '  Diagrams were written as Mermaid source (.mmd). To draw them as ' +
            'images: archivist render --bundle <dir>',
        );
      }
      deps.exit(result.ok ? EXIT_OK : EXIT_FAILURE);
    });

  program
    .command('render')
    .description('Draw the Mermaid diagrams in an already-documented bundle as .svg images.')
    .requiredOption('--bundle <dir>', 'path to a bundle that has already been documented')
    .option('--force', 're-draw diagrams that already have an .svg beside them')
    .addHelpText(
      'after',
      [
        '',
        'Separate from "document" on purpose. Writing the diagram sources takes',
        'seconds; drawing them launches a headless browser and runs roughly',
        'eleven renders per flow, so a 500-flow organization is thousands of',
        'renders and tens of minutes.',
        '',
        'Document first, read what you needed, and run this only if you want the',
        'pictures. Nothing is lost by waiting: the .mmd sources are always written.',
      ].join('\n'),
    )
    .action(async (opts: { readonly bundle: string; readonly force?: boolean }) => {
      if (deps.renderDiagrams === undefined) {
        deps.write('Rendering is not available in this build.');
        deps.exit(EXIT_FAILURE);
        return;
      }
      const result = await deps.renderDiagrams(opts.bundle, opts.force === true);
      if (result.found === 0) {
        deps.write('No diagram sources found. Run "archivist document --bundle <dir>" first.');
        deps.exit(EXIT_FAILURE);
        return;
      }
      deps.write(
        `Rendered ${String(result.rendered)} of ${String(result.found)} diagram(s)` +
          (result.skipped > 0 ? `, skipped ${String(result.skipped)} already drawn` : '') +
          '.',
      );
      if (result.rendererDegraded) {
        deps.write(
          '  No browser was available, so nothing could be drawn. The .mmd sources are intact. ' +
            'Install one with: npx playwright install chromium',
        );
      }
      for (const failure of result.failed) deps.write(`  failed: ${failure.reason}`);
      deps.exit(result.failed.length === 0 && !result.rendererDegraded ? EXIT_OK : EXIT_FAILURE);
    });

  program
    .command('profile')
    .description(
      'Manage stored Genesys profiles: metadata (archivist profile add/list/show/remove) ' +
        'and credential-store secrets (archivist profile add/set-secret).',
    )
    .addHelpText('after', PROFILE_HELP_DETAIL)
    // Not further declared options: `profile`'s own subcommand and flags are
    // parsed by hand in parseProfileArgs -- see commands/profile.ts's file
    // header for why. allowUnknownOption keeps commander from rejecting (or
    // trying to interpret) anything past `profile` itself, including
    // `--client-secret`, which parseProfileArgs is what actually refuses.
    .allowUnknownOption(true)
    .action(async (_opts: unknown, command: Command) => {
      const parsed = parseProfileArgs(command.args);
      if (parsed.kind === 'error') {
        deps.write(`error: ${parsed.message}`);
        deps.exit(EXIT_FAILURE);
        return;
      }
      if (deps.profile === undefined) {
        deps.write('error: archivist profile is not configured for this invocation.');
        deps.exit(EXIT_FAILURE);
        return;
      }
      deps.exit(await runProfileCommand(deps.profile, parsed));
    });

  program
    .command('update')
    .description(
      'Pull the latest archivist release from GitHub, reinstall dependencies, and rebuild.',
    )
    .addHelpText('after', UPDATE_HELP_DETAIL)
    .option(
      '--check',
      'report only: current commit, how many commits behind, and what would land. Changes nothing.',
    )
    .option('--yes', 'skip the confirmation prompt before pulling, installing, and building')
    .allowUnknownOption(false)
    .action(async (opts: { readonly check?: boolean; readonly yes?: boolean }) => {
      if (deps.update === undefined) {
        deps.write('error: archivist update is not configured for this invocation.');
        deps.exit(EXIT_FAILURE);
        return;
      }
      const code = await runUpdate(deps.update, {
        check: opts.check === true,
        yes: opts.yes === true,
      });
      deps.exit(code);
    });

  return program;
}

// A ParsedProfileCommand's non-error variants only -- narrowed inline below
// rather than re-exported, since bin.ts is the only caller that needs to
// dispatch on it.
async function runProfileCommand(
  profileDeps: ProfileCommandDeps,
  parsed: Exclude<ReturnType<typeof parseProfileArgs>, { readonly kind: 'error' }>,
): Promise<number> {
  switch (parsed.kind) {
    case 'add':
      return runProfileAdd(profileDeps, parsed.args);
    case 'list':
      return runProfileList(profileDeps);
    case 'show':
      return runProfileShow(profileDeps, parsed.profileId);
    case 'remove':
      return runProfileRemove(profileDeps, parsed.profileId, { yes: parsed.yes });
    case 'set-secret':
      return runProfileSetSecret(profileDeps, parsed.profileId);
    case 'validate':
      return runProfileValidate(profileDeps, parsed.profileId);
  }
}

// ---------------------------------------------------------------------------
// Real dependency wiring.
//
// Every command is now wired to a real implementation. `capture`, `verify`
// and `document` used to reject with a "not wired yet" message naming what
// was missing; each of those things now exists, and the messages had gone
// stale enough to be misleading — they claimed composition did not re-export
// `runCapture`/`verifyBundle` when it already did, and that no production
// provider existed when one does.
//
// Everything reaches Genesys through `@genesys-archivist/composition`.
// `apps/**` may not import `@genesys-archivist/capture` or
// `@genesys-archivist/genesys-*` directly (eslint.config.mjs), which is the
// rule that keeps this file thin: composition is where adapters get wired,
// and this file only decides which of them to ask for.
// ---------------------------------------------------------------------------

/**
 * Narrows the CLI's own scope shape into capture's.
 *
 * The two are structurally identical except that capture keys flow ids as the
 * branded `FlowId`. The CLI parses argv into plain strings and deliberately
 * does not import capture's types (see the dependency rule above), so this is
 * where an untrusted argv string becomes a domain identifier.
 */
function toCaptureScope(scope: CaptureCommand['scope']): NonNullable<CaptureRunOptions['scope']> {
  if (scope.kind === 'flows') {
    return { kind: 'flows', flowIds: scope.flowIds.map((id) => asFlowId(id)) };
  }
  return scope.flowTypes === undefined
    ? { kind: 'all' }
    : { kind: 'all', flowTypes: scope.flowTypes };
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
  // Profiles are real now (this task): report what is actually configured,
  // rather than the permanent-looking `[]` this returned before profile
  // persistence existed. `list()`'s unreadable entries are deliberately not
  // surfaced here -- doctor reports counts and health, not per-file parse
  // errors; `archivist profile list` is where those are visible.
  const { profiles } = await openProfileStore().list();
  return runDoctor({
    nodeVersion: process.version,
    outputRoot: process.cwd(),
    // No production output root has been chosen yet (see CLAUDE.md status:
    // Phase 0 has not run). Reporting cwd as unconditionally writable would
    // be a fabricated pass; this is deliberately conservative until a real
    // configured output root exists to check.
    outputRootWritable: false,
    profiles,
    secretStoreAvailable,
  });
}

async function checkOutputRootWritable(root: string): Promise<boolean> {
  try {
    await mkdir(root, { recursive: true });
    await access(root, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs a real capture against a real Genesys organization.
 *
 * A profile is required, and not merely for convenience. Three of
 * `runCapture`'s inputs can only come from stored profile metadata:
 *
 *   - `expectedOrganizationId` is the **tenant guard**. `runCapture` compares
 *     the organization it actually reaches against this value and refuses to
 *     proceed on a mismatch, so a mistyped or swapped credential cannot
 *     silently capture the wrong customer's configuration. Passing the
 *     `--org` argument for both sides would disable the guard by making it
 *     compare a value against itself.
 *   - `root` is the profile's approved output root, which is what keeps a
 *     capture from writing wherever the process happens to be running.
 *   - the credential itself, which `createGenesysProvider` resolves from the
 *     secret store at the moment of use and never accepts as an argument.
 */
async function realCapture(
  command: CaptureCommand,
  profileStore: ReturnType<typeof openProfileStore>,
  write: (line: string) => void,
): Promise<CaptureOutcome> {
  const profileId = command.profileId;
  if (profileId === undefined) {
    throw new Error(
      'archivist capture requires --profile. The profile supplies the approved output root ' +
        'and the expected organization id that guards against capturing the wrong tenant. ' +
        'Create one with: archivist profile add',
    );
  }

  const profile = await profileStore.get(profileId);
  if (profile === null) {
    throw new Error(
      `No profile named "${profileId}". List what exists with: archivist profile list`,
    );
  }

  const provider = await createGenesysProvider({ profileId: asProfileId(profileId) });

  // The plan hash pins what this run was asked to do. `runCapture` records it
  // in the run manifest so a resumed run can refuse to continue under a
  // different plan than the one it started under.
  const planHash = createHash('sha256')
    .update(
      JSON.stringify({
        mode: command.mode,
        organizationId: command.organizationId,
        scope: command.scope,
        profileId,
      }),
    )
    .digest('hex');

  const startedAt = new Date();
  const runId = `${startedAt.toISOString().replace(/[:.]/g, '-')}_${planHash.slice(0, 6)}`;

  const shared = {
    root: profile.outputRoot,
    runId,
    planHash: `sha256:${planHash}`,
    organizationId: asOrganizationId(command.organizationId),
    expectedOrganizationId: asOrganizationId(profile.expectedOrganizationId),
    provider,
    scope: toCaptureScope(command.scope),
    profileId,
  };

  if (!command.sinceLast) return runCapture({ ...shared, mode: command.mode });

  // Incremental. Reports what it did rather than leaving an operator to
  // wonder why a run that took six minutes yesterday took four seconds today.
  const result = await runIncrementalCapture(shared);
  const { captured, carriedForward, retired, inaccessible } = result.counts;
  write(
    `  incremental: captured ${String(captured)}, carried forward ${String(carriedForward)}` +
      (retired > 0 ? `, ${String(retired)} retire-candidate(s)` : '') +
      (inaccessible > 0 ? `, ${String(inaccessible)} inaccessible` : ''),
  );
  // Named individually, not just counted: a flow that vanished or became
  // unreadable is something a person has to look at, and a number in a run
  // manifest nobody opens is not a report.
  for (const entry of result.plan.retireCandidates) {
    write(
      `  retire-candidate: ${entry.flowId} is no longer discoverable (never deleted automatically)`,
    );
  }
  for (const entry of result.plan.inaccessible) {
    write(`  inaccessible: ${entry.flowId} could not be read with this profile's permissions`);
  }
  return result;
}

async function buildRealDeps(): Promise<CliDeps> {
  const write = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };
  const profileStore = openProfileStore();
  const secretStore = await resolveSecretStore();

  return {
    write,
    exit: (code) => {
      process.exitCode = code;
    },
    doctor: realDoctorReport,
    capture: (command) => realCapture(command, profileStore, write),
    verifyBundle: async (bundleDir) => verifyBundle(resolve(bundleDir)),
    documentBundle: async (bundleDir, options) => {
      const dir = resolve(bundleDir);
      const result = await documentBundleToDisk({
        bundleDir: dir,
        // Off unless asked for. Writing the .mmd sources takes seconds;
        // drawing them is ~11 renders per flow through a headless browser.
        renderDiagrams: options?.renderDiagrams === true,
        // Documentation lands beside the bundle it was generated from rather
        // than in the profile's output root. A bundle is self-describing and
        // portable; a reader who is handed one should get its documents with
        // it, not have to know which profile produced it.
        outputRoot: dir,
        generatedAt: new Date().toISOString(),
      });
      return {
        ok: result.skipped.length === 0,
        documentsWritten: result.documentsWritten,
        // Reported, never omitted: a documentation set that silently covers
        // four of five flows is worse than one that covers four and says so.
        warnings: result.skipped.map(
          (s) => `flow ${s.flowId} version ${s.versionId} was not documented: ${s.reason}`,
        ),
      };
    },
    renderDiagrams: async (bundleDir, force) =>
      renderDiagrams({
        documentsDir: resolve(bundleDir),
        force,
        onProgress: (done, total) => {
          // Only at intervals: one line per diagram would be thousands of
          // lines across an organization, which is noise, not progress.
          if (done === total || done % 50 === 0) {
            write(`  rendered ${String(done)}/${String(total)}`);
          }
        },
      }),
    profile: {
      write,
      profileStore,
      secretStore,
      readSecret: () => readSecretFromStdin(process.stdin, process.stdout, process.stdin.isTTY),
      confirm: (message) => confirmFromStdin(process.stdin, process.stdout, message),
      checkOutputRootWritable,
    },
    update: createRealUpdateDeps(write),
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
  const deps = await buildRealDeps();
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
