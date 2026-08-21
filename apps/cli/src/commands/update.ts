// apps/cli/src/commands/update.ts
//
// `archivist update` -- pull the latest release of this tool from GitHub,
// reinstall dependencies, and rebuild, so a developer running the MCP server
// locally never has to touch git by hand.
//
// This command is not like the rest of this codebase. Every other command
// only ever *reads* a customer's Genesys organization or a local bundle.
// This one executes code fetched from the internet on the developer's own
// machine -- a fast-forward `git merge`, then whatever `npm ci` and the build
// script decide to run. That earns it a stricter posture than "just another
// CLI command":
//
//   - Refuse outright on a dirty working tree or a remote that does not match
//     the expected GitHub host/repo. Never merge over local changes, never
//     silently pull from somewhere the developer did not point `origin` at.
//   - Never `git reset --hard`, `git clean`, or force anything. A
//     fast-forward merge or nothing -- see `performPull` below.
//   - Show what is about to land (commit count, short log) and require
//     confirmation, unless `--yes` is given.
//   - On a failure partway through (most likely `npm ci` or the build), say
//     exactly which step failed and that the working tree now holds newer
//     code than the last successful build. No automatic rollback is
//     attempted: a partially-reverted repository is a worse state to hand
//     back to a developer than one that is honestly ahead of its last known
//     good build.
//
// `runUpdate` below is the entire orchestration -- argument handling,
// refusal, confirmation, step sequencing, and exit-code selection -- and it
// depends only on `UpdateCommandDeps`, an interface of plain async functions.
// That is what makes it unit-testable without a real git checkout, network
// access, or a subprocess: a test hands it a fake `UpdateCommandDeps` and
// asserts on what `runUpdate` reported and which of the fake's functions it
// did or did not call. `createRealUpdateDeps` at the bottom of this file is
// the only part of this command that actually shells out, and it is
// deliberately not unit-tested here -- see the file header note in
// `apps/cli/test/update-command.test.ts`.
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { confirmFromStdin } from './profile.js';

const execFile = promisify(execFileCallback);

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export interface UpdateOptions {
  readonly check: boolean;
  readonly yes: boolean;
}

/**
 * Everything `runUpdate` needs to know about the repository's current state,
 * gathered by one read-only pass. Read-only is load-bearing: this is exactly
 * what `--check` reports, so nothing that produces it may touch the working
 * tree, the index, or the branch pointer. Fetching remote-tracking refs
 * (`git fetch`) is the one exception -- it updates `.git`'s bookkeeping about
 * what the remote has, not the checkout itself, which is what makes an
 * accurate "N commits behind" possible without it being a lie for `--check`
 * to report.
 */
export interface RepoStatus {
  /** Paths only, per the design constraint -- never diff content. Empty when
   * the working tree is clean. */
  readonly dirtyPaths: readonly string[];
  /** False when the checked-out branch is not tracking the expected
   * `origin` (github.com/mahmouddattiaa/genesys-architect-docs-mcp): no
   * upstream at all, an upstream on a different remote, or `origin` itself
   * repointed at a fork. */
  readonly remoteOk: boolean;
  /** Set whenever `remoteOk` is false -- a plain-language statement of what
   * was actually found, per the design constraint that a mismatch must say
   * plainly what it found rather than refuse silently. */
  readonly remoteDetail?: string;
  /** Short hash of HEAD, safe to print. */
  readonly currentCommit: string;
  readonly behindCount: number;
  /** `git log --oneline`-style lines, newest first, for what would land. */
  readonly shortLog: readonly string[];
}

export interface StepResult {
  readonly ok: boolean;
  /** Present only on failure -- a short, human-readable reason. Never
   * expected to carry a credential: git and npm do not print one on a
   * fast-forward merge or a dependency install, and nothing here echoes an
   * environment variable or a file's contents into it. */
  readonly detail?: string;
}

export interface UpdateCommandDeps {
  readonly write: (line: string) => void;
  readonly confirm: (message: string) => Promise<boolean>;
  readonly status: () => Promise<RepoStatus>;
  readonly pull: () => Promise<StepResult>;
  readonly install: () => Promise<StepResult>;
  readonly build: () => Promise<StepResult>;
}

const EXIT_OK = 0;
const EXIT_FAILURE = 1;

// ---------------------------------------------------------------------------
// Orchestration. Pure with respect to I/O -- everything it does is through
// `deps`, so a test never has to shell out to exercise any branch below.
// ---------------------------------------------------------------------------

export async function runUpdate(deps: UpdateCommandDeps, options: UpdateOptions): Promise<number> {
  const status = await deps.status();

  // Both refusal checks run unconditionally, `--check` included. Neither
  // mutates anything -- `status()` is the same read-only call either way --
  // and a developer running `--check` benefits from being told *why* an
  // update would be refused, not just what would land if it weren't.
  if (status.dirtyPaths.length > 0) {
    deps.write(
      'Refusing to update: the working tree has uncommitted changes. Commit, stash, or ' +
        'discard them yourself, then run archivist update again.',
    );
    for (const path of status.dirtyPaths) deps.write(`  dirty: ${path}`);
    return EXIT_FAILURE;
  }

  if (!status.remoteOk) {
    deps.write(
      'Refusing to update: this checkout is not tracking the expected repository ' +
        '(github.com/mahmouddattiaa/genesys-architect-docs-mcp).',
    );
    deps.write(`  ${status.remoteDetail ?? 'the remote could not be verified.'}`);
    return EXIT_FAILURE;
  }

  if (status.behindCount === 0) {
    deps.write(`Already up to date at ${status.currentCommit}.`);
    return EXIT_OK;
  }

  deps.write(
    `${String(status.behindCount)} commit(s) behind, currently at ${status.currentCommit}:`,
  );
  for (const line of status.shortLog) deps.write(`  ${line}`);

  if (options.check) {
    deps.write('Run without --check to update.');
    return EXIT_OK;
  }

  if (!options.yes) {
    const confirmed = await deps.confirm(
      'Pull these commits, reinstall dependencies, and rebuild?',
    );
    if (!confirmed) {
      deps.write('Cancelled. Nothing was changed.');
      return EXIT_OK;
    }
  }

  deps.write('Pulling...');
  const pulled = await deps.pull();
  if (!pulled.ok) {
    deps.write(`error: pull failed: ${pulled.detail ?? 'unknown error.'}`);
    deps.write('Nothing was changed: the pull did not complete, so no fast-forward happened.');
    return EXIT_FAILURE;
  }
  deps.write('Pull complete.');

  deps.write('Installing dependencies...');
  const installed = await deps.install();
  if (!installed.ok) {
    deps.write(`error: dependency install failed: ${installed.detail ?? 'unknown error.'}`);
    // No rollback, by design -- see the file header. The pull already
    // landed, so the tree is honestly ahead of whatever was last built; that
    // is reported rather than papered over.
    deps.write(
      'The working tree now holds newer code than the last successful build. ' +
        'Fix the problem above and re-run archivist update, or run npm ci by hand.',
    );
    return EXIT_FAILURE;
  }
  deps.write('Install complete.');

  deps.write('Building...');
  const built = await deps.build();
  if (!built.ok) {
    deps.write(`error: build failed: ${built.detail ?? 'unknown error.'}`);
    deps.write(
      'The working tree now holds newer code than the last successful build. ' +
        'Fix the problem above and re-run archivist update, or run the build by hand.',
    );
    return EXIT_FAILURE;
  }
  deps.write('Build complete.');

  deps.write(`Updated and rebuilt.`);
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// Real wiring: the only part of this file that touches git, npm, or a
// subprocess. Not unit-tested directly -- `runUpdate` above is where this
// command's actual logic lives and is tested; this is deliberately thin
// plumbing around `execFile`, exercised in practice by running the real
// command, not by a test that would otherwise need a real git checkout.
// ---------------------------------------------------------------------------

/** github.com/mahmouddattiaa/genesys-architect-docs-mcp, lowercased, with no
 * protocol, no trailing `.git`, and no userinfo -- see `normalizeRemoteUrl`.
 * This is the one repo `archivist update` will ever pull from. */
const EXPECTED_REMOTE = 'github.com/mahmouddattiaa/genesys-architect-docs-mcp';

// npm ships as npm.cmd on Windows. Naming the platform-correct executable
// keeps this on execFile's no-shell path (see the file header on this
// command's stricter posture) instead of falling back to `shell: true`,
// which is what a naive "just run npm" would otherwise need on Windows.
const NPM_COMMAND = process.platform === 'win32' ? 'npm.cmd' : 'npm';

// Generous but bounded: npm's install/build output can be verbose, and the
// default 1 MiB buffer truncates it mid-line. This does not change what a
// failure reports -- describeSubprocessFailure still caps what is shown.
const MAX_BUFFER = 20 * 1024 * 1024;

async function git(args: readonly string[], cwd: string): Promise<string> {
  const { stdout } = await execFile('git', [...args], { cwd, maxBuffer: MAX_BUFFER });
  return stdout.trim();
}

/**
 * Like `git`, but does not trim.
 *
 * `git status --porcelain` encodes meaning in leading whitespace: the first of
 * the two status characters is a space for an unstaged change, so " M path".
 * Trimming the whole output strips that space from the *first line only*, and
 * the fixed-width `slice(3)` that follows then eats the first character of
 * that one path -- "packages/..." came back as "ackages/...", while every
 * later line was fine.
 *
 * Two reasonable behaviours combining into a wrong one, and only observable by
 * running the command: trimming command output is right for a commit hash or a
 * branch name, and wrong for a format where a leading space is data.
 */
async function gitRaw(args: readonly string[], cwd: string): Promise<string> {
  const { stdout } = await execFile('git', [...args], { cwd, maxBuffer: MAX_BUFFER });
  return stdout.replace(/\r?\n$/, '');
}

/** Reduces any of the URL forms `git remote get-url` can hand back --
 * `https://host/owner/repo(.git)`, `ssh://git@host/owner/repo(.git)`,
 * `git@host:owner/repo(.git)` -- to a bare, lowercased `host/owner/repo`, so
 * the three all compare equal against `EXPECTED_REMOTE`. */
function normalizeRemoteUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\.git$/i, '');
  const scpLike = /^[^/@]+@([^:]+):(.+)$/.exec(trimmed);
  if (scpLike) {
    // Both groups are mandatory (no `?`) in this pattern, so a match
    // guarantees both are present -- the `?? ''` is only here because
    // TypeScript widens every RegExpExecArray element to `string | undefined`
    // under noUncheckedIndexedAccess, not because either can really be empty.
    const [, host = '', path = ''] = scpLike;
    return `${host}/${path}`.toLowerCase();
  }
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/i.exec(trimmed);
  if (withProtocol) {
    const [, host = '', path = ''] = withProtocol;
    return `${host}/${path}`.toLowerCase();
  }
  return trimmed.toLowerCase();
}

/** Strips a `user:pass@` or `token@` prefix before a remote URL is ever
 * echoed back in a refusal message. No known Genesys or GitHub credential
 * flows through this path, but a remote a developer configured by hand could
 * embed one, and the whole point of this command's stricter posture is not
 * to be the first place that assumption is tested. */
function redactUserinfo(raw: string): string {
  return raw.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]+@/i, '$1');
}

function describeSubprocessFailure(error: unknown): string {
  if (error !== null && typeof error === 'object') {
    const withStreams = error as { readonly stderr?: unknown; readonly message?: unknown };
    const stderr = typeof withStreams.stderr === 'string' ? withStreams.stderr.trim() : '';
    if (stderr.length > 0) return truncate(stderr);
    if (typeof withStreams.message === 'string') return truncate(withStreams.message);
  }
  return 'unknown error.';
}

function truncate(text: string, max = 2000): string {
  return text.length > max ? `${text.slice(0, max)}… (truncated)` : text;
}

async function repoRoot(): Promise<string> {
  return git(['rev-parse', '--show-toplevel'], process.cwd());
}

async function gatherRepoStatus(): Promise<RepoStatus> {
  const cwd = await repoRoot();

  // gitRaw, not git: leading whitespace is data here. See gitRaw's comment.
  const porcelain = await gitRaw(['status', '--porcelain'], cwd);
  const dirtyPaths = parsePorcelain(porcelain);

  const currentCommit = await git(['rev-parse', '--short', 'HEAD'], cwd);
  const notTracking = (detail: string): RepoStatus => ({
    dirtyPaths,
    remoteOk: false,
    remoteDetail: detail,
    currentCommit,
    behindCount: 0,
    shortLog: [],
  });

  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  if (branch === 'HEAD') {
    return notTracking(
      'the repository is in a detached HEAD state, not on a branch that can track a remote.',
    );
  }

  let upstream: string;
  try {
    upstream = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], cwd);
  } catch {
    return notTracking(`branch "${branch}" is not tracking any remote branch.`);
  }

  const slash = upstream.indexOf('/');
  const remoteName = slash === -1 ? upstream : upstream.slice(0, slash);
  const remoteBranch = slash === -1 ? '' : upstream.slice(slash + 1);

  if (remoteName !== 'origin' || remoteBranch.length === 0) {
    return notTracking(`branch "${branch}" tracks "${upstream}", not a branch on "origin".`);
  }

  const remoteUrl = await git(['remote', 'get-url', remoteName], cwd);
  if (normalizeRemoteUrl(remoteUrl) !== EXPECTED_REMOTE) {
    return notTracking(
      `origin points to "${redactUserinfo(remoteUrl)}", not https://${EXPECTED_REMOTE}.`,
    );
  }

  // The only mutation `--check` performs: updating .git's own record of what
  // origin has, so the counts below are accurate. See this function's own
  // doc comment.
  await execFile('git', ['fetch', remoteName, remoteBranch], { cwd, maxBuffer: MAX_BUFFER });

  const behindRaw = await git(['rev-list', '--count', `HEAD..${remoteName}/${remoteBranch}`], cwd);
  const behindCount = Number.parseInt(behindRaw, 10) || 0;

  const logRaw = await git(['log', '--oneline', `HEAD..${remoteName}/${remoteBranch}`], cwd);
  const shortLog = logRaw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  return { dirtyPaths, remoteOk: true, currentCommit, behindCount, shortLog };
}

async function performPull(): Promise<StepResult> {
  try {
    const cwd = await repoRoot();
    // Resolved fresh rather than trusting a value cached from an earlier
    // status() call -- the branch's upstream is exactly the thing runUpdate
    // just confirmed is safe to fast-forward onto, so re-reading it here
    // costs one more `git` call in exchange for never merging against a
    // stale assumption.
    const upstreamRef = await git(['rev-parse', '--symbolic-full-name', '@{u}'], cwd);
    // --ff-only refuses to merge or rebase: exactly "a fast-forward pull or
    // nothing", never a merge commit and never a rewritten history.
    await execFile('git', ['merge', '--ff-only', upstreamRef], { cwd, maxBuffer: MAX_BUFFER });
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: describeSubprocessFailure(error) };
  }
}

async function performInstall(): Promise<StepResult> {
  try {
    const cwd = await repoRoot();
    await execFile(NPM_COMMAND, ['ci'], { cwd, maxBuffer: MAX_BUFFER });
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: describeSubprocessFailure(error) };
  }
}

async function performBuild(): Promise<StepResult> {
  try {
    const cwd = await repoRoot();
    await execFile(NPM_COMMAND, ['run', 'build'], { cwd, maxBuffer: MAX_BUFFER });
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: describeSubprocessFailure(error) };
  }
}

/**
 * Builds the real `UpdateCommandDeps` -- the one `buildRealDeps` in bin.ts
 * wires up. Takes the CLI's own `write` rather than constructing another
 * stdout writer, so this command's output goes through the same single
 * sink as every other command's.
 */
/**
 * Parses `git status --porcelain` into the paths it reports as dirty.
 *
 * Exported because it is the one piece of the real git plumbing that is pure,
 * and it is where the only bug in this command lived: the line must not be
 * trimmed before the slice. Porcelain's first status character is a space for
 * an unstaged change (" M path"), so trimming first shifts everything left and
 * `slice(3)` then eats the first character of the path -- "apps/cli/src/bin.ts"
 * was reported as "pps/cli/src/bin.ts". Untracked entries ("?? path") have no
 * leading space and looked fine, which is why a test written from
 * untracked-shaped lines missed it entirely.
 */
export function parsePorcelain(porcelain: string): readonly string[] {
  return (
    porcelain
      .split('\n')
      .filter((line) => line.length > 0)
      // Two status characters, a space, then the path -- see `git help status`.
      // A rename ("old -> new") passes through unsplit, which is still a path,
      // just a wider one.
      // Matched rather than sliced at a fixed column. Porcelain is two status
      // characters then a space, but a caller that trimmed the output leaves the
      // first line one character short, and a fixed slice silently eats a
      // character of the path instead of failing. This shape survives both.
      .map((line) => /^(?:\s?\S{1,2})\s(.*)$/.exec(line)?.[1]?.trim() ?? line.slice(3).trim())
      .filter((path) => path.length > 0)
  );
}

export function createRealUpdateDeps(write: (line: string) => void): UpdateCommandDeps {
  return {
    write,
    confirm: (message) => confirmFromStdin(process.stdin, process.stdout, message),
    status: gatherRepoStatus,
    pull: performPull,
    install: performInstall,
    build: performBuild,
  };
}
