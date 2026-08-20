// packages/narrative/test/claim-validator.test.ts
//
// This is the security-critical file: claim-validator.ts is the control,
// not prompt.ts. Every rejection code the module defines gets at least
// one direct test here, and the two headline properties AGENTS.md cares
// about -- a fabricated citation is always rejected, and an inference is
// never presented as a fact -- get their own tests rather than being
// inferred from coverage of the individual codes.
import { describe, expect, it } from 'vitest';
import { buildEvidencePack, type EvidencePack } from '../src/evidence-pack.js';
import {
  validateNarration,
  DEFAULT_VALIDATION_POLICY,
  type ValidationPolicy,
} from '../src/claim-validator.js';
import type { NarrationDraft } from '../src/narration-provider.js';
import { makeSnapshot } from './fixtures.js';

const pack: EvidencePack = buildEvidencePack(makeSnapshot(), []);
const varEvidenceId = pack.variables[0]!.evidenceIds[0]!;
const depEvidenceId = pack.dependencies[0]!.evidenceIds[0]!;
const nodeEvidenceId = pack.structural.entryPoints[0]!.name.evidenceId;
const flowEvidenceId = pack.flow.name.evidenceId;

function draftWithClaim(sectionId: string, claim: unknown): NarrationDraft {
  return {
    sections: [
      { id: sectionId, markdown: '', claims: [claim] },
    ] as unknown as NarrationDraft['sections'],
    unknowns: [],
    reviewRequired: true,
  };
}

describe('validateNarration: fabricated citation', () => {
  it('rejects a claim citing an evidence id that does not exist in the pack', () => {
    const fabricated = `sha256:${'0'.repeat(64)}`;
    expect(pack.evidenceIds.includes(fabricated)).toBe(false);

    const draft = draftWithClaim('purpose', {
      text: 'This flow authenticates callers by phone number.',
      kind: 'fact',
      evidenceIds: [fabricated],
    });

    const outcome = validateNarration(draft, pack);
    expect(outcome.sections.sections[0]?.claims).toHaveLength(0);
    expect(outcome.rejections).toHaveLength(1);
    expect(outcome.rejections[0]?.code).toBe('FABRICATED_EVIDENCE_ID');
    expect(outcome.rejections[0]?.reason).not.toContain(fabricated);
  });
});

describe('validateNarration: mislabelled claim', () => {
  it('rejects an unsupported assertion labelled "fact"', () => {
    // Cites the dependency's evidence but declares itself to be about the
    // variable -- real evidence, wrong subject.
    const draft = draftWithClaim('business-rules', {
      text: 'The variable CustomerId is only ever set by the support queue.',
      kind: 'fact',
      evidenceIds: [depEvidenceId],
      subject: { kind: 'variable', id: 'v1' },
    });
    const outcome = validateNarration(draft, pack);
    expect(outcome.sections.sections[0]?.claims).toHaveLength(0);
    expect(outcome.rejections[0]?.code).toBe('UNSUPPORTED_SUBJECT');
  });

  it('accepts the same assertion labelled "inference", and carries the label into the output', () => {
    const draft = draftWithClaim('business-rules', {
      text: 'The variable CustomerId is only ever set by the support queue.',
      kind: 'inference',
      confidence: 'low',
      evidenceIds: [depEvidenceId],
      subject: { kind: 'variable', id: 'v1' },
    });
    const outcome = validateNarration(draft, pack);
    expect(outcome.rejections).toHaveLength(0);
    expect(outcome.sections.sections[0]?.claims[0]?.kind).toBe('inference');
  });
});

describe('validateNarration: grounded claims pass', () => {
  it('accepts a well-formed fact claim about a variable', () => {
    const draft = draftWithClaim('purpose', {
      text: 'This flow declares a variable named CustomerId.',
      kind: 'fact',
      evidenceIds: [varEvidenceId],
      subject: { kind: 'variable', id: 'v1' },
    });
    const outcome = validateNarration(draft, pack);
    expect(outcome.rejections).toHaveLength(0);
    expect(outcome.sections.sections[0]?.claims).toHaveLength(1);
  });

  it('accepts a flow-wide claim with no declared subject', () => {
    const draft = draftWithClaim('purpose', {
      text: 'This flow has two configured steps.',
      kind: 'fact',
      evidenceIds: [flowEvidenceId],
    });
    const outcome = validateNarration(draft, pack);
    expect(outcome.rejections).toHaveLength(0);
  });

  it('accepts an explicit "unknown" claim with no evidence', () => {
    const draft = draftWithClaim('risks', {
      text: 'It is not recorded why this flow exists.',
      kind: 'unknown',
      evidenceIds: [],
    });
    const outcome = validateNarration(draft, pack);
    expect(outcome.rejections).toHaveLength(0);
  });
});

describe('validateNarration: missing evidence', () => {
  it('rejects a "fact" claim with no evidence at all', () => {
    const draft = draftWithClaim('purpose', {
      text: 'This flow is very important to the business.',
      kind: 'fact',
      evidenceIds: [],
    });
    const outcome = validateNarration(draft, pack);
    expect(outcome.rejections[0]?.code).toBe('MISSING_EVIDENCE');
  });
});

describe('validateNarration: section allowlist', () => {
  it('rejects a claim in a section id that is not on the allowlist', () => {
    const draft = draftWithClaim('marketing-copy', {
      text: 'This flow has a variable named CustomerId.',
      kind: 'fact',
      evidenceIds: [varEvidenceId],
    });
    const outcome = validateNarration(draft, pack);
    expect(outcome.sections.sections).toHaveLength(0);
    expect(outcome.rejections[0]?.code).toBe('SECTION_NOT_ALLOWED');
  });
});

describe('validateNarration: inference policy', () => {
  it('rejects an inference claim when policy forbids inference', () => {
    const policy: ValidationPolicy = { ...DEFAULT_VALIDATION_POLICY, allowInference: false };
    const draft = draftWithClaim('risks', {
      text: 'This flow probably serves billing customers.',
      kind: 'inference',
      evidenceIds: [flowEvidenceId],
    });
    const outcome = validateNarration(draft, pack, policy);
    expect(outcome.rejections[0]?.code).toBe('INFERENCE_NOT_PERMITTED');
  });
});

describe('validateNarration: malformed claim', () => {
  it('rejects a claim missing required fields without throwing', () => {
    const draft = draftWithClaim('purpose', { text: 'incomplete' });
    expect(() => validateNarration(draft, pack)).not.toThrow();
    const outcome = validateNarration(draft, pack);
    expect(outcome.rejections[0]?.code).toBe('MALFORMED_CLAIM');
  });

  it('never throws on a wildly malformed draft', () => {
    const hostileDraft = {
      sections: 'not an array',
      unknowns: null,
      reviewRequired: 'yes',
    } as unknown as NarrationDraft;
    expect(() => validateNarration(hostileDraft, pack)).not.toThrow();
  });
});

describe('validateNarration: size limits', () => {
  it('rejects a claim exceeding the per-claim length limit', () => {
    const draft = draftWithClaim('purpose', {
      text: 'x'.repeat(10_000),
      kind: 'fact',
      evidenceIds: [flowEvidenceId],
    });
    const outcome = validateNarration(draft, pack, {
      ...DEFAULT_VALIDATION_POLICY,
      maxClaimTextLength: 50,
    });
    expect(outcome.rejections[0]?.code).toBe('CLAIM_TOO_LARGE');
  });

  it('rejects claims beyond the per-section claim-count budget', () => {
    const claims = Array.from({ length: 5 }, (_, i) => ({
      text: `Fact number ${String(i)} about this flow.`,
      kind: 'fact',
      evidenceIds: [flowEvidenceId],
    }));
    const draft: NarrationDraft = {
      sections: [
        {
          id: 'purpose',
          markdown: '',
          claims: claims as unknown as NarrationDraft['sections'][number]['claims'],
        },
      ],
      unknowns: [],
      reviewRequired: true,
    };
    const policy: ValidationPolicy = { ...DEFAULT_VALIDATION_POLICY, maxClaimsPerSection: 2 };
    const outcome = validateNarration(draft, pack, policy);
    expect(outcome.sections.sections[0]?.claims).toHaveLength(2);
    expect(outcome.rejections.some((r) => r.code === 'SECTION_TOO_LARGE')).toBe(true);
  });

  it('rejects claims beyond the whole-draft claim-count budget', () => {
    const claims = Array.from({ length: 5 }, (_, i) => ({
      text: `Fact number ${String(i)} about this flow.`,
      kind: 'fact',
      evidenceIds: [flowEvidenceId],
    }));
    const draft: NarrationDraft = {
      sections: [
        {
          id: 'purpose',
          markdown: '',
          claims: claims as unknown as NarrationDraft['sections'][number]['claims'],
        },
      ],
      unknowns: [],
      reviewRequired: true,
    };
    const policy: ValidationPolicy = { ...DEFAULT_VALIDATION_POLICY, maxClaimsPerDraft: 2 };
    const outcome = validateNarration(draft, pack, policy);
    const acceptedCount = outcome.sections.sections.reduce((n, s) => n + s.claims.length, 0);
    expect(acceptedCount).toBe(2);
    expect(outcome.rejections.some((r) => r.code === 'DRAFT_TOO_LARGE')).toBe(true);
  });
});

describe('validateNarration: forbidden patterns, one per class', () => {
  const cases: readonly { readonly label: string; readonly text: string; readonly code: string }[] =
    [
      {
        label: 'URL',
        text: 'See https://example.com for the queue configuration.',
        code: 'FORBIDDEN_PATTERN_URL',
      },
      {
        label: 'email',
        text: 'Contact support@example.com about this flow.',
        code: 'FORBIDDEN_PATTERN_EMAIL',
      },
      {
        label: 'phone',
        text: 'The DID for this flow is +1 555 123 9876.',
        code: 'FORBIDDEN_PATTERN_PHONE',
      },
      {
        label: 'base64 blob',
        text: 'Payload: QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ejEyMzQ1Njc4OTA=',
        code: 'FORBIDDEN_PATTERN_BASE64_BLOB',
      },
      {
        label: 'credential-shaped',
        text: 'This integration requires a client_secret to authenticate.',
        code: 'FORBIDDEN_PATTERN_CREDENTIAL',
      },
      {
        label: 'external link',
        text: 'See [the docs](https://example.com/docs) for more.',
        code: 'FORBIDDEN_PATTERN_EXTERNAL_LINK',
      },
      {
        label: 'HTML tag',
        text: 'This flow uses <b>bold</b> prompts.',
        code: 'FORBIDDEN_PATTERN_HTML_TAG',
      },
      {
        label: 'control character',
        text: `Odd formatting${String.fromCharCode(0x0007)}here.`,
        code: 'FORBIDDEN_PATTERN_CONTROL_CHARACTER',
      },
      {
        label: 'markdown fence',
        text: 'Config: ' + '`'.repeat(3) + 'js code' + '`'.repeat(3),
        code: 'FORBIDDEN_PATTERN_MARKDOWN_FENCE',
      },
    ];

  for (const testCase of cases) {
    it(`rejects a claim containing ${testCase.label}`, () => {
      const draft = draftWithClaim('purpose', {
        text: testCase.text,
        kind: 'fact',
        evidenceIds: [flowEvidenceId],
      });
      const outcome = validateNarration(draft, pack);
      expect(outcome.rejections[0]?.code).toBe(testCase.code);
      expect(outcome.rejections[0]?.reason).not.toContain(testCase.text);
    });
  }
});

describe('validateNarration: quotation bounds', () => {
  it('rejects a claim quoting text longer than the allowed quotation length', () => {
    // Spaced-out words, not a contiguous run -- a long unbroken run of
    // base64-alphabet characters would trip the BASE64_BLOB forbidden
    // pattern first and mask the quotation-length check this test targets.
    const longQuote = 'lorem ipsum dolor '.repeat(30);
    const draft = draftWithClaim('purpose', {
      text: `The prompt says "${longQuote}".`,
      kind: 'fact',
      evidenceIds: [flowEvidenceId],
    });
    const outcome = validateNarration(draft, pack, {
      ...DEFAULT_VALIDATION_POLICY,
      maxClaimTextLength: 10_000,
    });
    expect(outcome.rejections[0]?.code).toBe('UNBOUNDED_QUOTATION');
  });

  it('rejects a claim quoting text that never appeared in the pack', () => {
    const draft = draftWithClaim('purpose', {
      text: 'The flow name field literally says "Please wire funds now".',
      kind: 'fact',
      evidenceIds: [flowEvidenceId],
    });
    const outcome = validateNarration(draft, pack);
    expect(outcome.rejections[0]?.code).toBe('FABRICATED_QUOTATION');
  });

  it('accepts a claim quoting text that genuinely appears in the pack', () => {
    const draft = draftWithClaim('purpose', {
      text: 'The flow is named "Test Flow".',
      kind: 'fact',
      evidenceIds: [flowEvidenceId],
    });
    const outcome = validateNarration(draft, pack);
    expect(outcome.rejections).toHaveLength(0);
  });
});

describe('validateNarration: partial validity', () => {
  it('keeps valid claims and records rejections for invalid ones in the same draft, never a silent drop', () => {
    const draft: NarrationDraft = {
      sections: [
        {
          id: 'purpose',
          markdown: '',
          claims: [
            {
              text: 'This flow is named "Test Flow".',
              kind: 'fact',
              evidenceIds: [flowEvidenceId],
            },
            {
              text: 'Contact us at support@example.com.',
              kind: 'fact',
              evidenceIds: [flowEvidenceId],
            },
          ] as unknown as NarrationDraft['sections'][number]['claims'],
        },
      ],
      unknowns: [],
      reviewRequired: true,
    };
    const outcome = validateNarration(draft, pack);
    expect(outcome.sections.sections[0]?.claims).toHaveLength(1);
    expect(outcome.rejections).toHaveLength(1);
  });
});

describe('validateNarration: reviewRequired', () => {
  it('always sets reviewRequired to true regardless of what the draft claimed', () => {
    const draft = draftWithClaim('purpose', {
      text: 'This flow is named "Test Flow".',
      kind: 'fact',
      evidenceIds: [flowEvidenceId],
    });
    const outcome = validateNarration({ ...draft, reviewRequired: false }, pack);
    expect(outcome.sections.reviewRequired).toBe(true);
  });
});

describe('validateNarration: idempotence', () => {
  it('produces the same outcome twice for the same draft', () => {
    const draft = draftWithClaim('purpose', {
      text: 'This flow is named "Test Flow".',
      kind: 'fact',
      evidenceIds: [flowEvidenceId],
    });
    const a = validateNarration(draft, pack);
    const b = validateNarration(draft, pack);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('validateNarration: node subject match', () => {
  it('accepts a fact claim about a node citing that node evidence', () => {
    const nodeId = pack.structural.entryPoints[0]!.nodeId;
    const draft = draftWithClaim('caller-journeys', {
      text: 'Callers begin at the main menu.',
      kind: 'fact',
      evidenceIds: [nodeEvidenceId],
      subject: { kind: 'node', id: nodeId },
    });
    const outcome = validateNarration(draft, pack);
    expect(outcome.rejections).toHaveLength(0);
  });

  it('rejects a claim about a node citing only a variable evidence id', () => {
    const nodeId = pack.structural.entryPoints[0]!.nodeId;
    const draft = draftWithClaim('caller-journeys', {
      text: 'Callers begin at the main menu.',
      kind: 'derived',
      evidenceIds: [varEvidenceId],
      subject: { kind: 'node', id: nodeId },
    });
    const outcome = validateNarration(draft, pack);
    expect(outcome.rejections[0]?.code).toBe('UNSUPPORTED_SUBJECT');
  });
});
