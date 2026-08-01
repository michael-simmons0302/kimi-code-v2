export interface WeightedDistribution<T> {
  readonly weight: number;
  readonly distribution: ReadonlyMap<T, number>;
}

export interface HypotheticalDecisionBranch<TDecision> {
  readonly probability: number;
  readonly decision: TDecision;
}

export interface DiscoveryWeightScheduleInput {
  readonly posteriorWeights: readonly number[];
  readonly stagnated: boolean;
  readonly decisionRelevantDisagreement: boolean;
  readonly remainingBudgetFraction: number;
}

export interface DiscoveryTemperatureDecision {
  readonly temperature: number;
  readonly reason:
    | 'low-budget'
    | 'no-decision-relevant-disagreement'
    | 'stagnated-disagreement'
    | 'default-discovery';
}

export function posteriorEntropy(weights: readonly number[]): number {
  return entropyOfProbabilities(normalizeProbabilities(weights));
}

export function normalizedPosteriorEntropy(weights: readonly number[]): number {
  const normalized = normalizeProbabilities(weights);
  if (normalized.length <= 1) return 0;
  return posteriorEntropy(normalized) / Math.log(normalized.length);
}

export function entropyOfProbabilities(probabilities: readonly number[]): number {
  let entropy = 0;
  for (const probability of probabilities) {
    if (probability > 0) entropy -= probability * Math.log(probability);
  }
  return entropy;
}

export function aggregatePredictiveDistribution<T>(
  models: readonly WeightedDistribution<T>[],
): ReadonlyMap<T, number> {
  const weights = normalizeProbabilities(models.map((model) => model.weight));
  const result = new Map<T, number>();
  models.forEach((model, index) => {
    const modelDistribution = normalizeDistribution(model.distribution);
    const modelWeight = weights[index] ?? 0;
    for (const [outcome, probability] of modelDistribution) {
      result.set(outcome, (result.get(outcome) ?? 0) + modelWeight * probability);
    }
  });
  return normalizeDistribution(result);
}

export function predictiveOutcomeEntropy<T>(
  models: readonly WeightedDistribution<T>[],
): number {
  return entropyOfProbabilities([...aggregatePredictiveDistribution(models).values()]);
}

export function expectedConditionalOutcomeEntropy<T>(
  models: readonly WeightedDistribution<T>[],
): number {
  const weights = normalizeProbabilities(models.map((model) => model.weight));
  return models.reduce((total, model, index) => {
    const modelEntropy = entropyOfProbabilities([
      ...normalizeDistribution(model.distribution).values(),
    ]);
    return total + (weights[index] ?? 0) * modelEntropy;
  }, 0);
}

export function epistemicInformationGain<T>(
  models: readonly WeightedDistribution<T>[],
): number {
  return Math.max(
    0,
    predictiveOutcomeEntropy(models) - expectedConditionalOutcomeEntropy(models),
  );
}

export function normalizedEpistemicInformationGain<T>(
  models: readonly WeightedDistribution<T>[],
): number {
  const outcomes = aggregatePredictiveDistribution(models).size;
  if (outcomes <= 1) return 0;
  return epistemicInformationGain(models) / Math.log(outcomes);
}

export function expectedPosteriorEntropy<T>(
  models: readonly WeightedDistribution<T>[],
): number {
  const priorWeights = normalizeProbabilities(models.map((model) => model.weight));
  const predictive = aggregatePredictiveDistribution(models);
  let expected = 0;

  for (const [outcome, outcomeProbability] of predictive) {
    if (outcomeProbability <= 0) continue;
    const posteriorWeights = models.map((model, index) => {
      const modelProbability = normalizeDistribution(model.distribution).get(outcome) ?? 0;
      return (priorWeights[index] ?? 0) * modelProbability;
    });
    expected += outcomeProbability * posteriorEntropy(posteriorWeights);
  }

  return expected;
}

export function effectivePosteriorSampleSize(weights: readonly number[]): number {
  const normalized = normalizeProbabilities(weights);
  const sumSquares = normalized.reduce((total, weight) => total + weight * weight, 0);
  return sumSquares <= 0 ? 0 : 1 / sumSquares;
}

export function finiteEnsembleShrinkage(
  informationGain: number,
  effectiveSampleSize: number,
  strength = 4,
): number {
  if (effectiveSampleSize <= 0) return 0;
  return informationGain * (effectiveSampleSize / (effectiveSampleSize + strength));
}

export function estimateDecisionSensitivity<TDecision>(
  currentDecision: TDecision,
  branches: readonly HypotheticalDecisionBranch<TDecision>[],
  materiallyEqual: (left: TDecision, right: TDecision) => boolean,
): number {
  const total = branches.reduce(
    (sum, branch) => sum + Math.max(0, branch.probability),
    0,
  );
  if (total <= 0) return 0;
  const changed = branches.reduce(
    (sum, branch) =>
      sum +
      (materiallyEqual(currentDecision, branch.decision)
        ? 0
        : Math.max(0, branch.probability)),
    0,
  );
  return Math.min(1, changed / total);
}

export function decisionWeightedInformationGain(
  informationGain: number,
  decisionSensitivity: number,
): number {
  return Math.max(0, informationGain) * clamp01(decisionSensitivity);
}

export function temperDiscoveryWeights(
  weights: readonly number[],
  temperature: number,
): readonly number[] {
  if (!Number.isFinite(temperature) || temperature <= 0 || temperature > 1) {
    throw new RangeError('Discovery temperature must be in the interval (0, 1].');
  }
  const normalized = normalizeProbabilities(weights);
  return normalizeProbabilities(
    normalized.map((weight) => (weight <= 0 ? 0 : Math.pow(weight, temperature))),
  );
}

export function resolveDiscoveryTemperatureDecision(
  input: DiscoveryWeightScheduleInput,
): DiscoveryTemperatureDecision {
  if (input.remainingBudgetFraction < 0.25) {
    return { temperature: 1, reason: 'low-budget' };
  }
  if (!input.decisionRelevantDisagreement) {
    return { temperature: 1, reason: 'no-decision-relevant-disagreement' };
  }
  if (input.stagnated) {
    return { temperature: 0.5, reason: 'stagnated-disagreement' };
  }
  return { temperature: 0.75, reason: 'default-discovery' };
}

export function resolveDiscoveryTemperature(input: DiscoveryWeightScheduleInput): number {
  return resolveDiscoveryTemperatureDecision(input).temperature;
}

export function binarySupportEntropy(probability: number): number {
  const p = clamp01(probability);
  return entropyOfProbabilities([p, 1 - p]);
}

export function ruleSupportEntropy(probability: number): number {
  return binarySupportEntropy(probability);
}

export function conflictEntropy(probability: number): number {
  return binarySupportEntropy(probability);
}

export function normalizeProbabilities(values: readonly number[]): readonly number[] {
  if (values.length === 0) return [];
  const sanitized = values.map((value) =>
    Number.isFinite(value) && value > 0 ? value : 0,
  );
  const total = sanitized.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return sanitized.map(() => 1 / sanitized.length);
  return sanitized.map((value) => value / total);
}

function normalizeDistribution<T>(
  distribution: ReadonlyMap<T, number>,
): ReadonlyMap<T, number> {
  const entries = [...distribution.entries()];
  const probabilities = normalizeProbabilities(
    entries.map(([, probability]) => probability),
  );
  const normalized = new Map<T, number>();
  entries.forEach(([outcome], index) =>
    normalized.set(outcome, probabilities[index] ?? 0),
  );
  return normalized;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
