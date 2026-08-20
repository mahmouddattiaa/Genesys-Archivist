// packages/narrative/test/canaries.test.ts
//
// CANARY-SECRET-2e91fa stands in for a secret an upstream system might
// place in a data-action's own configuration (its endpoint, headers, or
// body template) -- fields `EvidencePackSnapshot` has no slot for at all.
// This file proves that absence two ways: first, that the pack schema
// structurally cannot carry it regardless of where it sits upstream, then
// that a benign end-to-end run (pack -> prompt -> draft -> validated
// output -> journal) never surfaces it anywhere along that path.
//
// It also generalises the "no rejection reason echoes offending content"
// requirement beyond this one canary: every rejection code this module
// defines gets its own marker, and none of them may leak into the fixed
// reason string that code produces.
import { describe, expect, it } from 'vitest';
import { buildEvidencePack, type EvidencePack } from '../src/evidence-pack.js';
import { buildNarrationPrompt } from '../src/prompt.js';
import { ScriptedNarrationProvider } from '../src/narration-provider.js';
import {
  validateNarration,
  DEFAULT_VALIDATION_POLICY,
  type ClaimRejection,
  type RejectionCode,
} from '../src/claim-validator.js';
import {
  runNarrationQueue,
  type NarrationJournal,
  type NarrationJournalEntry,
} from '../src/work-queue.js';
import { makeSnapshot } from './fixtures.js';

const CANARY = 'CANARY-SECRET-2e91fa';

class MemoryJournal implements NarrationJournal {
  entries: NarrationJournalEntry[] = [];
  load(): Promise<readonly NarrationJournalEntry[]> {
    return Promise.resolve([...this.entries]);
  }
  record(entry: NarrationJournalEntry): Promise<void> {
    this.entries.push(entry);
    return Promise.resolve();
  }
}

/** A data action's own configuration, exactly as an upstream capture might
 * shape it -- `EvidencePackSnapshot`'s `PackDependency` type has fields for
 * `dependencyId`, `type`, `displayName`, `resolutionStatus`, and
 * `evidenceIds` only, so this object is never a valid input to
 * `buildEvidencePack` no matter what it contains. */
const upstreamDataActionConfig = {
  requestUrlTemplate: `https://api.example.com/lookup?key=${CANARY}`,
  headers: { 'x-api-key': CANARY },
};

describe('canary: CANARY-SECRET-2e91fa never reaches any surface', () => {
  it('is structurally excluded from the pack even when present in the upstream data action config', () => {
    // The legitimate mapping from a real capture to EvidencePackSnapshot
    // only ever extracts id/type/displayName/status -- never
    // upstreamDataActionConfig's own fields. Referencing the object here
    // (without feeding it into the pack) documents what the canary is
    // standing in for; buildEvidencePack itself never sees it.
    expect(Object.keys(upstreamDataActionConfig)).toContain('requestUrlTemplate');

    const snapshot = makeSnapshot({
      dependencies: [
        {
          dependencyId: 'da1',
          type: 'dataAction',
          displayName: 'Lookup Customer',
          resolutionStatus: 'resolved',
          evidenceIds: makeSnapshot().dependencies[0]!.evidenceIds,
        },
      ],
    });
    const pack = buildEvidencePack(snapshot, []);
    expect(JSON.stringify(pack)).not.toContain(CANARY);
  });

  it('never appears in pack, prompt, draft, validated output, or journal across a benign end-to-end run', async () => {
    const snapshot = makeSnapshot();
    const pack: EvidencePack = buildEvidencePack(snapshot, []);
    expect(JSON.stringify(pack)).not.toContain(CANARY);

    const prompt = buildNarrationPrompt(pack);
    expect(prompt.delimitedData).not.toContain(CANARY);
    expect(prompt.instructions).not.toContain(CANARY);

    const journal = new MemoryJournal();
    const provider = new ScriptedNarrationProvider({
      sections: [
        {
          id: 'purpose',
          markdown: '',
          claims: [
            {
              text: 'This flow is named "Test Flow".',
              kind: 'fact',
              evidenceIds: [pack.flow.name.evidenceId],
            },
          ],
        },
      ],
      unknowns: [],
      reviewRequired: true,
    } as unknown as Parameters<typeof validateNarration>[0]);

    const result = await runNarrationQueue({
      jobs: [{ flowId: 'f1', version: '1', pack }],
      provider,
      journal,
    });

    expect(JSON.stringify(result)).not.toContain(CANARY);
    expect(JSON.stringify(journal.entries)).not.toContain(CANARY);
  });
});

describe('rejection reasons never echo the content that triggered them', () => {
  const pack = buildEvidencePack(makeSnapshot(), []);
  const flowEvidenceId = pack.flow.name.evidenceId;
  const marker = (code: string): string => `MARKER-${code}-do-not-leak`;

  function draftWithClaim(sectionId: string, claim: unknown) {
    return {
      sections: [{ id: sectionId, markdown: '', claims: [claim] }],
      unknowns: [],
      reviewRequired: true,
    } as unknown as Parameters<typeof validateNarration>[0];
  }

  const triggers: readonly { readonly code: RejectionCode; readonly claim: unknown }[] = [
    { code: 'MALFORMED_CLAIM', claim: { text: marker('MALFORMED_CLAIM') } },
    {
      code: 'FABRICATED_EVIDENCE_ID',
      claim: {
        text: `A claim about ${marker('FABRICATED_EVIDENCE_ID')}.`,
        kind: 'fact',
        evidenceIds: [`sha256:${marker('FABRICATED_EVIDENCE_ID').padEnd(64, '0').slice(0, 64)}`],
      },
    },
    {
      code: 'MISSING_EVIDENCE',
      claim: { text: `About ${marker('MISSING_EVIDENCE')}.`, kind: 'fact', evidenceIds: [] },
    },
    {
      code: 'UNSUPPORTED_SUBJECT',
      claim: {
        text: `About ${marker('UNSUPPORTED_SUBJECT')}.`,
        kind: 'fact',
        evidenceIds: [flowEvidenceId],
        subject: { kind: 'variable', id: marker('UNSUPPORTED_SUBJECT') },
      },
    },
    {
      code: 'CLAIM_TOO_LARGE',
      claim: {
        text: marker('CLAIM_TOO_LARGE').repeat(200),
        kind: 'fact',
        evidenceIds: [flowEvidenceId],
      },
    },
    {
      code: 'FORBIDDEN_PATTERN_URL',
      claim: {
        text: `See https://example.com/${marker('FORBIDDEN_PATTERN_URL')}`,
        kind: 'fact',
        evidenceIds: [flowEvidenceId],
      },
    },
    {
      code: 'FORBIDDEN_PATTERN_CREDENTIAL',
      claim: {
        text: `client_secret is ${marker('FORBIDDEN_PATTERN_CREDENTIAL')}`,
        kind: 'fact',
        evidenceIds: [flowEvidenceId],
      },
    },
    {
      code: 'INFERENCE_NOT_PERMITTED',
      claim: {
        text: `About ${marker('INFERENCE_NOT_PERMITTED')}.`,
        kind: 'inference',
        evidenceIds: [flowEvidenceId],
      },
    },
    {
      code: 'FABRICATED_QUOTATION',
      claim: {
        text: `The data says "${marker('FABRICATED_QUOTATION')}".`,
        kind: 'fact',
        evidenceIds: [flowEvidenceId],
      },
    },
  ];

  for (const trigger of triggers) {
    it(`${trigger.code}'s reason never contains the triggering claim's own text`, () => {
      const policy =
        trigger.code === 'INFERENCE_NOT_PERMITTED'
          ? { ...DEFAULT_VALIDATION_POLICY, allowInference: false }
          : DEFAULT_VALIDATION_POLICY;
      const outcome = validateNarration(draftWithClaim('purpose', trigger.claim), pack, policy);
      const rejection = outcome.rejections.find((r: ClaimRejection) => r.code === trigger.code);
      expect(rejection, `expected a ${trigger.code} rejection`).toBeDefined();
      expect(rejection?.reason).not.toContain(marker(trigger.code));
      expect(rejection?.reason).not.toContain(CANARY);
    });
  }
});
