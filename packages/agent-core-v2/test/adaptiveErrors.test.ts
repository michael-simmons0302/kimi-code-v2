import { describe, expect, it } from 'vitest';

import { errorInfo, isErrorCode } from '#/_base/errors/codes';
import { Error2 } from '#/_base/errors/errors';
import { fromErrorPayload, toErrorPayload } from '#/_base/errors/serialize';
import {
  AdaptiveMemoryErrors,
  AdaptivePromptErrors,
  AdaptiveRuntimeErrors,
  CandidateWorkspaceErrors,
  CausalRuleErrors,
  CodeStructureErrors,
  ErrorCodes,
  EvaluationErrors,
  EvaluationLedgerErrors,
  EvaluationSandboxErrors,
  StructuralSignalErrors,
  TestTimeSearchErrors,
  WorldModelErrors,
  WorldModelEvolutionErrors,
} from '#/errors';

const ADAPTIVE_CODES = [
  ...Object.values(AdaptiveMemoryErrors.codes),
  ...Object.values(AdaptivePromptErrors.codes),
  ...Object.values(AdaptiveRuntimeErrors.codes),
  ...Object.values(CandidateWorkspaceErrors.codes),
  ...Object.values(CausalRuleErrors.codes),
  ...Object.values(CodeStructureErrors.codes),
  ...Object.values(EvaluationErrors.codes),
  ...Object.values(EvaluationLedgerErrors.codes),
  ...Object.values(EvaluationSandboxErrors.codes),
  ...Object.values(StructuralSignalErrors.codes),
  ...Object.values(TestTimeSearchErrors.codes),
  ...Object.values(WorldModelErrors.codes),
  ...Object.values(WorldModelEvolutionErrors.codes),
] as const;

describe('adaptive error domains', () => {
  it('registers every adaptive error in the public facade', () => {
    const publicCodes = new Set(Object.values(ErrorCodes));
    for (const code of ADAPTIVE_CODES) {
      expect(publicCodes.has(code)).toBe(true);
      expect(isErrorCode(code)).toBe(true);
    }
  });

  it('uses globally unique wire codes', () => {
    expect(new Set(ADAPTIVE_CODES).size).toBe(ADAPTIVE_CODES.length);
  });

  it('provides actionable public metadata for every adaptive code', () => {
    for (const code of ADAPTIVE_CODES) {
      const info = errorInfo(code);
      expect(info.title).not.toBe(code);
      expect(info.public).toBe(true);
      expect(info.action?.length).toBeGreaterThan(0);
    }
  });

  it('preserves adaptive code, details, retryability, and causes through serialization', () => {
    const cause = new Error2(
      EvaluationSandboxErrors.codes.SANDBOX_RESOURCE_LIMIT,
      'Candidate exceeded memory.',
      { details: { memoryBytes: 1024 } },
    );
    const error = new Error2(
      EvaluationErrors.codes.EVALUATION_INFRASTRUCTURE_FAILED,
      'Evaluator could not complete.',
      { details: { evaluatorId: 'sandbox.command' }, cause },
    );
    const payload = toErrorPayload(error);
    expect(payload).toMatchObject({
      code: 'evaluation.infrastructure_failed',
      retryable: true,
      details: { evaluatorId: 'sandbox.command' },
      cause: {
        code: 'sandbox.resource_limit',
        retryable: false,
        details: { memoryBytes: 1024 },
      },
    });
    const restored = fromErrorPayload(payload);
    expect(restored.code).toBe(error.code);
    expect((restored.cause as Error2).code).toBe(cause.code);
  });
});
