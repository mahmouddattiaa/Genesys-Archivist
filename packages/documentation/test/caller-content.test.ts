// packages/documentation/test/caller-content.test.ts
import { describe, expect, it } from 'vitest';
import {
  findInlineAudioContent,
  resolvePromptReferences,
  type PromptLibraryDependency,
} from '../src/caller-content.js';

describe('findInlineAudioContent', () => {
  it('returns null when settings carries none of the recognised playable fields', () => {
    expect(findInlineAudioContent({ timeout: 5 })).toBeNull();
  });

  it("recovers a PlayAudioAction/Menu's inline TTS text from prompts.defaultAudio", () => {
    const result = findInlineAudioContent({
      prompts: {
        defaultAudio: {
          kind: 'expression',
          operator: 'AudioPlaybackOptions',
          operands: [
            {
              kind: 'expression',
              operator: 'ToAudioTTS',
              operands: [{ kind: 'literal', dataType: 'str', text: 'Welcome to support' }],
            },
            { kind: 'literal', dataType: 'bln', text: 'true' },
          ],
        },
      },
    });
    expect(result).not.toBeNull();
    expect(result?.fragments).toEqual(['Welcome to support']);
    expect(result?.partial).toBe(false);
    // The boolean literal must never leak in as if it were spoken text.
    expect(result?.fragments).not.toContain('true');
  });

  it("recovers a CommunicateAction's communication field directly (no nested container)", () => {
    const result = findInlineAudioContent({
      communication: { kind: 'literal', dataType: 'str', text: 'Your request is complete.' },
    });
    expect(result?.fragments).toEqual(['Your request is complete.']);
  });

  it("recovers an AskFor*/WaitForInputAction's question field", () => {
    const result = findInlineAudioContent({
      question: {
        kind: 'expression',
        operator: 'MakeCommunication',
        operands: [{ kind: 'literal', dataType: 'str', text: 'Would you like to continue?' }],
      },
    });
    expect(result?.fragments).toEqual(['Would you like to continue?']);
  });

  it('reports content that is entirely variable-driven as partial with no fragments, never inventing text', () => {
    const result = findInlineAudioContent({
      communication: { kind: 'variableRef', dataType: 'str' },
    });
    expect(result).not.toBeNull();
    expect(result?.fragments).toEqual([]);
    expect(result?.partial).toBe(true);
  });

  it('marks a partially variable-driven message as partial while still returning the literal fragments it did recover', () => {
    const result = findInlineAudioContent({
      communication: {
        kind: 'expression',
        operator: 'MakeCommunication',
        operands: [
          { kind: 'literal', dataType: 'str', text: 'Your balance is' },
          { kind: 'variableRef', dataType: 'currency' },
        ],
      },
    });
    expect(result?.fragments).toEqual(['Your balance is']);
    expect(result?.partial).toBe(true);
  });

  it('never treats an unrelated field (e.g. a DecisionAction expression) as playable content', () => {
    const result = findInlineAudioContent({
      expression: { kind: 'literal', dataType: 'bln', text: 'true' },
    });
    expect(result).toBeNull();
  });
});

describe('resolvePromptReferences', () => {
  const dependenciesById = new Map<string, PromptLibraryDependency>([
    ['prompt-1', { dependencyId: 'prompt-1', displayName: 'Welcome Prompt', evidenceIds: ['ev1'] }],
    ['prompt-2', { dependencyId: 'prompt-2', displayName: null, evidenceIds: ['ev2'] }],
  ]);

  it('resolves a promptRefs entry to its dependency display name and evidence', () => {
    const [resolved] = resolvePromptReferences(['prompt-1'], dependenciesById);
    expect(resolved?.resolved).toBe(true);
    expect(resolved?.resolved === true && resolved.displayName).toBe('Welcome Prompt');
    expect(resolved?.resolved === true && resolved.evidenceIds).toEqual(['ev1']);
  });

  it('reports an unresolvable promptRefs entry rather than dropping it', () => {
    const [unresolved] = resolvePromptReferences(['does-not-exist'], dependenciesById);
    expect(unresolved).toBeDefined();
    expect(unresolved?.resolved).toBe(false);
    expect(unresolved?.promptId).toBe('does-not-exist');
  });

  it('resolves a dependency with no recorded display name without inventing one', () => {
    const [resolved] = resolvePromptReferences(['prompt-2'], dependenciesById);
    expect(resolved?.resolved).toBe(true);
    expect(resolved?.resolved === true && resolved.displayName).toBeNull();
  });

  it('sorts output by prompt id for deterministic ordering regardless of input order', () => {
    const a = resolvePromptReferences(['prompt-2', 'prompt-1'], dependenciesById);
    const b = resolvePromptReferences(['prompt-1', 'prompt-2'], dependenciesById);
    expect(a.map((r) => r.promptId)).toEqual(b.map((r) => r.promptId));
    expect(a.map((r) => r.promptId)).toEqual(['prompt-1', 'prompt-2']);
  });
});
