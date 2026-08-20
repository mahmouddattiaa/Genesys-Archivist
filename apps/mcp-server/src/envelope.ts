// apps/mcp-server/src/envelope.ts
//
// The structured result envelope from docs/03-mcp-contract.md. Every tool
// returns exactly one of these two shapes, and this file is the only place
// that constructs either -- a tool handler builds `data`/`warnings`/
// `resources` and hands them to `success()`, or catches a failure and hands
// a taxonomy code to `failure()`. Neither helper accepts a stack trace, a
// filesystem path, or a raw upstream body, because neither has a parameter
// for one: the release-blocking rule ("an error envelope never carries a
// stack trace...") is enforced by the shape of this function, not by
// reviewer discipline at each of nine call sites.
import { randomUUID } from 'node:crypto';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const CONTRACT_VERSION = '1.0';

export interface SuccessEnvelope<T> {
  readonly contractVersion: '1.0';
  readonly ok: true;
  readonly correlationId: string;
  readonly summary: string;
  readonly data: T;
  readonly warnings: readonly string[];
  readonly resources: readonly string[];
}

/** The taxonomy categories from docs/03's error-taxonomy table. Kept as a
 * union (not a bare string) so a tool author picking a category is choosing
 * from the documented table, not inventing a new one. */
export type ErrorCategory =
  | 'input'
  | 'authentication'
  | 'authorization'
  | 'rate'
  | 'network'
  | 'source'
  | 'data'
  | 'storage'
  | 'security'
  | 'model';

export interface EnvelopeError {
  readonly code: string;
  readonly category: ErrorCategory;
  readonly retryable: boolean;
  readonly message: string;
  readonly operatorAction?: string;
}

export interface ErrorEnvelope {
  readonly contractVersion: '1.0';
  readonly ok: false;
  readonly correlationId: string;
  readonly error: EnvelopeError;
}

export type Envelope<T> = SuccessEnvelope<T> | ErrorEnvelope;

export interface SuccessInput<T> {
  readonly correlationId?: string;
  readonly summary: string;
  readonly data: T;
  readonly warnings?: readonly string[];
  readonly resources?: readonly string[];
}

export function newCorrelationId(): string {
  return `corr_${randomUUID()}`;
}

export function success<T>(input: SuccessInput<T>): SuccessEnvelope<T> {
  return {
    contractVersion: CONTRACT_VERSION,
    ok: true,
    correlationId: input.correlationId ?? newCorrelationId(),
    summary: input.summary,
    data: input.data,
    warnings: input.warnings ?? [],
    resources: input.resources ?? [],
  };
}

export interface FailureInput {
  readonly correlationId?: string;
  readonly code: string;
  readonly category: ErrorCategory;
  readonly retryable: boolean;
  readonly message: string;
  readonly operatorAction?: string;
}

export function failure(input: FailureInput): ErrorEnvelope {
  return {
    contractVersion: CONTRACT_VERSION,
    ok: false,
    correlationId: input.correlationId ?? newCorrelationId(),
    error: {
      code: input.code,
      category: input.category,
      retryable: input.retryable,
      message: input.message,
      ...(input.operatorAction !== undefined ? { operatorAction: input.operatorAction } : {}),
    },
  };
}

/**
 * A safe, generic `UNEXPECTED_ERROR` envelope for a caught exception whose
 * message this process must not trust. `error instanceof Error ? error.message
 * : ...` is deliberately never read here: an upstream SDK exception, a
 * filesystem error, or a rejected promise can all carry a stack trace or a
 * path with a customer name in it, and the security gate in docs/13 treats
 * that leaking as a release blocker, not a bug to fix later. Callers that
 * catch a *typed*, already-sanitized error (like `PlanRejectedError`) should
 * build their own `failure()` with its `.code`, not route through this.
 */
export function unexpectedFailure(correlationId?: string): ErrorEnvelope {
  return failure({
    ...(correlationId !== undefined ? { correlationId } : {}),
    code: 'UNEXPECTED_ERROR',
    category: 'data',
    retryable: false,
    message: 'The operation did not complete because of an internal error.',
    operatorAction: 'Retry the request. If the problem persists, consult the server logs.',
  });
}

/** Renders an envelope as the `CallToolResult` every tool handler returns.
 * `structuredContent` carries the machine-readable envelope; `content`
 * carries the same thing serialized so text-only clients still see it. */
export function toCallToolResult(envelope: Envelope<unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }],
    structuredContent: envelope as unknown as Record<string, unknown>,
    isError: !envelope.ok,
  };
}
