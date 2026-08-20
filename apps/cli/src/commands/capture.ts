// apps/cli/src/commands/capture.ts
//
// Pure argument parsing and result-shape contracts for `archivist capture`.
//
// ADR-018 (docs/adr/ADR-018-capture-modes.md) gives capture two modes that
// must never be confused with each other:
//
//   context    fast, org-wide by default; captures flow definitions and the
//              resource manifest that already travels with them at no extra
//              cost. Never fetches resource bodies, prompt audio, or
//              data-table rows. A context bundle CANNOT be migrated.
//   migration  slower and larger; walks every referenced resource to full
//              depth and downloads prompt audio and data-table rows, so the
//              sealed bundle is sufficient to rebuild these flows elsewhere.
//
// This module is the single place that decides what counts as a valid
// `capture` invocation. `bin.ts` uses commander only for lexical tokenizing,
// option collection, and `--help` formatting; every semantic rule --
// required flags, the mode enum, the mutual exclusion of --flow and
// --flow-type -- lives here, in a function that is a pure map from argv
// tokens to a validated command or an explanatory error. Keeping it free of
// commander, capture, and composition imports is what makes it testable
// directly, without spawning a process or standing up a fake bundle.
import { asFlowId, asOrganizationId, InvalidIdentityError } from '@genesys-archivist/domain';

export type CaptureMode = 'context' | 'migration';

export type CaptureScope =
  | { readonly kind: 'all'; readonly flowTypes?: readonly string[] }
  | { readonly kind: 'flows'; readonly flowIds: readonly string[] };

export interface CaptureCommand {
  readonly kind: 'capture';
  readonly mode: CaptureMode;
  readonly organizationId: string;
  readonly scope: CaptureScope;
  readonly profileId?: string;
}

export interface CaptureParseError {
  readonly kind: 'error';
  readonly message: string;
}

export type CaptureParseResult = CaptureCommand | CaptureParseError;

/** The outcome shape `CliDeps.capture` resolves to. Mirrors
 * `CaptureRunResult` from `@genesys-archivist/capture` structurally, without
 * importing it -- `apps/**` may not import that package directly (see
 * eslint.config.mjs), and this file has no need for the fields it doesn't
 * use. Once `packages/composition` re-exports the real type, a value of that
 * type satisfies this interface unchanged. */
export interface CaptureOutcome {
  readonly state: 'completed' | 'completed_with_warnings' | 'failed' | 'cancelled';
  readonly contentHash?: string;
  readonly bundleDir?: string;
  readonly warnings?: readonly { readonly message: string }[];
  readonly errors?: readonly { readonly message: string }[];
}

const FLAG_MODE = '--mode';
const FLAG_ORG = '--org';
const FLAG_FLOW = '--flow';
const FLAG_FLOW_TYPE = '--flow-type';
const FLAG_PROFILE = '--profile';

const KNOWN_FLAGS: ReadonlySet<string> = new Set([
  FLAG_MODE,
  FLAG_ORG,
  FLAG_FLOW,
  FLAG_FLOW_TYPE,
  FLAG_PROFILE,
]);

function isFlagToken(token: string): boolean {
  return token.startsWith('--');
}

function describeIdentityError(error: unknown, flag: string): string {
  // InvalidIdentityError deliberately never echoes the value it rejected
  // (see packages/domain/src/identity.ts), so it is always safe to forward.
  if (error instanceof InvalidIdentityError) return `${flag}: ${error.message}`;
  return `${flag}: invalid value.`;
}

/** Tokenizes `--flag value` pairs into a map of flag -> every value it was
 * given, in order. Returns a `CaptureParseError` on the first token that is
 * not a recognized `--flag value` pair -- an unrecognized flag, a flag
 * missing its value, or a bare positional argument are all rejected here
 * rather than silently dropped. */
function tokenize(argv: readonly string[]): ReadonlyMap<string, string[]> | CaptureParseError {
  const values = new Map<string, string[]>();
  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    if (token === undefined) break;
    if (!isFlagToken(token)) {
      return { kind: 'error', message: `Unexpected argument: ${token}` };
    }
    if (!KNOWN_FLAGS.has(token)) {
      return { kind: 'error', message: `Unknown flag: ${token}` };
    }
    const value = argv[index + 1];
    if (value === undefined || isFlagToken(value)) {
      return { kind: 'error', message: `${token} requires a value.` };
    }
    const existing = values.get(token);
    if (existing === undefined) {
      values.set(token, [value]);
    } else {
      existing.push(value);
    }
    index += 2;
  }
  return values;
}

function parseMode(values: ReadonlyMap<string, string[]>): CaptureMode | CaptureParseError {
  const raw = values.get(FLAG_MODE)?.[0];
  if (raw === undefined) {
    return {
      kind: 'error',
      message: `Missing required flag: ${FLAG_MODE} <context|migration>.`,
    };
  }
  if (raw !== 'context' && raw !== 'migration') {
    return {
      kind: 'error',
      message: `${FLAG_MODE} must be "context" or "migration".`,
    };
  }
  return raw;
}

function parseOrganizationId(values: ReadonlyMap<string, string[]>): string | CaptureParseError {
  const raw = values.get(FLAG_ORG)?.[0];
  if (raw === undefined) {
    return { kind: 'error', message: `Missing required flag: ${FLAG_ORG} <organizationId>.` };
  }
  try {
    return asOrganizationId(raw);
  } catch (error) {
    return { kind: 'error', message: describeIdentityError(error, FLAG_ORG) };
  }
}

function parseScope(values: ReadonlyMap<string, string[]>): CaptureScope | CaptureParseError {
  const flowIds = values.get(FLAG_FLOW) ?? [];
  const flowTypes = values.get(FLAG_FLOW_TYPE) ?? [];

  if (flowIds.length > 0 && flowTypes.length > 0) {
    return {
      kind: 'error',
      message: `Cannot combine ${FLAG_FLOW} with ${FLAG_FLOW_TYPE}: ${FLAG_FLOW} already selects an exact set of flows.`,
    };
  }

  for (const rawFlowId of flowIds) {
    try {
      asFlowId(rawFlowId);
    } catch (error) {
      return { kind: 'error', message: describeIdentityError(error, FLAG_FLOW) };
    }
  }

  if (flowIds.length > 0) return { kind: 'flows', flowIds };
  if (flowTypes.length > 0) return { kind: 'all', flowTypes };
  return { kind: 'all' };
}

/**
 * Parses the raw tokens that follow `capture` on the command line into a
 * validated `CaptureCommand`, or a `CaptureParseError` explaining what is
 * wrong. Pure: no filesystem, network, or process access, and safe to call
 * directly in a test without spawning anything.
 */
export function parseCaptureArgs(argv: readonly string[]): CaptureParseResult {
  const tokenized = tokenize(argv);
  if ('kind' in tokenized) return tokenized;

  const mode = parseMode(tokenized);
  if (typeof mode !== 'string') return mode;

  const organizationId = parseOrganizationId(tokenized);
  if (typeof organizationId !== 'string') return organizationId;

  const scope = parseScope(tokenized);
  if (scope.kind === 'error') return scope;

  const profileId = tokenized.get(FLAG_PROFILE)?.[0];

  return {
    kind: 'capture',
    mode,
    organizationId,
    scope,
    ...(profileId !== undefined ? { profileId } : {}),
  };
}
