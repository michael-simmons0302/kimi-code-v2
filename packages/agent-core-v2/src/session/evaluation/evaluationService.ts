import { createHash } from 'node:crypto';

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { EVALUATION_RESULT_PROTOCOL } from '#/agent/adaptiveRuntime/adaptiveProtocol';
import { ISessionEvaluationLedgerService } from '#/session/evaluationLedger/evaluationLedger';
import {
  ISessionEvaluationCacheService,
  type EvaluationCacheHit,
} from './evaluationCache';
import { verifyEvaluationEnvironmentManifest } from './environmentManifest';
import {
  ISessionEvaluationRegistry,
  ISessionEvaluationService,
  type EvaluationCacheContext,
  type EvaluationResult,
  type EvaluationSpec,
  type EvaluatorDefinition,
} from './evaluation';

export class SessionEvaluationService
  extends Disposable
  implements ISessionEvaluationService
{
  declare readonly _serviceBrand: undefined;

  constructor(
    @ISessionEvaluationRegistry private readonly registry: ISessionEvaluationRegistry,
    @ISessionEvaluationLedgerService private readonly ledger: ISessionEvaluationLedgerService,
    @ISessionEvaluationCacheService private readonly cache: ISessionEvaluationCacheService,
  ) {
    super();
  }

  async evaluate<TInput, TOutcome = unknown>(
    spec: EvaluationSpec<TInput>,
    signal?: AbortSignal,
  ): Promise<EvaluationResult<TOutcome>> {
    await Promise.all([this.ledger.ready(), this.cache.ready()]);
    const definition = this.registry.get(spec.evaluatorId);
    if (
      spec.evaluatorVersion !== undefined &&
      spec.evaluatorVersion !== definition.version
    ) {
      throw new Error(
        `Evaluator version mismatch for ${spec.evaluatorId}: requested ${spec.evaluatorVersion}, registered ${definition.version}`,
      );
    }

    const cacheContext = resolveCacheContext(spec, definition);
    const timeoutMs = positiveTimeout(
      spec.budget.timeoutMs,
      definition.defaultTimeoutMs,
    );
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const executionSignal =
      signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
    const startedAt = Date.now();

    await this.ledger.append({
      recordType: 'evaluation.started',
      adaptiveRunId: spec.adaptiveRunId,
      payload: {
        protocol: spec.protocol,
        evaluationId: spec.evaluationId,
        evaluatorId: definition.evaluatorId,
        evaluatorVersion: definition.version,
        mode: definition.mode,
        scale: definition.scale,
        level: definition.level,
        inputHash: hashValue(spec.input),
        evaluationSpecHash: evaluationSpecHash(spec, definition.version),
        environmentHash: cacheContext?.environment.environmentHash,
        cachePolicy: definition.cachePolicy,
        seed: spec.seed,
        timeoutMs,
        tags: spec.tags ?? [],
      },
    });

    const cacheHit = cacheContext === undefined
      ? undefined
      : lookupCache(this.cache, definition, cacheContext, spec.seed);
    if (cacheHit !== undefined) {
      const result = reidentifyCachedResult<TOutcome>(cacheHit, spec);
      await this.ledger.append({
        recordType: 'evaluation.cache.hit',
        adaptiveRunId: spec.adaptiveRunId,
        payload: {
          evaluationId: spec.evaluationId,
          cacheKey: cacheHit.cacheKey,
          sourceEvaluationId: cacheHit.provenance.sourceEvaluationId,
          sourceSequence: cacheHit.provenance.createdAtSequence,
          environmentHash: cacheHit.entry.environment.environmentHash,
          seedMatched: cacheHit.provenance.seedMatched,
        },
      });
      await this.ledger.append({
        recordType: 'evaluation.completed',
        adaptiveRunId: spec.adaptiveRunId,
        payload: result,
      });
      return result;
    }

    let result: EvaluationResult<TOutcome>;
    try {
      const output = (await definition.execute(spec.input, {
        signal: executionSignal,
        evaluationId: spec.evaluationId,
        seed: spec.seed,
      })) as Omit<
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
      if (
        cacheContext !== undefined &&
        output.environmentHash !== undefined &&
        output.environmentHash !== cacheContext.environment.environmentHash
      ) {
        throw new Error(
          `Evaluator returned environment hash ${output.environmentHash}, expected ${cacheContext.environment.environmentHash}.`,
        );
      }
      const base: EvaluationResult<TOutcome> = {
        protocol: EVALUATION_RESULT_PROTOCOL,
        evaluationId: spec.evaluationId,
        evaluatorId: definition.evaluatorId,
        evaluatorVersion: definition.version,
        mode: definition.mode,
        soundness: definition.soundness,
        scale: definition.scale,
        level: definition.level,
        outcomeFamily: definition.outcomeFamily,
        ...output,
        environmentHash:
          cacheContext?.environment.environmentHash ?? output.environmentHash,
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
        protocol: EVALUATION_RESULT_PROTOCOL,
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
        environmentHash: cacheContext?.environment.environmentHash,
        cost: { wallMs: Date.now() - startedAt },
        infrastructureError: timedOut
          ? `Evaluation timed out after ${String(timeoutMs)}ms.`
          : error instanceof Error
            ? error.message
            : String(error),
      };
      result = { ...base, resultHash: hashValue(base) };
    }

    const completed = await this.ledger.append({
      recordType: 'evaluation.completed',
      adaptiveRunId: spec.adaptiveRunId,
      payload: result,
    });

    if (cacheContext !== undefined && isCacheableResult(result, spec.seed)) {
      try {
        const entry = await this.cache.put({
          identity: cacheContext.identity,
          environment: cacheContext.environment,
          result,
          seed: spec.seed,
          createdAtSequence: completed.sequence,
        });
        await this.ledger.append({
          recordType: 'evaluation.cache.stored',
          adaptiveRunId: spec.adaptiveRunId,
          payload: {
            evaluationId: spec.evaluationId,
            cacheKey: entry.cacheKey,
            mode: entry.mode,
            environmentHash: entry.environment.environmentHash,
            seed: entry.seed,
          },
        });
      } catch (error) {
        await this.ledger.append({
          recordType: 'evaluation.cache.write_failed',
          adaptiveRunId: spec.adaptiveRunId,
          payload: {
            evaluationId: spec.evaluationId,
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }
    return result;
  }

  evaluateBatch(
    specs: readonly EvaluationSpec[],
    signal?: AbortSignal,
  ): Promise<readonly EvaluationResult[]> {
    return Promise.all(specs.map((spec) => this.evaluate(spec, signal)));
  }

  async flush(): Promise<void> {
    await Promise.all([this.ledger.flush(), this.cache.flush()]);
  }

  override dispose(): void {
    void this.flush();
    super.dispose();
  }
}

function resolveCacheContext<TInput>(
  spec: EvaluationSpec<TInput>,
  definition: EvaluatorDefinition,
): EvaluationCacheContext | undefined {
  if (spec.cache === undefined) return undefined;
  if (definition.cachePolicy === 'never') {
    throw new Error(`Evaluator ${definition.evaluatorId} does not permit cache use.`);
  }
  const { identity, environment } = spec.cache;
  if (!verifyEvaluationEnvironmentManifest(environment)) {
    throw new Error('Evaluation cache context contains an invalid environment manifest.');
  }
  const expectedSpecHash = evaluationSpecHash(spec, definition.version);
  if (identity.evaluationSpecHash !== expectedSpecHash) {
    throw new Error(
      `Evaluation cache specification hash mismatch: expected ${expectedSpecHash}, received ${identity.evaluationSpecHash}.`,
    );
  }
  if (
    identity.evaluatorId !== definition.evaluatorId ||
    identity.evaluatorVersion !== definition.version ||
    environment.evaluatorId !== definition.evaluatorId ||
    environment.evaluatorVersion !== definition.version
  ) {
    throw new Error('Evaluation cache context does not match the registered evaluator.');
  }
  if (
    identity.environmentManifestHash !== environment.environmentHash ||
    identity.baselineSnapshotHash !== environment.baselineSnapshotHash ||
    identity.candidatePatchHash !== environment.candidatePatchHash ||
    identity.dependencyStateHash !== environment.dependencyStateHash
  ) {
    throw new Error('Evaluation cache identity does not match its environment manifest.');
  }
  return spec.cache;
}

function lookupCache(
  cache: ISessionEvaluationCacheService,
  definition: EvaluatorDefinition,
  context: EvaluationCacheContext,
  seed: string | undefined,
): EvaluationCacheHit | undefined {
  if (definition.mode === 'deterministic') {
    return cache.getDeterministic(context.identity);
  }
  return seed === undefined
    ? undefined
    : cache.getStochasticReplicate(context.identity, seed);
}

function reidentifyCachedResult<TOutcome>(
  hit: EvaluationCacheHit,
  spec: EvaluationSpec,
): EvaluationResult<TOutcome> {
  const source = structuredClone(hit.entry.result) as EvaluationResult<TOutcome>;
  const base: EvaluationResult<TOutcome> = {
    ...source,
    evaluationId: spec.evaluationId,
    resultHash: undefined,
    cost: {
      ...source.cost,
      wallMs: 0,
    },
  };
  return { ...base, resultHash: hashValue(base) };
}

function isCacheableResult(
  result: EvaluationResult,
  seed: string | undefined,
): boolean {
  if (!['passed', 'failed', 'inconclusive'].includes(result.status)) return false;
  return result.mode === 'deterministic' || seed !== undefined;
}

function evaluationSpecHash<TInput>(
  spec: EvaluationSpec<TInput>,
  evaluatorVersion: string,
): string {
  return hashValue({
    protocol: spec.protocol,
    evaluatorId: spec.evaluatorId,
    evaluatorVersion,
    input: spec.input,
    budget: spec.budget,
    seed: spec.seed,
    tags: spec.tags ?? [],
  });
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