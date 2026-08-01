import { createDecorator } from '#/_base/di/instantiation';
import type { EvaluationResult } from './evaluation';
import type { EvaluationEnvironmentManifest } from './environmentManifest';

export const EVALUATION_CACHE_PROTOCOL = 'evaluation-cache/1' as const;

export interface EvaluationCacheIdentity {
  readonly evaluatorId: string;
  readonly evaluatorVersion: string;
  readonly evaluationSpecHash: string;
  readonly baselineSnapshotHash: string;
  readonly candidatePatchHash: string;
  readonly environmentManifestHash: string;
  readonly dependencyStateHash: string;
}

export interface EvaluationCacheEntry {
  readonly protocol: typeof EVALUATION_CACHE_PROTOCOL;
  readonly cacheKey: string;
  readonly identity: EvaluationCacheIdentity;
  readonly mode: 'deterministic' | 'stochastic-replicate';
  readonly seed?: string;
  readonly result: EvaluationResult;
  readonly environment: EvaluationEnvironmentManifest;
  readonly createdAtSequence: number;
  readonly sourceEvaluationId: string;
}

export interface EvaluationCacheHit {
  readonly cacheKey: string;
  readonly entry: EvaluationCacheEntry;
  readonly provenance: Readonly<{
    sourceEvaluationId: string;
    createdAtSequence: number;
    exactEnvironment: true;
    seedMatched: boolean;
  }>;
}

export interface PutEvaluationCacheInput {
  readonly identity: EvaluationCacheIdentity;
  readonly result: EvaluationResult;
  readonly environment: EvaluationEnvironmentManifest;
  readonly createdAtSequence: number;
  readonly seed?: string;
}

export interface ISessionEvaluationCacheService {
  readonly _serviceBrand: undefined;

  ready(): Promise<void>;
  deterministicKey(identity: EvaluationCacheIdentity): string;
  stochasticReplicateKey(identity: EvaluationCacheIdentity, seed: string): string;
  getDeterministic(identity: EvaluationCacheIdentity): EvaluationCacheHit | undefined;
  getStochasticReplicate(
    identity: EvaluationCacheIdentity,
    seed: string,
  ): EvaluationCacheHit | undefined;
  put(input: PutEvaluationCacheInput): Promise<EvaluationCacheEntry>;
  list(): readonly EvaluationCacheEntry[];
  invalidateEvaluator(evaluatorId: string, evaluatorVersion?: string): Promise<number>;
  flush(): Promise<void>;
}

export const ISessionEvaluationCacheService =
  createDecorator<ISessionEvaluationCacheService>('sessionEvaluationCacheService');
