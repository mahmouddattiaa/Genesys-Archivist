// packages/domain/test/value-ref.test.ts
import { describe, expect, it } from 'vitest';
import { parseValueRef } from '../src/value-ref.js';

describe('parseValueRef', () => {
  it('parses a literal', () => {
    expect(parseValueRef({ config: { lit: { type: 'bln', text: 'false' } } })).toEqual({
      kind: 'literal',
      dataType: 'bln',
      text: 'false',
    });
  });

  it('parses an explicit empty as unset, not as absent', () => {
    expect(parseValueRef({ config: { emp: {} } })).toEqual({ kind: 'unset' });
  });

  it('treats a missing config as unset', () => {
    expect(parseValueRef(undefined)).toEqual({ kind: 'unset' });
    expect(parseValueRef({})).toEqual({ kind: 'unset' });
  });

  it('parses a variable reference and keeps the variable id', () => {
    expect(parseValueRef({ config: { ref: { type: 'str', val: 'abc-123' } } })).toEqual({
      kind: 'variableRef',
      variableId: 'abc-123',
      dataType: 'str',
    });
  });

  it('parses an operator into an expression node', () => {
    const parsed = parseValueRef({
      config: {
        '==': {
          operands: [{ lit: { type: 'int', text: '1' } }, { lit: { type: 'int', text: '2' } }],
        },
      },
    });
    expect(parsed.kind).toBe('expression');
    if (parsed.kind !== 'expression') return;
    expect(parsed.operator).toBe('==');
    expect(parsed.operands).toHaveLength(2);
  });

  it('parses nested operands recursively', () => {
    const parsed = parseValueRef({
      config: {
        '==': {
          operands: [
            {
              GetAt: {
                operands: [
                  { ref: { type: 'str_coll', val: 'v1' } },
                  { lit: { type: 'int', text: '0' } },
                ],
              },
            },
            { lit: { type: 'str', text: 'x' } },
          ],
        },
      },
    });
    if (parsed.kind !== 'expression') throw new Error('expected expression');
    const inner = parsed.operands[0]!;
    if (inner.kind !== 'expression') throw new Error('expected nested expression');
    expect(inner.operator).toBe('GetAt');
    expect(inner.operands[0]).toEqual({
      kind: 'variableRef',
      variableId: 'v1',
      dataType: 'str_coll',
    });
  });

  it('never throws on an unknown discriminator; marks it opaque', () => {
    expect(parseValueRef({ config: { somethingNew: { x: 1 } } })).toEqual({
      kind: 'opaque',
      discriminator: 'somethingNew',
    });
  });

  it('accepts a bare operand node without a config wrapper', () => {
    // Operands inside an expression are not config-wrapped.
    expect(parseValueRef({ lit: { type: 'int', text: '7' } })).toEqual({
      kind: 'literal',
      dataType: 'int',
      text: '7',
    });
  });
});
