import { describe, expect, it } from 'vitest';

import type { EvidenceId } from '#/agent/adaptiveRuntime/adaptiveProtocol';
import { AgentFinalResponseVerifierService } from '#/agent/adaptiveRuntime/finalResponseVerifierService';
import type {
  EvaluationLedgerHead,
  EvaluationLedgerRecord,
  ISessionEvaluationLedgerService,
} from '#/session/evaluationLedger/evaluationLedger';

const TYPECHECK_EVIDENCE = 'typecheck-evidence' as EvidenceId;
const TEST_EVIDENCE = 'test-evidence' as EvidenceId;

class Ledger implements ISessionEvaluationLedgerService {
  declare readonly _serviceBrand: undefined;

  constructor(private readonly entries: readonly EvaluationLedgerRecord[]) {}

  async ready(): Promise<void> {}
  async append<TPayload>(): Promise<EvaluationLedgerRecord<TPayload>> {
    throw new Error('append is not used in verifier tests');
  }
  async *records(): AsyncIterable<EvaluationLedgerRecord> {
    yield* this.entries;
  }
  head(): EvaluationLedgerHead {
    return { protocol: 'adaptive-ledger/1', sequence: this.entries.length, recordHash: 'head' };
  }
  async verify() {
    return { valid: true, records: this.entries.length, head: this.head() };
  }
  async flush(): Promise<void> {}
}

function evidence(
  sequence: number,
  evidenceId: EvidenceId,
  payload: Readonly<Record<string, unknown>>,
): EvaluationLedgerRecord {
  return {
    protocol: 'adaptive-ledger/1',
    sequence,
    previousRecordHash: sequence === 1 ? null : `hash-${String(sequence - 1)}`,
    recordHash: `hash-${String(sequence)}`,
    recordType: 'evaluation.completed',
    evidenceId,
    payload,
  };
}

function verifier(entries: readonly EvaluationLedgerRecord[]) {
  return new AgentFinalResponseVerifierService(new Ledger(entries));
}

describe('AgentFinalResponseVerifierService', () => {
  it('accepts a concise evidence-backed response', async () => {
    const service = verifier([
      evidence(1, TYPECHECK_EVIDENCE, {
        evaluatorId: 'typescript.typecheck',
        status: 'passed',
      }),
    ]);
    const result = await service.verify(
      'Changed `src/a.ts`. Typecheck passed. No unresolved material risk remains.',
      {
        protocol: 'adaptive-final-response/1',
        changedFiles: ['src/a.ts'],
        verificationEvidenceRefs: [TYPECHECK_EVIDENCE],
        unresolvedMaterialRisks: [],
        maximumTokens: 100,
        requireChangedFiles: true,
        requireVerification: true,
        requireRiskStatement: true,
      },
    );
    expect(result.valid).toBe(true);
  });

  it('rejects a typecheck claim without passing evidence', async () => {
    const service = verifier([
      evidence(1, TYPECHECK_EVIDENCE, {
        evaluatorId: 'typescript.typecheck',
        status: 'failed',
      }),
    ]);
    const result = await service.verify(
      'Changed `src/a.ts`. Typecheck passed. No unresolved risk.',
      {
        protocol: 'adaptive-final-response/1',
        changedFiles: ['src/a.ts'],
        verificationEvidenceRefs: [TYPECHECK_EVIDENCE],
        unresolvedMaterialRisks: [],
        maximumTokens: 100,
        requireChangedFiles: true,
        requireVerification: true,
        requireRiskStatement: true,
      },
    );
    expect(result.valid).toBe(false);
    expect(result.unsupportedClaims).toContain(
      'Typecheck success claim lacks passing evidence.',
    );
  });

  it('rejects an all-tests claim without full-suite evidence', async () => {
    const service = verifier([
      evidence(1, TEST_EVIDENCE, {
        evaluatorId: 'vitest.test',
        status: 'passed',
        tags: ['focused'],
      }),
    ]);
    const result = await service.verify(
      'Changed `src/a.ts`. All tests passed. No unresolved risk.',
      {
        protocol: 'adaptive-final-response/1',
        changedFiles: ['src/a.ts'],
        verificationEvidenceRefs: [TEST_EVIDENCE],
        unresolvedMaterialRisks: [],
        maximumTokens: 100,
        requireChangedFiles: true,
        requireVerification: true,
        requireRiskStatement: true,
      },
    );
    expect(result.valid).toBe(false);
    expect(result.unsupportedClaims).toContain(
      'Claim that all tests passed lacks full-suite evidence.',
    );
  });

  it('accepts an all-tests claim with explicit full-suite evidence', async () => {
    const service = verifier([
      evidence(1, TEST_EVIDENCE, {
        evaluatorId: 'vitest.test',
        status: 'passed',
        tags: ['full-suite'],
      }),
    ]);
    const result = await service.verify(
      'Changed `src/a.ts`. All tests passed. No unresolved risk.',
      {
        protocol: 'adaptive-final-response/1',
        changedFiles: ['src/a.ts'],
        verificationEvidenceRefs: [TEST_EVIDENCE],
        unresolvedMaterialRisks: [],
        maximumTokens: 100,
        requireChangedFiles: true,
        requireVerification: true,
        requireRiskStatement: true,
      },
    );
    expect(result.valid).toBe(true);
  });

  it('requires every changed file and material risk in the response', async () => {
    const service = verifier([
      evidence(1, TYPECHECK_EVIDENCE, {
        evaluatorId: 'typescript.typecheck',
        status: 'passed',
      }),
    ]);
    const result = await service.verify(
      'Changed `src/a.ts`. Typecheck passed. One risk remains.',
      {
        protocol: 'adaptive-final-response/1',
        changedFiles: ['src/a.ts', 'src/b.ts'],
        verificationEvidenceRefs: [TYPECHECK_EVIDENCE],
        unresolvedMaterialRisks: ['migration coverage remains incomplete'],
        maximumTokens: 100,
        requireChangedFiles: true,
        requireVerification: true,
        requireRiskStatement: true,
      },
    );
    expect(result.missingChangedFiles).toEqual(['src/b.ts']);
    expect(result.missingRequirements).toContain(
      'Final response omits unresolved material risk: migration coverage remains incomplete',
    );
  });

  it('rejects private search internals', async () => {
    const service = verifier([
      evidence(1, TYPECHECK_EVIDENCE, {
        evaluatorId: 'typescript.typecheck',
        status: 'passed',
      }),
    ]);
    const result = await service.verify(
      'Changed `src/a.ts`. Typecheck passed. The MCTS posterior converged. No risk.',
      {
        protocol: 'adaptive-final-response/1',
        changedFiles: ['src/a.ts'],
        verificationEvidenceRefs: [TYPECHECK_EVIDENCE],
        unresolvedMaterialRisks: [],
        maximumTokens: 100,
        requireChangedFiles: true,
        requireVerification: true,
        requireRiskStatement: true,
      },
    );
    expect(result.valid).toBe(false);
    expect(result.forbiddenInternalDetails.length).toBeGreaterThan(0);
  });

  it('enforces the final response token budget', async () => {
    const service = verifier([
      evidence(1, TYPECHECK_EVIDENCE, {
        evaluatorId: 'typescript.typecheck',
        status: 'passed',
      }),
    ]);
    const result = await service.verify(
      `Changed src/a.ts. Typecheck passed. No risk. ${'x'.repeat(200)}`,
      {
        protocol: 'adaptive-final-response/1',
        changedFiles: ['src/a.ts'],
        verificationEvidenceRefs: [TYPECHECK_EVIDENCE],
        unresolvedMaterialRisks: [],
        maximumTokens: 10,
        requireChangedFiles: true,
        requireVerification: true,
        requireRiskStatement: true,
      },
    );
    expect(result.valid).toBe(false);
    expect(result.missingRequirements.some((message) => message.includes('token limit'))).toBe(
      true,
    );
  });
});
