import { createHash } from 'node:crypto';

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import {
  EVALUATION_CACHE_PROTOCOL,
  ISessionEvaluationCacheService,
  type EvaluationCacheEntry,
  type EvaluationCacheHit,
  type EvaluationCacheIdentity,
  type PutEvaluationCacheInput,
} from './evaluationCache';
import { verifyEvaluationEnvironmentManifest } from './environmentManifest';

const STORE_KEY = 'evaluation-cache.json';

interface PersistedEvaluationCache {
  readonly protocol: typeof EVALUATION_CACHE_PROTOCOL;
  readonly entries: readonly EvaluationCacheEntry[];
}

export class SessionEvaluationCacheService
  extends Disposable
  implements ISessionEvaluationCacheService
{
  declare readonly _serviceBrand: undefined;

  private readonly scope: string;
  private readonly readyPromise: Promise<void>;
  private entries = new Map<string, EvaluationCacheEntry>();
  private writeTail: Promise<void> = Promise.resolve();

  constructor(
    @ISessionContext session: ISessionContext,
    @IAtomicDocumentStore private readonly documents: IAtomicDocumentStore,
  ) {
    super();
    this.scope = session.scope('adaptive');
    this._register(this.documents.acquire(this.scope, STORE_KEY));
    this.readyPromise = this.restore();
  }

  ready(): Promise<void> {
    return this.readyPromise;
  }

  deterministicKey(identity: EvaluationCacheIdentity): string {
    validateIdentity(identity);
    return hashCanonical({ mode: 'deterministic', identity: canonicalIdentity(identity) });
  }

  stochasticReplicateKey(
    identity: EvaluationCacheIdentity,
    seed: string,
  ): string {
    validateIdentity(identity);
    if (seed.length === 0) throw new Error('Stochastic cache seed cannot be empty.');
    return hashCanonical({
      mode: 'stochastic-replicate',
      identity: canonicalIdentity(identity),
      seed,
    });
  }

  getDeterministic(identity: EvaluationCacheIdentity): EvaluationCacheHit | undefined {
    const cacheKey = this.deterministicKey(identity);
    const entry = this.entries.get(cacheKey);
    return entry === undefined ? undefined : hit(entry, true);
  }

  getStochasticReplicate(
    identity: EvaluationCacheIdentity,
    seed: string,
  ): EvaluationCacheHit | undefined {
    const cacheKey = this.stochasticReplicateKey(identity, seed);
    const entry = this.entries.get(cacheKey);
    return entry === undefined ? undefined : hit(entry, entry.seed === seed);
  }

  put(input: PutEvaluationCacheInput): Promise<EvaluationCacheEntry> {
    return this.mutate(async () => {
      validatePutInput(input);
      const mode = input.result.mode === 'deterministic'
        ? 'deterministic'
        : 'stochastic-replicate';
      if (input.result.status === 'infrastructure-failed' || input.result.status === 'cancelled') {
        throw new Error(`Evaluation status ${input.result.status} is not cacheable.`);
      }
      if (mode === 'stochastic-replicate' && input.seed === undefined) {
        throw new Error('Stochastic evaluation cache entries require a seed.');
      }
      const cacheKey = mode === 'deterministic'
        ? this.deterministicKey(input.identity)
        : this.stochasticReplicateKey(input.identity, input.seed as string);
      const entry: EvaluationCacheEntry = deepFreeze({
        protocol: EVALUATION_CACHE_PROTOCOL,
        cacheKey,
        identity: canonicalIdentity(input.identity),
        mode,
        seed: input.seed,
        result: structuredClone(input.result),
        environment: structuredClone(input.environment),
        createdAtSequence: input.createdAtSequence,
        sourceEvaluationId: input.result.evaluationId,
      });
      const existing = this.entries.get(cacheKey);
      if (existing !== undefined) {
        if (hashCanonical(existing) !== hashCanonical(entry)) {
          throw new Error(`Evaluation cache key collision or overwrite attempt: ${cacheKey}`);
        }
        return existing;
      }
      this.entries.set(cacheKey, entry);
      await this.persist();
      return entry;
    });
  }

  list(): readonly EvaluationCacheEntry[] {
    return [...this.entries.values()].sort(compareEntries);
  }

  invalidateEvaluator(evaluatorId: string, evaluatorVersion?: string): Promise<number> {
    return this.mutate(async () => {
      if (evaluatorId.trim().length === 0) throw new Error('Evaluator ID cannot be empty.');
      let deleted = 0;
      for (const [cacheKey, entry] of this.entries) {
        if (entry.identity.evaluatorId !== evaluatorId) continue;
        if (
          evaluatorVersion !== undefined &&
          entry.identity.evaluatorVersion !== evaluatorVersion
        ) {
          continue;
        }
        this.entries.delete(cacheKey);
        deleted += 1;
      }
      if (deleted > 0) await this.persist();
      return deleted;
    });
  }

  async flush(): Promise<void> {
    await this.readyPromise;
    await this.writeTail;
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    let resolveResult!: (value: T) => void;
    let rejectResult!: (error: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    this.writeTail = this.writeTail
      .then(async () => {
        await this.readyPromise;
        resolveResult(await operation());
      })
      .catch(rejectResult);
    return result;
  }

  private async restore(): Promise<void> {
    const persisted = await this.documents.get<PersistedEvaluationCache>(
      this.scope,
      STORE_KEY,
    );
    if (persisted === undefined) return;
    if (persisted.protocol !== EVALUATION_CACHE_PROTOCOL) {
      throw new Error(`Unsupported evaluation cache protocol: ${String(persisted.protocol)}.`);
    }
    const entries = new Map<string, EvaluationCacheEntry>();
    for (const candidate of persisted.entries) {
      validateEntry(candidate);
      if (entries.has(candidate.cacheKey)) {
        throw new Error(`Duplicate evaluation cache key: ${candidate.cacheKey}`);
      }
      entries.set(candidate.cacheKey, deepFreeze(structuredClone(candidate)));
    }
    this.entries = entries;
  }

  private persist(): Promise<void> {
    const value: PersistedEvaluationCache = {
      protocol: EVALUATION_CACHE_PROTOCOL,
      entries: this.list(),
    };
    return this.documents.set(this.scope, STORE_KEY, value);
  }
}

function validatePutInput(input: PutEvaluationCacheInput): void {
  validateIdentity(input.identity);
  if (!verifyEvaluationEnvironmentManifest(input.environment)) {
    throw new Error('Evaluation cache environment manifest failed verification.');
  }
  if (input.environment.environmentHash !== input.identity.environmentManifestHash) {
    throw new Error('Evaluation cache identity does not match its environment manifest.');
  }
  if (input.environment.evaluatorId !== input.identity.evaluatorId) {
    throw new Error('Evaluation cache evaluator ID does not match its environment manifest.');
  }
  if (input.environment.evaluatorVersion !== input.identity.evaluatorVersion) {
    throw new Error('Evaluation cache evaluator version does not match its environment manifest.');
  }
  if (!Number.isInteger(input.createdAtSequence) || input.createdAtSequence < 0) {
    throw new Error('Evaluation cache sequence must be non-negative.');
  }
}

function validateEntry(entry: EvaluationCacheEntry): void {
  if (entry.protocol !== EVALUATION_CACHE_PROTOCOL) {
    throw new Error(`Unsupported evaluation cache entry protocol: ${String(entry.protocol)}.`);
  }
  validatePutInput({
    identity: entry.identity,
    result: entry.result,
    environment: entry.environment,
    createdAtSequence: entry.createdAtSequence,
    seed: entry.seed,
  });
  const expected = entry.mode === 'deterministic'
    ? hashCanonical({ mode: 'deterministic', identity: canonicalIdentity(entry.identity) })
    : hashCanonical({
        mode: 'stochastic-replicate',
        identity: canonicalIdentity(entry.identity),
        seed: entry.seed,
      });
  if (entry.cacheKey !== expected) {
    throw new Error(`Evaluation cache key mismatch: ${entry.cacheKey}`);
  }
  if (entry.sourceEvaluationId !== entry.result.evaluationId) {
    throw new Error(`Evaluation cache source ID mismatch: ${entry.cacheKey}`);
  }
}

function validateIdentity(identity: EvaluationCacheIdentity): void {
  for (const [name, value] of Object.entries(identity)) {
    if (value.trim().length === 0) {
      throw new Error(`Evaluation cache identity field ${name} cannot be empty.`);
    }
  }
}

function canonicalIdentity(
  identity: EvaluationCacheIdentity,
): EvaluationCacheIdentity {
  return Object.freeze({ ...identity });
}

function hit(entry: EvaluationCacheEntry, seedMatched: boolean): EvaluationCacheHit {
  return Object.freeze({
    cacheKey: entry.cacheKey,
    entry,
    provenance: Object.freeze({
      sourceEvaluationId: entry.sourceEvaluationId,
      createdAtSequence: entry.createdAtSequence,
      exactEnvironment: true,
      seedMatched,
    }),
  });
}

function compareEntries(left: EvaluationCacheEntry, right: EvaluationCacheEntry): number {
  return left.createdAtSequence - right.createdAtSequence ||
    left.cacheKey.localeCompare(right.cacheKey);
}

function hashCanonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, current: unknown) => {
    if (current !== null && typeof current === 'object' && !Array.isArray(current)) {
      const object = current as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(object)
          .sort()
          .filter((key) => object[key] !== undefined)
          .map((key) => [key, object[key]]),
      );
    }
    return current;
  });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

registerScopedService(
  LifecycleScope.Session,
  ISessionEvaluationCacheService,
  SessionEvaluationCacheService,
  ScopeActivation.OnScopeCreated,
  'evaluationCache',
);
