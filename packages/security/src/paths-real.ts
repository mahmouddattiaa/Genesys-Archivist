// packages/security/src/paths-real.ts
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve, sep } from 'node:path';
import { resolveWithinRoot, UntrustedPathError } from './paths.js';

async function deepestExistingRealPath(candidate: string): Promise<string> {
  let current = candidate;
  for (;;) {
    try {
      return await realpath(current);
    } catch {
      const parent = dirname(current);
      // dirname of a filesystem root returns itself; stop rather than loop.
      if (parent === current) return candidate;
      current = parent;
    }
  }
}

/**
 * Lexical containment, then physical containment.
 *
 * resolveWithinRoot alone is not sufficient: a symlink planted inside the
 * output root can point anywhere, and the lexical check will happily approve
 * it. Every real filesystem write must go through this function.
 */
export async function resolveWithinRootReal(
  root: string,
  segments: readonly string[],
): Promise<string> {
  const lexical = resolveWithinRoot(root, segments);
  const realRoot = await realpath(resolve(root));
  const realCandidate = await deepestExistingRealPath(lexical);

  if (realCandidate !== realRoot && !realCandidate.startsWith(realRoot + sep)) {
    throw new UntrustedPathError('resolved outside the approved output root after link resolution');
  }
  return lexical;
}

export interface ConfigRootOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly homedir?: () => string;
}

const APP_DIR_NAME = 'genesys-archivist';

/**
 * The per-user directory archivist stores local, non-bundle state under --
 * today that's just `profiles/`, but it is named generically because it is
 * the obvious place for anything else config-shaped later.
 *
 * Deliberately follows each platform's own convention instead of one
 * XDG-everywhere default: `%APPDATA%` is where a Windows user expects an
 * app's per-user configuration to live, and is writable without elevation;
 * `~/Library/Application Support` is the macOS equivalent; Linux honors
 * `XDG_CONFIG_HOME` when a user has set it and falls back to `~/.config`
 * otherwise, per the XDG Base Directory spec. Every input is an optional
 * parameter rather than read directly from `process.env`/`process.platform`/
 * `os.homedir()`, so a test can assert the platform-specific choice without
 * mutating real process state.
 */
export function defaultConfigRoot(options: ConfigRootOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.homedir ?? homedir;

  if (platform === 'win32') {
    const appData = env['APPDATA'];
    return appData !== undefined && appData.length > 0
      ? resolve(appData, APP_DIR_NAME)
      : resolve(home(), 'AppData', 'Roaming', APP_DIR_NAME);
  }
  if (platform === 'darwin') {
    return resolve(home(), 'Library', 'Application Support', APP_DIR_NAME);
  }
  const xdgConfigHome = env['XDG_CONFIG_HOME'];
  return xdgConfigHome !== undefined && xdgConfigHome.length > 0
    ? resolve(xdgConfigHome, APP_DIR_NAME)
    : resolve(home(), '.config', APP_DIR_NAME);
}
