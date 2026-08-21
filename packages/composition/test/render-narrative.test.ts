// packages/composition/test/render-narrative.test.ts
import { describe, expect, it } from 'vitest';
import type { NarrativeSections } from '@genesys-archivist/narrative';
import { renderNarrative } from '../src/render-narrative.js';

const EV = 'sha256:' + 'a'.repeat(64);

describe('renderNarrative', () => {
  it('returns null when there is nothing to show', () => {
    const sections: NarrativeSections = { sections: [], unknowns: [], reviewRequired: true };
    expect(renderNarrative(sections, [])).toBeNull();
  });

  it('labels a fact claim distinctly from an inference claim, and never renders inference as fact', () => {
    const sections: NarrativeSections = {
      sections: [
        {
          id: 'purpose',
          claims: [
            {
              text: 'This flow greets callers in English.',
              kind: 'fact',
              confidence: null,
              evidenceIds: [EV],
              subject: null,
            },
            {
              text: 'This flow probably exists for after-hours support.',
              kind: 'inference',
              confidence: 'low',
              evidenceIds: [EV],
              subject: null,
            },
          ],
        },
      ],
      unknowns: [],
      reviewRequired: true,
    };

    const md = renderNarrative(sections, []);
    expect(md).not.toBeNull();
    expect(md).toContain('[FACT]');
    expect(md).toContain('[INFERENCE');
    // The inference claim's own line must carry the inference tag, not fact.
    const inferenceLine = (md ?? '')
      .split('\n')
      .find((line) => line.includes('after-hours support'));
    expect(inferenceLine).toBeDefined();
    expect(inferenceLine).toContain('INFERENCE');
    expect(inferenceLine).not.toMatch(/\[FACT\]/);
  });

  it('states plainly that this content is AI-assisted and not yet reviewed', () => {
    const sections: NarrativeSections = {
      sections: [
        {
          id: 'purpose',
          claims: [{ text: 'x', kind: 'fact', confidence: null, evidenceIds: [EV], subject: null }],
        },
      ],
      unknowns: [],
      reviewRequired: true,
    };
    const md = renderNarrative(sections, []) ?? '';
    expect(md).toMatch(/AI-assisted/i);
    expect(md).toMatch(/not.{0,20}review/i);
  });

  it('reports rejected claims by code, grouped and counted, without dropping the fact that they existed', () => {
    const sections: NarrativeSections = { sections: [], unknowns: [], reviewRequired: true };
    const md =
      renderNarrative(sections, [
        { code: 'FABRICATED_EVIDENCE_ID', sectionId: 'purpose', claimIndex: 0, reason: 'x' },
        { code: 'FABRICATED_EVIDENCE_ID', sectionId: 'purpose', claimIndex: 1, reason: 'x' },
        { code: 'CLAIM_TOO_LARGE', sectionId: 'risks', claimIndex: 0, reason: 'x' },
      ]) ?? '';
    expect(md).toContain('FABRICATED_EVIDENCE_ID');
    expect(md).toContain('2');
    expect(md).toContain('CLAIM_TOO_LARGE');
  });

  it('escapes markdown-breaking characters in claim text', () => {
    const sections: NarrativeSections = {
      sections: [
        {
          id: 'purpose',
          claims: [
            {
              text: '](javascript:alert(1)) # heading',
              kind: 'fact',
              confidence: null,
              evidenceIds: [EV],
              subject: null,
            },
          ],
        },
      ],
      unknowns: [],
      reviewRequired: true,
    };
    const md = renderNarrative(sections, []) ?? '';
    expect(md).not.toContain('](javascript:alert(1))');
  });
});
