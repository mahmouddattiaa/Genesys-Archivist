// packages/observability/test/logger.test.ts
import { describe, expect, it } from 'vitest';
import { CANARIES, scanForCanaries } from '@genesys-archivist/testing';
import { createLogger } from '../src/logger.js';

function capture(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line) => lines.push(line) };
}

describe('logger', () => {
  it('emits one JSON object per line', () => {
    const sink = capture();
    createLogger({ write: sink.write, level: 'info' }).info('run.started', { runId: 'run_1' });
    expect(sink.lines).toHaveLength(1);
    const parsed = JSON.parse(sink.lines[0]!) as Record<string, unknown>;
    expect(parsed['event']).toBe('run.started');
    expect(parsed['runId']).toBe('run_1');
    expect(parsed['severity']).toBe('info');
  });

  it('redacts a sensitive field without the caller asking', () => {
    const sink = capture();
    createLogger({ write: sink.write, level: 'info' }).info('auth', {
      authorization: 'Bearer secret',
    });
    expect(sink.lines[0]).toContain('[REDACTED:authorization]');
    expect(sink.lines[0]).not.toContain('secret');
  });

  it('lets no canary through from any nesting depth', () => {
    const sink = capture();
    const logger = createLogger({ write: sink.write, level: 'debug' });
    for (const canary of CANARIES) {
      logger.error('upstream.failed', {
        clientSecret: canary,
        nested: { deep: { password: canary } },
        list: [{ accessToken: canary }],
      });
    }
    const all = sink.lines.join('\n');
    expect(scanForCanaries(all)).toEqual([]);
  });

  it('suppresses events below the configured level', () => {
    const sink = capture();
    createLogger({ write: sink.write, level: 'warn' }).info('ignored', {});
    expect(sink.lines).toHaveLength(0);
  });

  it('never lets a field overwrite a reserved envelope key', () => {
    const sink = capture();
    createLogger({ write: sink.write, level: 'info' }).info('real.event', { event: 'spoofed' });
    const parsed = JSON.parse(sink.lines[0]!) as Record<string, unknown>;
    expect(parsed['event']).toBe('real.event');
  });
});
