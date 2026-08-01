import { createHash } from 'node:crypto';

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import {
  IWorldModelCalibrationService,
  WORLD_MODEL_CALIBRATION_PROTOCOL,
  type CalibrationMetrics,
  type CalibrationObservation,
  type CalibrationObservationEnvelope,
  type CalibrationSnapshot,
  type ReliabilityBin,
} from './worldModelCalibration';

const STORE_KEY = 'calibration/world-model-calibration.json';
const RELIABILITY_BIN_COUNT = 10;
const MINIMUM_CALIBRATION_OBSERVATIONS = 20;
const RECENT_REGIME_WINDOW = 20;
const REGIME_SHIFT_DELTA = 0.12;

interface PersistedCalibration {
  readonly protocol: typeof WORLD_MODEL_CALIBRATION_PROTOCOL;
  readonly observations: readonly CalibrationObservationEnvelope[];
}

export class WorldModelCalibrationService
  extends Disposable
  implements IWorldModelCalibrationService
{
  declare readonly _serviceBrand: undefined;

  private readonly scope: string;
  private readonly readyPromise: Promise<void>;
  private observations: CalibrationObservationEnvelope[] = [];
  private writeTail: Promise<void> = Promise.resolve();

  constructor(
    @IBootstrapService bootstrap: IBootstrapService,
    @IAtomicDocumentStore private readonly documents: IAtomicDocumentStore,
  ) {
    super();
    this.scope = bootstrap.scope('adaptive');
    this._register(this.documents.acquire(this.scope, STORE_KEY));
    this.readyPromise = this.restore();
  }

  ready(): Promise<void> {
    return this.readyPromise;
  }

  record(observation: CalibrationObservationEnvelope): Promise<CalibrationMetrics> {
    return this.mutate(async () => {
      validateEnvelope(observation);
      if (
        this.observations.some(
          (existing) =>
            existing.evaluatorFamily === observation.evaluatorFamily &&
            existing.modelLineage === observation.modelLineage &&
            existing.sequence === observation.sequence,
        )
      ) {
        throw new Error(
          `Calibration sequence already exists for ${observation.evaluatorFamily}/${observation.modelLineage}: ${String(observation.sequence)}`,
        );
      }
      this.observations = [...this.observations, freezeEnvelope(observation)].sort(compareEnvelopes);
      await this.persist();
      return this.compute(observation.evaluatorFamily, observation.modelLineage);
    });
  }

  recordMany(
    observations: readonly CalibrationObservationEnvelope[],
  ): Promise<readonly CalibrationMetrics[]> {
    return this.mutate(async () => {
      const seen = new Set<string>();
      for (const observation of observations) {
        validateEnvelope(observation);
        const key = envelopeIdentity(observation);
        if (seen.has(key)) throw new Error(`Duplicate calibration observation in batch: ${key}`);
        seen.add(key);
        if (this.observations.some((existing) => envelopeIdentity(existing) === key)) {
          throw new Error(`Calibration observation already exists: ${key}`);
        }
      }
      this.observations = [
        ...this.observations,
        ...observations.map(freezeEnvelope),
      ].sort(compareEnvelopes);
      await this.persist();
      const keys = new Map<string, readonly [string, string]>();
      for (const observation of observations) {
        keys.set(
          `${observation.evaluatorFamily}\u0000${observation.modelLineage}`,
          [observation.evaluatorFamily, observation.modelLineage],
        );
      }
      return [...keys.values()].map(([family, lineage]) => this.compute(family, lineage));
    });
  }

  recalibrateHeldOut(
    evaluatorFamily: string,
    modelLineage: string,
    observations: readonly CalibrationObservationEnvelope[],
  ): Promise<CalibrationMetrics> {
    return this.mutate(async () => {
      assertIdentity(evaluatorFamily, 'evaluatorFamily');
      assertIdentity(modelLineage, 'modelLineage');
      if (observations.length === 0) {
        throw new Error('Held-out recalibration requires at least one observation.');
      }
      for (const observation of observations) {
        validateEnvelope(observation);
        if (
          observation.evaluatorFamily !== evaluatorFamily ||
          observation.modelLineage !== modelLineage ||
          observation.split !== 'held-out'
        ) {
          throw new Error('Held-out recalibration observations must match the target key and split.');
        }
      }
      this.observations = [
        ...this.observations.filter(
          (observation) =>
            !(
              observation.evaluatorFamily === evaluatorFamily &&
              observation.modelLineage === modelLineage &&
              observation.split === 'held-out'
            ),
        ),
        ...observations.map(freezeEnvelope),
      ].sort(compareEnvelopes);
      await this.persist();
      return this.compute(evaluatorFamily, modelLineage);
    });
  }

  metrics(evaluatorFamily: string, modelLineage: string): CalibrationMetrics {
    assertIdentity(evaluatorFamily, 'evaluatorFamily');
    assertIdentity(modelLineage, 'modelLineage');
    return this.compute(evaluatorFamily, modelLineage);
  }

  informationGainMultiplier(evaluatorFamily: string, modelLineage: string): number {
    return this.metrics(evaluatorFamily, modelLineage).informationGainMultiplier;
  }

  promotionEligible(evaluatorFamily: string, modelLineage: string): boolean {
    return this.metrics(evaluatorFamily, modelLineage).promotionEligible;
  }

  snapshot(): CalibrationSnapshot {
    const keys = new Map<string, readonly [string, string]>();
    for (const observation of this.observations) {
      keys.set(
        `${observation.evaluatorFamily}\u0000${observation.modelLineage}`,
        [observation.evaluatorFamily, observation.modelLineage],
      );
    }
    const metrics = [...keys.values()]
      .map(([family, lineage]) => this.compute(family, lineage))
      .sort(compareMetrics);
    const observations = [...this.observations].sort(compareEnvelopes);
    return Object.freeze({
      protocol: WORLD_MODEL_CALIBRATION_PROTOCOL,
      metrics,
      observations,
      hash: hashCanonical({ metrics, observations }),
    });
  }

  async flush(): Promise<void> {
    await this.readyPromise;
    await this.writeTail;
  }

  private compute(evaluatorFamily: string, modelLineage: string): CalibrationMetrics {
    const matching = this.observations.filter(
      (observation) =>
        observation.evaluatorFamily === evaluatorFamily &&
        observation.modelLineage === modelLineage,
    );
    const probabilityPairs = matching.flatMap(probabilityObservationPairs);
    const intervals = matching.filter(
      (observation) => observation.observation.kind === 'scalar-interval',
    );
    const brierScore = probabilityPairs.length === 0
      ? undefined
      : mean(probabilityPairs.map(({ predicted, observed }) => (predicted - observed) ** 2));
    const logLoss = probabilityPairs.length === 0
      ? undefined
      : mean(
          probabilityPairs.map(({ predicted, observed }) =>
            -(observed * Math.log(clampProbability(predicted)) +
              (1 - observed) * Math.log(clampProbability(1 - predicted))),
          ),
        );
    const intervalCoverage = intervals.length === 0
      ? undefined
      : mean(
          intervals.map(({ observation }) =>
            observation.kind === 'scalar-interval' &&
            observation.observed >= observation.lower &&
            observation.observed <= observation.upper
              ? 1
              : 0,
          ),
        );
    const reliabilityBins = buildReliabilityBins(probabilityPairs);
    const expectedCalibrationError = probabilityPairs.length === 0
      ? undefined
      : reliabilityBins.reduce(
          (total, bin) =>
            total +
            (bin.count / probabilityPairs.length) *
              Math.abs(bin.predictedMean - bin.observedMean),
          0,
        );
    const status = calibrationStatus({
      observations: matching.length,
      brierScore,
      logLoss,
      intervalCoverage,
      expectedCalibrationError,
    });
    const regimeShift = detectRegimeShift(matching);
    const informationGainMultiplier =
      status === 'severely-miscalibrated'
        ? 0.25
        : status === 'miscalibrated' || regimeShift
          ? 0.5
          : status === 'uncalibrated'
            ? 0.75
            : 1;
    const promotionEligible = status === 'calibrated' && !regimeShift;
    return Object.freeze({
      protocol: WORLD_MODEL_CALIBRATION_PROTOCOL,
      evaluatorFamily,
      modelLineage,
      observations: matching.length,
      booleanAndCategoricalObservations: probabilityPairs.length,
      intervalObservations: intervals.length,
      brierScore,
      logLoss,
      intervalCoverage,
      expectedCalibrationError,
      reliabilityBins,
      status,
      informationGainMultiplier,
      promotionEligible,
      regimeShift,
      updatedAtSequence: matching.at(-1)?.sequence ?? 0,
    });
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
    const persisted = await this.documents.get<PersistedCalibration>(this.scope, STORE_KEY);
    if (persisted === undefined) return;
    if (persisted.protocol !== WORLD_MODEL_CALIBRATION_PROTOCOL) {
      throw new Error(`Unsupported calibration protocol: ${String(persisted.protocol)}.`);
    }
    this.observations = persisted.observations.map((observation) => {
      validateEnvelope(observation);
      return freezeEnvelope(observation);
    }).sort(compareEnvelopes);
  }

  private persist(): Promise<void> {
    const value: PersistedCalibration = {
      protocol: WORLD_MODEL_CALIBRATION_PROTOCOL,
      observations: this.observations,
    };
    return this.documents.set(this.scope, STORE_KEY, value);
  }
}

interface ProbabilityPair {
  readonly predicted: number;
  readonly observed: number;
}

function probabilityObservationPairs(
  envelope: CalibrationObservationEnvelope,
): readonly ProbabilityPair[] {
  const observation = envelope.observation;
  if (observation.kind === 'boolean') {
    return [{ predicted: observation.probability, observed: observation.observed ? 1 : 0 }];
  }
  if (observation.kind === 'categorical') {
    return Object.entries(normalizeCategorical(observation.probabilities)).map(
      ([category, probability]) => ({
        predicted: probability,
        observed: category === observation.observedCategory ? 1 : 0,
      }),
    );
  }
  return [];
}

function buildReliabilityBins(pairs: readonly ProbabilityPair[]): readonly ReliabilityBin[] {
  const buckets = Array.from({ length: RELIABILITY_BIN_COUNT }, (_, index) => ({
    lowerInclusive: index / RELIABILITY_BIN_COUNT,
    upperInclusive: (index + 1) / RELIABILITY_BIN_COUNT,
    predictions: [] as number[],
    observations: [] as number[],
  }));
  for (const pair of pairs) {
    const index = Math.min(
      RELIABILITY_BIN_COUNT - 1,
      Math.floor(clampProbability(pair.predicted) * RELIABILITY_BIN_COUNT),
    );
    buckets[index]?.predictions.push(pair.predicted);
    buckets[index]?.observations.push(pair.observed);
  }
  return buckets
    .filter((bucket) => bucket.predictions.length > 0)
    .map((bucket) => Object.freeze({
      lowerInclusive: bucket.lowerInclusive,
      upperInclusive: bucket.upperInclusive,
      count: bucket.predictions.length,
      predictedMean: mean(bucket.predictions),
      observedMean: mean(bucket.observations),
    }));
}

function calibrationStatus(input: {
  readonly observations: number;
  readonly brierScore?: number;
  readonly logLoss?: number;
  readonly intervalCoverage?: number;
  readonly expectedCalibrationError?: number;
}): CalibrationMetrics['status'] {
  if (input.observations < MINIMUM_CALIBRATION_OBSERVATIONS) return 'uncalibrated';
  const severelyMiscalibrated =
    (input.brierScore !== undefined && input.brierScore > 0.35) ||
    (input.logLoss !== undefined && input.logLoss > 1.25) ||
    (input.intervalCoverage !== undefined && input.intervalCoverage < 0.65) ||
    (input.expectedCalibrationError !== undefined && input.expectedCalibrationError > 0.25);
  if (severelyMiscalibrated) return 'severely-miscalibrated';
  const miscalibrated =
    (input.brierScore !== undefined && input.brierScore > 0.25) ||
    (input.logLoss !== undefined && input.logLoss > 0.8) ||
    (input.intervalCoverage !== undefined && input.intervalCoverage < 0.85) ||
    (input.expectedCalibrationError !== undefined && input.expectedCalibrationError > 0.15);
  return miscalibrated ? 'miscalibrated' : 'calibrated';
}

function detectRegimeShift(
  observations: readonly CalibrationObservationEnvelope[],
): boolean {
  const probability = observations.flatMap((observation) => {
    return probabilityObservationPairs(observation).map((pair) => ({
      sequence: observation.sequence,
      brier: (pair.predicted - pair.observed) ** 2,
    }));
  }).sort((left, right) => left.sequence - right.sequence);
  if (probability.length < RECENT_REGIME_WINDOW * 2) return false;
  const recent = probability.slice(-RECENT_REGIME_WINDOW);
  const historical = probability.slice(0, -RECENT_REGIME_WINDOW);
  return mean(recent.map((entry) => entry.brier)) -
    mean(historical.map((entry) => entry.brier)) >= REGIME_SHIFT_DELTA;
}

function validateEnvelope(envelope: CalibrationObservationEnvelope): void {
  assertIdentity(envelope.evaluatorFamily, 'evaluatorFamily');
  assertIdentity(envelope.modelLineage, 'modelLineage');
  if (!Number.isInteger(envelope.sequence) || envelope.sequence < 0) {
    throw new Error('Calibration sequence must be a non-negative integer.');
  }
  validateObservation(envelope.observation);
}

function validateObservation(observation: CalibrationObservation): void {
  if (observation.kind === 'boolean') {
    assertProbability(observation.probability, 'boolean probability');
    return;
  }
  if (observation.kind === 'categorical') {
    const normalized = normalizeCategorical(observation.probabilities);
    if (!(observation.observedCategory in normalized)) {
      throw new Error('Observed category must exist in the predicted distribution.');
    }
    return;
  }
  if (!Number.isFinite(observation.lower) || !Number.isFinite(observation.upper)) {
    throw new Error('Scalar interval bounds must be finite.');
  }
  if (observation.lower > observation.upper) {
    throw new Error('Scalar interval lower bound cannot exceed upper bound.');
  }
  if (!Number.isFinite(observation.observed)) {
    throw new Error('Scalar interval observation must be finite.');
  }
  if (observation.confidenceLevel <= 0 || observation.confidenceLevel >= 1) {
    throw new Error('Scalar interval confidenceLevel must be in (0, 1).');
  }
}

function normalizeCategorical(
  probabilities: Readonly<Record<string, number>>,
): Readonly<Record<string, number>> {
  const entries = Object.entries(probabilities);
  if (entries.length < 2) throw new Error('Categorical calibration requires at least two categories.');
  for (const [category, probability] of entries) {
    assertIdentity(category, 'category');
    assertProbability(probability, `probability for ${category}`);
  }
  const total = entries.reduce((sum, [, probability]) => sum + probability, 0);
  if (total <= 0) throw new Error('Categorical probabilities must have positive mass.');
  return Object.fromEntries(entries.map(([category, probability]) => [category, probability / total]));
}

function freezeEnvelope(
  envelope: CalibrationObservationEnvelope,
): CalibrationObservationEnvelope {
  return deepFreeze(structuredClone(envelope));
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function envelopeIdentity(observation: CalibrationObservationEnvelope): string {
  return `${observation.evaluatorFamily}\u0000${observation.modelLineage}\u0000${String(observation.sequence)}`;
}

function compareEnvelopes(
  left: CalibrationObservationEnvelope,
  right: CalibrationObservationEnvelope,
): number {
  return left.evaluatorFamily.localeCompare(right.evaluatorFamily) ||
    left.modelLineage.localeCompare(right.modelLineage) ||
    left.sequence - right.sequence;
}

function compareMetrics(left: CalibrationMetrics, right: CalibrationMetrics): number {
  return left.evaluatorFamily.localeCompare(right.evaluatorFamily) ||
    left.modelLineage.localeCompare(right.modelLineage);
}

function assertIdentity(value: string, field: string): void {
  if (value.trim().length === 0) throw new Error(`${field} cannot be empty.`);
}

function assertProbability(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${field} must be in [0, 1].`);
  }
}

function clampProbability(value: number): number {
  return Math.min(1 - 1e-6, Math.max(1e-6, value));
}

function mean(values: readonly number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;
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

registerScopedService(
  LifecycleScope.App,
  IWorldModelCalibrationService,
  WorldModelCalibrationService,
  ScopeActivation.OnScopeCreated,
  'worldModelCalibration',
);
