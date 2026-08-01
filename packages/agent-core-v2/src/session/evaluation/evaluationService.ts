import { createHash } from 'node:crypto';

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { EVALUATION_PROTOCOL } from '#/agent/adaptiveRuntime/adaptiveProtocol';
import { ISessionEvaluationLedgerService } from '#/session/evaluationLedger/evaluationLedger';
import {
  ISessionEvaluationRegistry,
  ISessionEvaluationService,
  type EvaluationResult,
  type EvaluationSpec,
} from './evaluation';

export class SessionEvaluationService
  extends Disposable
  implements ISessionEvaluationService
{
  declare readonly _serviceBrand: undefined;

  constructor(
    @ISessionEvaluationRegistry private readonly registry: ISessionEvaluationRegistry,
    @ISessionEvaluationLedgerService private readonly ledger: ISessionEvaluationLedgerService,
  ) {
    super();
  }

  async evaluate<TInput, TOutcome = unknown>(
    spec: EvaluationSpec<TInput>,
    signal?: AbortSignal,
  ): Promise<EvaluationResult<TOutcome>> {
    await this.ledger.ready();
    const definition = this.registry.get(spec.evaluatorId);
    if (spec.evaluatorVersion !== undefined && spec.evaluatorVersion !== definition.version) {
      throw new Error(
        `Evaluator version mismatch for ${spec.evaluatorId}: requested ${spec.evaluatorVersion}, registered ${definition.version}`,
      );
    }

    const timeoutMs = positiveTimeout(spec.budget.timeoutMs, definition.defaultTimeoutMs);
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const executionSignal = signal === undefined
      ? timeoutSignal
      : AbortSignal.any([signal, timeoutSignal]);
    const startedAt = Date.now();

    await this.ledger.append({
      recordType: 'evaluation.started',
      adaptiveRunId: spec.adaptiveRunId,
      payload: {
        evaluationId: spec.evaluationId,
        evaluatorId: definition.evaluatorId,
        evaluatorVersion: definition.version,
        mode: definition.mode,
        scale: definition.scale,
        level: definition.level,
        inputHash: hashValue(spec.input),
        seed: spec.seed,
        timeoutMs,
        tags: spec.tags ?? [],
      },
    });

    let result: EvaluationResult<TOutcome>;
    try {
      const output = await definition.execute(spec.input, {
        signal: executionSignal,
        evaluationId: spec.evaluationId,
        seed: spec.seed,
      }) as Omit<
        EvaluationResult<TOutcome>,
        | 'protocol'
        | 'evaluationId'
        | 'evaluatorId'
        | 'evaluatorVersion'
        | 'mode'
        | 'soundness'
        | 'scale'
        | 'level'
        | 'outcomeFamily'
      >;
      const base: EvaluationResult<TOutcome> = {
        protocol: EVALUATION_PROTOCOL,
        evaluationId: spec.evaluationId,
        evaluatorId: definition.evaluatorId,
        evaluatorVersion: definition.version,
        mode: definition.mode,
        soundness: definition.soundness,
        scale: definition.scale,
        level: definition.level,
        outcomeFamily: definition.outcomeFamily,
        ...output,
        cost: {
          ...output.cost,
          wallMs: Math.max(output.cost.wallMs, Date.now() - startedAt),
        },
      };
      result = { ...base, resultHash: hashValue(base) };
    } catch (error) {
      const cancelled = signal?.aborted === true;
      const timedOut = !cancelled && timeoutSignal.aborted;
      const base: EvaluationResult<TOutcome> = {
        protocol: EVALUATION_PROTOCOL,
        evaluationId: spec.evaluationId,
        evaluatorId: definition.evaluatorId,
        evaluatorVersion: definition.version,
        mode: definition.mode,
        soundness: definition.soundness,
        scale: definition.scale,
        level: definition.level,
        outcomeFamily: definition.outcomeFamily,
        status: cancelled ? 'cancelled' : 'infrastructure-failed',
        assertions: [],
        counterexampleRefs: [],
        artifactRefs: [],
        cost: { wallMs: Date.now() - startedAt },
        infrastructureError: timedOut
          ? `Evaluation timed out after ${timeoutMs}ms.`
          : error instanceof Error
            ? error.message
            : String(error),
      };
      result = { ...base, resultHash: hashValue(base) };
    }

    await this.ledger.append({
      recordType: 'evaluation.completed',
      adaptiveRunId: spec.adaptiveRunId,
      payload: result,
    });
    return result;
  }

  evaluateBatch(
    specs: readonly EvaluationSpec[],
    signal?: AbortSignal,
  ): Promise<readonly EvaluationResult[]> {
    return Promise.all(specs.map((spec) => this.evaluate(spec, signal)));
  }

  flush(): Promise<void> {
    return this.ledger.flush();
  }

  override dispose(): void {
    void this.flush();
    super.dispose();
  }
}

function positiveTimeout(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function hashValue(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, current: unknown) => {
    if (
      current !== null &&
      typeof current === 'object' &&
      !Array.isArray(current) &&
      !(current instanceof Uint8Array)
    ) {
      const source = current as Record<string, unknown>;
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(source).sort()) {
        if (source[key] !== undefined) sorted[key] = source[key];
      }
      return sorted;
    }
    return current;
  });
}

registerScopedService(
  LifecycleScope.Session,
  ISessionEvaluationService,
  SessionEvaluationService,
  ScopeActivation.OnScopeCreated,
  'evaluation',
);
