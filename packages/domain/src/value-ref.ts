// packages/domain/src/value-ref.ts
export type ValueRef =
  | { readonly kind: 'literal'; readonly dataType: string; readonly text: string }
  | { readonly kind: 'unset' }
  | { readonly kind: 'variableRef'; readonly variableId: string; readonly dataType: string }
  | {
      readonly kind: 'expression';
      readonly operator: string;
      readonly operands: readonly ValueRef[];
    }
  | { readonly kind: 'opaque'; readonly discriminator: string };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * Architect wraps every settable value. A top-level value carries a `config`
 * object; operands nested inside an expression do not, so both shapes are
 * accepted. The single key inside is the discriminator.
 */
export function parseValueRef(raw: unknown): ValueRef {
  if (!isRecord(raw)) return { kind: 'unset' };
  const inner = isRecord(raw['config']) ? raw['config'] : raw;

  const [discriminator] = Object.keys(inner);
  if (discriminator === undefined) return { kind: 'unset' };
  const body = inner[discriminator];

  if (discriminator === 'emp') return { kind: 'unset' };

  if (discriminator === 'lit' && isRecord(body)) {
    return { kind: 'literal', dataType: str(body['type']), text: str(body['text']) };
  }

  if (discriminator === 'ref' && isRecord(body)) {
    return { kind: 'variableRef', variableId: str(body['val']), dataType: str(body['type']) };
  }

  if (isRecord(body) && Array.isArray(body['operands'])) {
    return {
      kind: 'expression',
      operator: discriminator,
      operands: body['operands'].map(parseValueRef),
    };
  }

  // Unknown constructs are preserved as opaque rather than dropped.
  return { kind: 'opaque', discriminator };
}

/** Every variable id read anywhere inside a value, including nested operands. */
export function collectVariableReads(value: ValueRef, into: Set<string> = new Set()): Set<string> {
  if (value.kind === 'variableRef') into.add(value.variableId);
  if (value.kind === 'expression') for (const o of value.operands) collectVariableReads(o, into);
  return into;
}
