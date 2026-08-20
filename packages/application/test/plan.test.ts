import { asFlowId, asProfileId } from '@genesys-archivist/domain';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  createPlan,
  DEFAULT_POLICY_MAX,
  verifyPlan,
  type CreatePlanDeps,
  type PlanCandidateFlow,
} from '../src/plan.js';
import type { Plan, PlanInput } from '../src/port.js';

const PROFILE_ID = asProfileId('sandbox-bfsi');
const FIXED_NOW = new Date('2026-08-20T10:00:00.000Z');

// `flowId` is widened to a plain string on purpose: the helper brands it
// below, so every call site would otherwise have to write asFlowId('a') to
// satisfy a type the helper immediately re-derives.
function candidate(
  overrides: Partial<Omit<PlanCandidateFlow, 'flowId'>> & { flowId?: string } = {},
): PlanCandidateFlow {
  return {
    flowId: asFlowId(overrides.flowId ?? 'flow-1'),
    flowType: overrides.flowType ?? 'inboundcall',
    targetVersion: overrides.targetVersion ?? '1',
    changed: overrides.changed ?? true,
  };
}

function baseDeps(overrides: Partial<CreatePlanDeps> = {}): CreatePlanDeps {
  return {
    now: () => FIXED_NOW,
    generateId: () => 'plan-fixed-id',
    mode: 'context',
    candidates: [candidate()],
    ...overrides,
  };
}

function flowsInput(flowIds: readonly string[], confirmedMax?: number): PlanInput {
  return {
    profileId: PROFILE_ID,
    scope: { kind: 'flows', flows: flowIds.map((flowId) => ({ flowId: asFlowId(flowId) })) },
    ...(confirmedMax !== undefined ? { confirmedMax } : {}),
  };
}

function orgInput(flowTypes?: readonly string[], confirmedMax?: number): PlanInput {
  return {
    profileId: PROFILE_ID,
    scope: { kind: 'organization', ...(flowTypes !== undefined ? { flowTypes } : {}) },
    ...(confirmedMax !== undefined ? { confirmedMax } : {}),
  };
}

describe('createPlan: happy path', () => {
  it('selects every requested flow present among the candidates', () => {
    const result = createPlan(flowsInput(['flow-1']), baseDeps());
    expect(result.kind).toBe('plan');
    const plan = result as Plan;
    expect(plan.selectedFlowIds).toEqual(['flow-1']);
    expect(plan.targetVersions).toEqual({ 'flow-1': '1' });
    expect(plan.planId).toBe('plan-fixed-id');
    expect(plan.createdAt).toBe(FIXED_NOW.toISOString());
  });

  it('reports a requested flow missing from discovery as a warning, never a silent drop', () => {
    const result = createPlan(flowsInput(['flow-1', 'flow-missing']), baseDeps()) as Plan;
    expect(result.selectedFlowIds).toEqual(['flow-1']);
    expect(result.warnings.some((w) => w.includes('flow-missing'))).toBe(true);
  });

  it('honors an explicit version override from the selector', () => {
    const input: PlanInput = {
      profileId: PROFILE_ID,
      scope: { kind: 'flows', flows: [{ flowId: asFlowId('flow-1'), version: '9' }] },
    };
    const result = createPlan(input, baseDeps()) as Plan;
    expect(result.targetVersions).toEqual({ 'flow-1': '9' });
  });

  it('counts changed and unchanged flows separately', () => {
    const deps = baseDeps({
      candidates: [
        candidate({ flowId: 'a', changed: true }),
        candidate({ flowId: 'b', changed: false }),
      ],
    });
    const result = createPlan(orgInput(), deps) as Plan;
    expect(result.changedCount).toBe(1);
    expect(result.unchangedCount).toBe(1);
  });
});

describe('createPlan: plan hash', () => {
  it('is stable across candidate array order', () => {
    const a = createPlan(
      orgInput(),
      baseDeps({ candidates: [candidate({ flowId: 'a' }), candidate({ flowId: 'b' })] }),
    ) as Plan;
    const b = createPlan(
      orgInput(),
      baseDeps({ candidates: [candidate({ flowId: 'b' }), candidate({ flowId: 'a' })] }),
    ) as Plan;
    expect(a.planHash).toBe(b.planHash);
  });

  it('changes when a target version changes', () => {
    const a = createPlan(
      orgInput(),
      baseDeps({ candidates: [candidate({ targetVersion: '1' })] }),
    ) as Plan;
    const b = createPlan(
      orgInput(),
      baseDeps({ candidates: [candidate({ targetVersion: '2' })] }),
    ) as Plan;
    expect(a.planHash).not.toBe(b.planHash);
  });

  it('changes when the flow selection changes', () => {
    const a = createPlan(
      orgInput(),
      baseDeps({ candidates: [candidate({ flowId: 'a' })] }),
    ) as Plan;
    const b = createPlan(
      orgInput(),
      baseDeps({ candidates: [candidate({ flowId: 'b' })] }),
    ) as Plan;
    expect(a.planHash).not.toBe(b.planHash);
  });

  it('changes when the mode changes', () => {
    const a = createPlan(orgInput(), baseDeps({ mode: 'context' })) as Plan;
    const b = createPlan(orgInput(), baseDeps({ mode: 'migration' })) as Plan;
    expect(a.planHash).not.toBe(b.planHash);
  });

  it('does not depend on planId, createdAt, or expiresAt', () => {
    const a = createPlan(orgInput(), baseDeps({ generateId: () => 'id-a' })) as Plan;
    const b = createPlan(
      orgInput(),
      baseDeps({ generateId: () => 'id-b', now: () => new Date('2030-01-01T00:00:00Z') }),
    ) as Plan;
    expect(a.planHash).toBe(b.planHash);
  });

  it('is deterministic under fast-check-generated candidate sets, independent of order', () => {
    const flowIdArb = fc.stringMatching(/^[a-z][a-z0-9]{0,10}$/);
    fc.assert(
      fc.property(fc.uniqueArray(flowIdArb, { minLength: 1, maxLength: 8 }), (flowIds) => {
        const candidates = flowIds.map((id) => candidate({ flowId: id }));
        const shuffled = [...candidates].reverse();
        const a = createPlan(orgInput(), baseDeps({ candidates })) as Plan;
        const b = createPlan(orgInput(), baseDeps({ candidates: shuffled })) as Plan;
        return a.planHash === b.planHash;
      }),
    );
  });
});

describe('createPlan: org-wide safety maximum', () => {
  const policyMax = { context: 3, migration: 2 };

  it('returns a preview when organization scope exceeds the cap', () => {
    const candidates = ['a', 'b', 'c', 'd'].map((id) => candidate({ flowId: id }));
    const result = createPlan(orgInput(), baseDeps({ candidates, policyMax }));
    expect(result.kind).toBe('preview');
    if (result.kind === 'preview') {
      expect(result.candidateCount).toBe(4);
      expect(result.policyMax).toBe(3);
    }
  });

  it('proceeds once confirmedMax meets or exceeds the candidate count', () => {
    const candidates = ['a', 'b', 'c', 'd'].map((id) => candidate({ flowId: id }));
    const result = createPlan(orgInput(undefined, 4), baseDeps({ candidates, policyMax }));
    expect(result.kind).toBe('plan');
  });

  it('refuses again when confirmedMax is below the candidate count', () => {
    const candidates = ['a', 'b', 'c', 'd'].map((id) => candidate({ flowId: id }));
    const result = createPlan(orgInput(undefined, 3), baseDeps({ candidates, policyMax }));
    expect(result.kind).toBe('preview');
  });

  it('never previews an explicit flows-list selection, even above the cap', () => {
    const flowIds = ['a', 'b', 'c', 'd'];
    const candidates = flowIds.map((id) => candidate({ flowId: id }));
    const result = createPlan(flowsInput(flowIds), baseDeps({ candidates, policyMax }));
    expect(result.kind).toBe('plan');
  });

  it('treats context and migration mode differently for the same candidate count', () => {
    const candidates = ['a', 'b', 'c'].map((id) => candidate({ flowId: id }));
    const context = createPlan(orgInput(), baseDeps({ candidates, mode: 'context', policyMax }));
    const migration = createPlan(
      orgInput(),
      baseDeps({ candidates, mode: 'migration', policyMax }),
    );
    expect(context.kind).toBe('plan');
    expect(migration.kind).toBe('preview');
  });

  it('a whole-org context capture at the S6-measured sandbox scale (511 flows) never previews under the default cap', () => {
    const candidates = Array.from({ length: 511 }, (_, i) =>
      candidate({ flowId: `flow-${String(i)}` }),
    );
    const result = createPlan(orgInput(), baseDeps({ candidates, mode: 'context' }));
    expect(result.kind).toBe('plan');
  });

  it('an unconfirmed 500-flow migration run is refused, under the default cap', () => {
    const candidates = Array.from({ length: 500 }, (_, i) =>
      candidate({ flowId: `flow-${String(i)}` }),
    );
    const result = createPlan(orgInput(), baseDeps({ candidates, mode: 'migration' }));
    expect(result.kind).toBe('preview');
    expect(DEFAULT_POLICY_MAX.migration).toBeLessThan(500);
  });
});

describe('verifyPlan: immutability and expiry', () => {
  function makePlan(): Plan {
    return createPlan(flowsInput(['flow-1']), baseDeps()) as Plan;
  }

  it('accepts a matching, unexpired plan', () => {
    const plan = makePlan();
    const result = verifyPlan(plan, plan.planId, plan.planHash, FIXED_NOW);
    expect(result.ok).toBe(true);
  });

  it('reports a tampered hash distinctly from expiry', () => {
    const plan = makePlan();
    const result = verifyPlan(plan, plan.planId, 'sha256:tampered', FIXED_NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('PLAN_HASH_MISMATCH');
  });

  it('reports expiry distinctly from a hash mismatch', () => {
    const plan = makePlan();
    const later = new Date(new Date(plan.expiresAt).getTime() + 1);
    const result = verifyPlan(plan, plan.planId, plan.planHash, later);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('PLAN_EXPIRED');
  });

  it('reports a planId mismatch as not found', () => {
    const plan = makePlan();
    const result = verifyPlan(plan, 'some-other-plan-id', plan.planHash, FIXED_NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('PLAN_NOT_FOUND');
  });
});

describe('createPlan: purity', () => {
  it('never touches Date.now, Math.random, or globalThis.fetch', () => {
    const originalDateNow = Date.now;
    const originalRandom = Math.random;
    const originalFetch = globalThis.fetch;

    Date.now = () => {
      throw new Error('createPlan must not call Date.now() -- the clock is injected.');
    };
    Math.random = () => {
      throw new Error('createPlan must not call Math.random() -- id generation is injected.');
    };
    globalThis.fetch = () => {
      throw new Error('createPlan must not call fetch -- it is pure.');
    };

    try {
      const result = createPlan(flowsInput(['flow-1']), baseDeps());
      expect(result.kind).toBe('plan');
    } finally {
      Date.now = originalDateNow;
      Math.random = originalRandom;
      globalThis.fetch = originalFetch;
    }
  });
});
