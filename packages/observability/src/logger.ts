// packages/observability/src/logger.ts
import { defaultPolicy, redact } from '@genesys-archivist/security';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LoggerOptions {
  readonly level: LogLevel;
  readonly write: (line: string) => void;
  readonly now?: () => Date;
  readonly base?: Readonly<Record<string, unknown>>;
}

export interface Logger {
  debug(event: string, fields?: Readonly<Record<string, unknown>>): void;
  info(event: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(event: string, fields?: Readonly<Record<string, unknown>>): void;
  error(event: string, fields?: Readonly<Record<string, unknown>>): void;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const RESERVED = new Set(['event', 'severity', 'timestamp']);

export function createLogger(options: LoggerOptions): Logger {
  const now = options.now ?? ((): Date => new Date());

  const emit = (
    severity: LogLevel,
    event: string,
    fields: Readonly<Record<string, unknown>>,
  ): void => {
    if (ORDER[severity] < ORDER[options.level]) return;

    const safeFields = Object.fromEntries(
      Object.entries({ ...options.base, ...fields }).filter(([key]) => !RESERVED.has(key)),
    );

    // Redaction is unconditional. A caller cannot opt out, and a caller who
    // logs a whole upstream error object still cannot leak a token.
    const { value } = redact(safeFields, defaultPolicy);

    options.write(
      JSON.stringify({
        timestamp: now().toISOString(),
        severity,
        event,
        ...(value as Record<string, unknown>),
      }),
    );
  };

  return {
    debug: (event, fields = {}) => {
      emit('debug', event, fields);
    },
    info: (event, fields = {}) => {
      emit('info', event, fields);
    },
    warn: (event, fields = {}) => {
      emit('warn', event, fields);
    },
    error: (event, fields = {}) => {
      emit('error', event, fields);
    },
  };
}
