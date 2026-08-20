// apps/cli/src/commands/profile.ts
//
// `archivist profile add | list | show | remove | set-secret | validate`.
//
// The one rule every function in this file exists to enforce: a client
// secret is CLI-only, forever, and never travels through an argv flag, an
// environment variable read at this layer, a log line, or an error message.
// `parseProfileArgs` below rejects anything that looks like a secret flag
// before any subcommand runs, so nothing past it ever receives a secret
// except through `readSecret()`.
//
// `bin.ts` registers a single, flat `profile` command (like `capture`,
// `verify`, and `document`) and hands this module the raw argv that follows
// it. It does not nest `add`/`list`/`show`/... as commander subcommands of a
// `profile` subcommand: a two-level `program.command('profile').command('add')`
// was tried first and found to break commander v7's `exitOverride` --
// `_checkForMissingMandatoryOptions` throws synchronously in a path that
// escapes `parseAsync()`'s promise chain for a *nested* subcommand, crashing
// the process instead of yielding a catchable `CommanderError` the way it
// does for every top-level command in this file. Parsing `profile`'s own
// subcommand and flags by hand -- exactly the approach
// `apps/cli/src/commands/capture.ts` already takes for `capture` -- sidesteps
// that bug entirely and keeps every profile subcommand's argument handling
// directly unit-testable without spawning commander at all.
import { createInterface } from 'node:readline';
import { asProfileId } from '@genesys-archivist/domain';
import {
  profileMetadataSchema,
  toSafeProfileSummary,
  type ProfileMetadata,
  type SafeProfileSummary,
  type SecretStore,
} from '@genesys-archivist/security';

// ---------------------------------------------------------------------------
// A structural mirror of @genesys-archivist/storage's `ProfileStore` and its
// `list()` result shape, not an import of it. apps/** does not depend on
// @genesys-archivist/storage at all (see eslint.config.mjs's restricted-import
// list for apps/**, and apps/cli/package.json's dependency list) -- the same
// reasoning apps/cli/src/commands/capture.ts documents for why
// `CaptureOutcome` mirrors `CaptureRunResult` from @genesys-archivist/capture
// structurally instead of importing it. `openProfileStore()` in
// @genesys-archivist/composition returns a `FileProfileStore`, which satisfies
// this shape unchanged.
// ---------------------------------------------------------------------------

export interface UnreadableProfileSummary {
  readonly profileId: string;
  readonly reason: string;
}

export interface ProfileListResult {
  readonly profiles: readonly ProfileMetadata[];
  readonly unreadable: readonly UnreadableProfileSummary[];
}

export interface ProfileStoreLike {
  list(): Promise<ProfileListResult>;
  get(profileId: string): Promise<ProfileMetadata | null>;
  put(profile: ProfileMetadata): Promise<void>;
  remove(profileId: string): Promise<void>;
}

export interface ProfileCommandDeps {
  readonly write: (line: string) => void;
  readonly profileStore: ProfileStoreLike;
  readonly secretStore: SecretStore;
  /** Reads exactly one secret from wherever the operator is supplying it
   * (piped stdin or an interactive, echo-disabled prompt). Never argv, never
   * an environment variable read here. */
  readonly readSecret: () => Promise<string>;
  readonly confirm: (message: string) => Promise<boolean>;
  readonly checkOutputRootWritable: (root: string) => Promise<boolean>;
}

const EXIT_OK = 0;
const EXIT_FAILURE = 1;

function describeError(error: unknown, fallback: string): string {
  // ZodError's own .message is safe to forward: for this schema's validators
  // (regex, min/max, strict-object unrecognized-key) every issue carries only
  // field names, constraint text, and type names -- never the offending
  // value. Still falls through to a fixed, generic fallback for anything that
  // is not an Error at all, rather than risking String(error) on an unknown
  // thrown value.
  return error instanceof Error ? error.message : fallback;
}

function formatSummaryLine(summary: SafeProfileSummary): string {
  return (
    `${summary.profileId}  ${summary.displayName}  region=${summary.region}  ` +
    `org=${summary.expectedOrganizationId}  outputRoot=${summary.outputRoot}  ` +
    `secret=${summary.secretPresent ? 'present' : 'MISSING'}  ` +
    `lastValidatedAt=${summary.lastValidatedAt ?? 'never'}`
  );
}

// ---------------------------------------------------------------------------
// Pure argv parsing for everything after `profile` on the command line. See
// the file header for why this exists instead of nested commander
// subcommands. No filesystem, network, or process access -- safe to call
// directly in a test.
// ---------------------------------------------------------------------------

export interface AddProfileArgs {
  readonly profileId: string;
  readonly displayName: string;
  readonly region: string;
  readonly organizationId: string;
  readonly clientId: string;
  readonly outputRoot: string;
}

export interface ProfileParseError {
  readonly kind: 'error';
  readonly message: string;
}

export type ParsedProfileCommand =
  | { readonly kind: 'add'; readonly args: AddProfileArgs }
  | { readonly kind: 'list' }
  | { readonly kind: 'show'; readonly profileId: string }
  | { readonly kind: 'remove'; readonly profileId: string; readonly yes: boolean }
  | { readonly kind: 'set-secret'; readonly profileId: string }
  | { readonly kind: 'validate'; readonly profileId: string };

export type ProfileParseResult = ParsedProfileCommand | ProfileParseError;

// Deliberately broad: catches --client-secret, --secret, --password,
// --token, and --credential(s) alike, on every subcommand that accepts free
// flags. A narrower list tuned to exactly "--client-secret" would be trivial
// to step around by accident with a near-miss name.
const SECRET_LIKE_FLAG = /secret|password|token|credential/i;

function isFlagToken(token: string): boolean {
  return token.startsWith('--');
}

/** The specific, explanatory rejection the task requires -- deliberately more
 * than commander's own generic "unknown option" message, because *why* this
 * is refused is exactly the fact an operator reaching for `--client-secret`
 * needs to see. */
function rejectSecretLikeFlags(tokens: readonly string[]): ProfileParseError | undefined {
  const offending = tokens.find((token) => isFlagToken(token) && SECRET_LIKE_FLAG.test(token));
  if (offending === undefined) return undefined;
  return {
    kind: 'error',
    message:
      `${offending} is not accepted: a client secret must never be a command-line argument. ` +
      'argv is visible to other processes on the same machine (ps, tasklist, /proc/<pid>/cmdline) ' +
      'and is routinely recorded in shell history. Pipe the secret on stdin instead -- for example ' +
      '`... | archivist profile add ...` -- or omit the pipe to be prompted for it interactively ' +
      'with the input hidden.',
  };
}

interface AddFlagSpec {
  readonly flag: string;
  readonly field: keyof AddProfileArgs;
}

const ADD_FLAG_SPECS: readonly AddFlagSpec[] = [
  { flag: '--id', field: 'profileId' },
  { flag: '--display-name', field: 'displayName' },
  { flag: '--region', field: 'region' },
  { flag: '--org', field: 'organizationId' },
  { flag: '--client-id', field: 'clientId' },
  { flag: '--output-root', field: 'outputRoot' },
];
const ADD_FLAG_BY_TOKEN = new Map(ADD_FLAG_SPECS.map((spec) => [spec.flag, spec.field]));

function requireValue(
  values: ReadonlyMap<keyof AddProfileArgs, string>,
  field: keyof AddProfileArgs,
): string {
  const value = values.get(field);
  if (value === undefined) {
    // Unreachable: every caller checks presence for all of ADD_FLAG_SPECS
    // before calling this. A thrown Error here would mean that invariant
    // broke, not a real user input problem.
    throw new Error(`internal error: ${field} was not collected before use.`);
  }
  return value;
}

function parseAdd(tokens: readonly string[]): ParsedProfileCommand | ProfileParseError {
  const secretRejection = rejectSecretLikeFlags(tokens);
  if (secretRejection !== undefined) return secretRejection;

  const values = new Map<keyof AddProfileArgs, string>();
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === undefined) break;
    if (!isFlagToken(token)) return { kind: 'error', message: `Unexpected argument: ${token}` };
    const field = ADD_FLAG_BY_TOKEN.get(token);
    if (field === undefined) return { kind: 'error', message: `Unknown flag: ${token}` };
    const value = tokens[index + 1];
    if (value === undefined || isFlagToken(value)) {
      return { kind: 'error', message: `${token} requires a value.` };
    }
    values.set(field, value);
    index += 2;
  }

  for (const spec of ADD_FLAG_SPECS) {
    if (!values.has(spec.field)) {
      return { kind: 'error', message: `Missing required flag: ${spec.flag} <value>.` };
    }
  }

  return {
    kind: 'add',
    args: {
      profileId: requireValue(values, 'profileId'),
      displayName: requireValue(values, 'displayName'),
      region: requireValue(values, 'region'),
      organizationId: requireValue(values, 'organizationId'),
      clientId: requireValue(values, 'clientId'),
      outputRoot: requireValue(values, 'outputRoot'),
    },
  };
}

function parseSingleId(
  subcommand: 'show' | 'set-secret' | 'validate',
  tokens: readonly string[],
): ParsedProfileCommand | ProfileParseError {
  const secretRejection = rejectSecretLikeFlags(tokens);
  if (secretRejection !== undefined) return secretRejection;

  const [id, ...extra] = tokens;
  if (id === undefined || isFlagToken(id)) {
    return { kind: 'error', message: `${subcommand} requires a profile id.` };
  }
  if (extra.length > 0) {
    return { kind: 'error', message: `Unexpected argument: ${extra[0] ?? ''}` };
  }
  return { kind: subcommand, profileId: id };
}

function parseRemove(tokens: readonly string[]): ParsedProfileCommand | ProfileParseError {
  const secretRejection = rejectSecretLikeFlags(tokens);
  if (secretRejection !== undefined) return secretRejection;

  let id: string | undefined;
  let yes = false;
  const extra: string[] = [];
  for (const token of tokens) {
    if (token === '--yes') {
      yes = true;
    } else if (isFlagToken(token)) {
      return { kind: 'error', message: `Unknown flag: ${token}` };
    } else if (id === undefined) {
      id = token;
    } else {
      extra.push(token);
    }
  }
  if (id === undefined) return { kind: 'error', message: 'remove requires a profile id.' };
  if (extra.length > 0) return { kind: 'error', message: `Unexpected argument: ${extra[0] ?? ''}` };
  return { kind: 'remove', profileId: id, yes };
}

/**
 * Parses everything after `profile` on the command line -- the subcommand
 * name plus its own flags -- into a validated command or an explanatory
 * error. See the file header for why this exists instead of commander's own
 * nested-subcommand parsing.
 */
export function parseProfileArgs(argv: readonly string[]): ProfileParseResult {
  const [action, ...rest] = argv;
  if (action === undefined) {
    return {
      kind: 'error',
      message:
        'Missing subcommand. Usage: archivist profile <add|list|show|remove|set-secret|validate> ...',
    };
  }
  switch (action) {
    case 'add':
      return parseAdd(rest);
    case 'list':
      return rest.length === 0
        ? { kind: 'list' }
        : { kind: 'error', message: `Unexpected argument: ${rest[0] ?? ''}` };
    case 'show':
      return parseSingleId('show', rest);
    case 'remove':
      return parseRemove(rest);
    case 'set-secret':
      return parseSingleId('set-secret', rest);
    case 'validate':
      return parseSingleId('validate', rest);
    default:
      return { kind: 'error', message: `Unknown profile subcommand: ${action}` };
  }
}

// ---------------------------------------------------------------------------
// add
// ---------------------------------------------------------------------------

export async function runProfileAdd(
  deps: ProfileCommandDeps,
  args: AddProfileArgs,
): Promise<number> {
  let profile: ProfileMetadata;
  try {
    profile = profileMetadataSchema.parse({
      profileId: args.profileId,
      displayName: args.displayName,
      region: args.region,
      expectedOrganizationId: args.organizationId,
      clientId: args.clientId,
      outputRoot: args.outputRoot,
    });
  } catch (error) {
    deps.write(`error: ${describeError(error, 'the profile data is invalid.')}`);
    return EXIT_FAILURE;
  }

  const secret = await deps.readSecret();
  if (secret.trim().length === 0) {
    deps.write('error: no client secret was provided on stdin.');
    return EXIT_FAILURE;
  }

  // Secret first, metadata second: if storing the secret fails, put() is
  // never reached, so no metadata file is ever written claiming a profile
  // exists that cannot actually authenticate.
  try {
    await deps.secretStore.set(asProfileId(profile.profileId), secret);
  } catch (error) {
    deps.write(
      `error: failed to store the client secret: ${describeError(error, 'unknown error.')}`,
    );
    return EXIT_FAILURE;
  }

  try {
    await deps.profileStore.put(profile);
  } catch (error) {
    deps.write(
      'error: the client secret was stored, but saving profile metadata failed: ' +
        describeError(error, 'unknown error.'),
    );
    return EXIT_FAILURE;
  }

  deps.write(`Profile "${profile.profileId}" saved.`);
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

export async function runProfileList(deps: ProfileCommandDeps): Promise<number> {
  const { profiles, unreadable } = await deps.profileStore.list();

  if (profiles.length === 0 && unreadable.length === 0) {
    deps.write('No profiles configured. Run: archivist profile add');
    return EXIT_OK;
  }

  for (const profile of profiles) {
    const secretPresent = await deps.secretStore.has(asProfileId(profile.profileId));
    deps.write(formatSummaryLine(toSafeProfileSummary(profile, secretPresent)));
  }
  // Unreadable profiles must remain visible, not silently absent -- see
  // packages/storage/src/profile-store.ts's list() contract.
  for (const bad of unreadable) {
    deps.write(`[UNREADABLE] ${bad.profileId}: ${bad.reason}`);
  }
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// show
// ---------------------------------------------------------------------------

export async function runProfileShow(deps: ProfileCommandDeps, profileId: string): Promise<number> {
  let profile: ProfileMetadata | null;
  try {
    profile = await deps.profileStore.get(profileId);
  } catch (error) {
    deps.write(
      `error: profile "${profileId}" could not be read: ${describeError(error, 'unknown error.')}`,
    );
    return EXIT_FAILURE;
  }
  if (profile === null) {
    deps.write(`Profile "${profileId}" not found.`);
    return EXIT_FAILURE;
  }
  const secretPresent = await deps.secretStore.has(asProfileId(profile.profileId));
  deps.write(formatSummaryLine(toSafeProfileSummary(profile, secretPresent)));
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

export interface RemoveProfileOptions {
  readonly yes: boolean;
}

export async function runProfileRemove(
  deps: ProfileCommandDeps,
  profileId: string,
  options: RemoveProfileOptions,
): Promise<number> {
  const existing = await deps.profileStore.get(profileId).catch(() => null);

  if (existing === null) {
    // remove() is idempotent -- nothing to confirm or do, but this is not a
    // failure: "already gone" is the state the caller asked for.
    deps.write(`Profile "${profileId}" was not present; nothing to remove.`);
    return EXIT_OK;
  }

  if (!options.yes) {
    const confirmed = await deps.confirm(`Remove profile "${profileId}"?`);
    if (!confirmed) {
      deps.write('Cancelled.');
      return EXIT_OK;
    }
  }

  // Secret first, metadata second -- the exact inverse of `add`, and for the
  // mirrored reason.
  //
  // `add` writes the secret before the metadata so a credential-store failure
  // never leaves behind metadata claiming a profile exists. Removal has the
  // opposite hazard: if the metadata went first and the secret delete then
  // failed, the keyring would hold a live credential that no profile
  // references and no listing shows. An orphaned secret is worse than a
  // profile that refused to delete, because nothing afterwards can find it.
  let secretRemoved: boolean;
  try {
    secretRemoved = await deps.secretStore.remove(asProfileId(profileId));
  } catch (error) {
    // The message is the store's own, which is written never to contain the
    // secret. Nothing further is appended from the error object.
    deps.write(
      `Refusing to remove profile "${profileId}": its stored secret could not be deleted, ` +
        'and removing the profile would leave a credential nothing references. ' +
        `Reason: ${error instanceof Error ? error.message : 'unknown credential store failure'}`,
    );
    return EXIT_FAILURE;
  }

  await deps.profileStore.remove(profileId);
  deps.write(
    `Profile "${profileId}" removed` +
      (secretRemoved ? ' along with its stored secret.' : '; no stored secret was present.'),
  );
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// set-secret
// ---------------------------------------------------------------------------

export async function runProfileSetSecret(
  deps: ProfileCommandDeps,
  profileId: string,
): Promise<number> {
  let existing: ProfileMetadata | null;
  try {
    existing = await deps.profileStore.get(profileId);
  } catch (error) {
    deps.write(
      `error: profile "${profileId}" could not be read: ${describeError(error, 'unknown error.')}`,
    );
    return EXIT_FAILURE;
  }
  if (existing === null) {
    deps.write(`Profile "${profileId}" not found. Run: archivist profile add`);
    return EXIT_FAILURE;
  }

  const secret = await deps.readSecret();
  if (secret.trim().length === 0) {
    deps.write('error: no client secret was provided on stdin.');
    return EXIT_FAILURE;
  }

  try {
    await deps.secretStore.set(asProfileId(existing.profileId), secret);
  } catch (error) {
    deps.write(
      `error: failed to store the client secret: ${describeError(error, 'unknown error.')}`,
    );
    return EXIT_FAILURE;
  }

  deps.write(`Secret rotated for profile "${existing.profileId}".`);
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// validate
//
// Deliberately does not contact Genesys -- that is `archivist doctor`'s job
// (`genesys_connection_check` at the MCP layer, once it exists). This checks
// only what is entirely local: the profile parses, a secret is on file, and
// the configured output root is writable.
// ---------------------------------------------------------------------------

export async function runProfileValidate(
  deps: ProfileCommandDeps,
  profileId: string,
): Promise<number> {
  let profile: ProfileMetadata | null;
  try {
    profile = await deps.profileStore.get(profileId);
  } catch (error) {
    deps.write(`[FAIL] metadata: ${describeError(error, 'profile could not be read.')}`);
    return EXIT_FAILURE;
  }
  if (profile === null) {
    deps.write(`[FAIL] metadata: profile "${profileId}" was not found. Run: archivist profile add`);
    return EXIT_FAILURE;
  }
  deps.write('[PASS] metadata: profile parses and is well-formed.');

  const secretPresent = await deps.secretStore.has(asProfileId(profile.profileId));
  deps.write(
    secretPresent
      ? '[PASS] secret: a client secret is stored for this profile.'
      : '[FAIL] secret: no client secret stored. Run: archivist profile set-secret',
  );

  const outputRootWritable = await deps.checkOutputRootWritable(profile.outputRoot);
  deps.write(
    outputRootWritable
      ? '[PASS] output-root: output root exists and is writable.'
      : '[FAIL] output-root: output root is missing or not writable.',
  );

  deps.write(
    'Note: this does not contact Genesys. Run archivist doctor for a live connection check.',
  );
  return secretPresent && outputRootWritable ? EXIT_OK : EXIT_FAILURE;
}

// ---------------------------------------------------------------------------
// Real stdin wiring: reading a secret, and a yes/no confirmation.
//
// Both take the stream(s) as parameters rather than reaching for
// `process.stdin`/`process.stdout` directly, so a test can exercise the real
// line-reading logic against a fake, in-memory `Readable` instead of a mocked
// `readSecret`/`confirm` function that would leave this logic untested.
// ---------------------------------------------------------------------------

function readSingleLine(stdin: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const rl = createInterface({ input: stdin, terminal: false });
    let settled = false;
    rl.once('line', (line: string) => {
      settled = true;
      rl.close();
      resolvePromise(line);
    });
    rl.once('close', () => {
      if (!settled) resolvePromise('');
    });
    rl.once('error', (err: unknown) => {
      reject(err instanceof Error ? err : new Error('failed to read from stdin.'));
    });
  });
}

function promptHiddenSecret(
  stdin: NodeJS.ReadableStream,
  stdout: NodeJS.WritableStream,
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const rl = createInterface({ input: stdin, output: stdout, terminal: true });
    // Node's readline has no public "hidden input" mode. Overriding this
    // internal hook to swallow echoed keystrokes (while still letting the
    // prompt text itself print) is the standard workaround -- justified here
    // because a client secret must never be visible on screen, in a terminal
    // scrollback buffer, or to anyone glancing at the operator's screen,
    // which is exactly why it is never accepted as an argv flag either.
    const hiddenEcho = rl as unknown as { _writeToOutput: (text: string) => void };
    hiddenEcho._writeToOutput = (text: string) => {
      if (text.includes('Client secret')) stdout.write(text);
    };
    rl.question('Client secret: ', (answer: string) => {
      rl.close();
      stdout.write('\n');
      resolvePromise(answer);
    });
    rl.once('error', (err: unknown) => {
      reject(err instanceof Error ? err : new Error('failed to read the client secret.'));
    });
  });
}

export function readSecretFromStdin(
  stdin: NodeJS.ReadableStream,
  stdout: NodeJS.WritableStream,
  isTTY: boolean,
): Promise<string> {
  return isTTY ? promptHiddenSecret(stdin, stdout) : readSingleLine(stdin);
}

export async function confirmFromStdin(
  stdin: NodeJS.ReadableStream,
  stdout: NodeJS.WritableStream,
  message: string,
): Promise<boolean> {
  const rl = createInterface({ input: stdin, output: stdout, terminal: false });
  try {
    const answer = await new Promise<string>((resolvePromise) => {
      rl.question(`${message} [y/N] `, resolvePromise);
    });
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}
