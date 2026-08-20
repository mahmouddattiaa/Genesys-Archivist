// apps/mcp-server/src/logger.ts
//
// docs/03: "Send logs to stderr or structured log files." docs/11: every
// event carries a timestamp, severity, event name, and only safe fields --
// never a credential, a raw upstream body, or an uncontrolled filesystem
// path. `Logger` is injected (`createServer`'s `options.logger`) rather than
// imported as a singleton so a test can capture exactly what was logged
// during one tool call without touching the real `process.stderr`, and so
// `bin.ts` is the only place that wires the real stream.
export type LogFieldValue = string | number | boolean | null;
export type LogFields = Readonly<Record<string, LogFieldValue>>;

export interface Logger {
  info(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

/** Writes one JSON line per call to the given stream. Defaults to
 * `process.stderr` -- never `process.stdout`, which in STDIO mode carries
 * MCP protocol frames exclusively and would be corrupted by an interleaved
 * log line. */
export function createStderrLogger(stream: NodeJS.WritableStream = process.stderr): Logger {
  const write = (severity: 'info' | 'error', event: string, fields: LogFields = {}): void => {
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      severity,
      event,
      ...fields,
    });
    stream.write(`${line}\n`);
  };
  return {
    info: (event, fields) => {
      write('info', event, fields);
    },
    error: (event, fields) => {
      write('error', event, fields);
    },
  };
}

/** A logger that discards everything. Not used by `createServer`'s default
 * (which always logs to stderr, matching production behavior even when a
 * caller does not pass one) -- kept for tests that want to assert "nothing
 * was logged" without asserting about a specific stream. */
export const NULL_LOGGER: Logger = {
  info: () => undefined,
  error: () => undefined,
};
