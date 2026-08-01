export type StructuralBoundaryKind =
  | 'expression'
  | 'symbol'
  | 'file'
  | 'module'
  | 'package'
  | 'persistence'
  | 'event'
  | 'generated-artifact'
  | 'repository'
  | 'runtime'
  | 'trajectory';

export interface FrontierScoreInput {
  readonly expectedTaskProgress: number;
  readonly decisionWeightedInformationGain: number;
  readonly generalizationLeverage: number;
  readonly executionCost: number;
  readonly executionRisk: number;
  readonly redundancyPenalty: number;
  readonly calibrationPenalty: number;
  readonly remainingBudgetFraction: number;
  readonly discoveryWeight: number;
  readonly generalizationWeight?: number;
  readonly costWeight?: number;
  readonly riskWeight?: number;
  readonly redundancyWeight?: number;
  readonly calibrationWeight?: number;
  readonly discoveryBonusCapFraction?: number;
}

export interface FrontierScore {
  readonly expectedTaskProgress: number;
  readonly discoveryBonus: number;
  readonly generalizationBonus: number;
  readonly costPenalty: number;
  readonly riskPenalty: number;
  readonly redundancyPenalty: number;
  readonly calibrationPenalty: number;
  readonly budgetPressure: number;
  readonly total: number;
}

const BOUNDARY_LEVERAGE: Readonly<Record<StructuralBoundaryKind, number>> = Object.freeze({
  expression: 0.05,
  symbol: 0.12,
  file: 0.20,
  module: 0.35,
  package: 0.50,
  persistence: 0.65,
  event: 0.60,
  'generated-artifact': 0.45,
  repository: 0.80,
  runtime: 0.85,
  trajectory: 0.90,
});

export function computeGeneralizationLeverage(
  boundaries: readonly StructuralBoundaryKind[],
): number {
  const distinct = new Set(boundaries);
  let complement = 1;
  for (const boundary of distinct) complement *= 1 - BOUNDARY_LEVERAGE[boundary];
  return clamp01(1 - complement);
}

export function computeEvaluationRedundancy(
  candidateFeatures: readonly string[],
  completedFeatureSets: readonly (readonly string[])[],
): number {
  if (candidateFeatures.length === 0 || completedFeatureSets.length === 0) return 0;
  const candidate = new Set(candidateFeatures);
  let maximum = 0;
  for (const completedFeatures of completedFeatureSets) {
    const completed = new Set(completedFeatures);
    const union = new Set([...candidate, ...completed]);
    if (union.size === 0) continue;
    let intersection = 0;
    for (const feature of candidate) if (completed.has(feature)) intersection += 1;
    maximum = Math.max(maximum, intersection / union.size);
  }
  return clamp01(maximum);
}

export function computeBudgetPressure(remainingBudgetFraction: number): number {
  const remaining = clamp01(remainingBudgetFraction);
  if (remaining >= 0.5) return 0;
  return Math.pow((0.5 - remaining) / 0.5, 2);
}

export function computeFrontierScore(input: FrontierScoreInput): FrontierScore {
  const task = finite(input.expectedTaskProgress);
  const information = Math.max(0, finite(input.decisionWeightedInformationGain));
  const discoveryWeight = Math.max(0, finite(input.discoveryWeight));
  const uncappedDiscovery = information * discoveryWeight;
  const capFraction = clamp01(input.discoveryBonusCapFraction ?? 0.30);
  const exploitationScale = Math.max(1, Math.abs(task));
  const discoveryBonus = Math.min(uncappedDiscovery, exploitationScale * capFraction);
  const generalizationBonus =
    clamp01(input.generalizationLeverage) * Math.max(0, input.generalizationWeight ?? 0.15);
  const budgetPressure = computeBudgetPressure(input.remainingBudgetFraction);
  const costPenalty =
    Math.max(0, finite(input.executionCost)) *
    Math.max(0, input.costWeight ?? 0.10) *
    (1 + budgetPressure);
  const riskPenalty =
    Math.max(0, finite(input.executionRisk)) * Math.max(0, input.riskWeight ?? 0.25);
  const redundancyPenalty =
    clamp01(input.redundancyPenalty) * Math.max(0, input.redundancyWeight ?? 0.20);
  const calibrationPenalty =
    clamp01(input.calibrationPenalty) * Math.max(0, input.calibrationWeight ?? 0.20);
  const total =
    task +
    discoveryBonus +
    generalizationBonus -
    costPenalty -
    riskPenalty -
    redundancyPenalty -
    calibrationPenalty;

  return {
    expectedTaskProgress: task,
    discoveryBonus,
    generalizationBonus,
    costPenalty,
    riskPenalty,
    redundancyPenalty,
    calibrationPenalty,
    budgetPressure,
    total,
  };
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
