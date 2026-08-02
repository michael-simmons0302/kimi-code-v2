import { describe, expect, it } from 'vitest';

import {
  conflictEntropy,
  decisionWeightedInformationGain,
  effectivePosteriorSampleSize,
  epistemicInformationGain,
  estimateDecisionSensitivity,
  expectedConditionalOutcomeEntropy,
  expectedPosteriorEntropy,
  normalizedPosteriorEntropy,
  posteriorEntropy,
  predictiveOutcomeEntropy,
  resolveDiscoveryTemperatureDecision,
  ruleSupportEntropy,
  temperDiscoveryWeights,
  type WeightedDistribution,
} from '#/agent/testTimeSearch/entropy';
import {
  computeBudgetPressure,
  computeEvaluationRedundancy,
  computeFrontierScore,
  computeGeneralizationLeverage,
} from '#/agent/testTimeSearch/epistemicFrontier';
import {
  outcomeKey,
  projectBoolean,
  projectCategorical,
  projectScalar,
  projectStructured,
} from '#/agent/testTimeSearch/outcomeProjection';

function distributions(
  first: readonly [number, number],
  second: readonly [number, number],
): readonly WeightedDistribution<string>[] {
  return [
    { weight: 0.5, distribution: new Map([['pass', first[0]], ['fail', first[1]]]) },
    { weight: 0.5, distribution: new Map([['pass', second[0]], ['fail', second[1]]]) },
  ];
}

describe('posterior entropy', () => {
  it('is zero when one model has all posterior mass', () => {
    expect(posteriorEntropy([1, 0, 0])).toBe(0);
  });

  it('uses natural logarithms', () => {
    expect(posteriorEntropy([0.5, 0.5])).toBeCloseTo(Math.log(2), 12);
  });

  it('normalizes by the maximum entropy for population size', () => {
    expect(normalizedPosteriorEntropy([0.25, 0.25, 0.25, 0.25])).toBeCloseTo(1, 12);
  });
});

describe('aleatoric and epistemic separation', () => {
  it('assigns high information gain to confident model disagreement', () => {
    const models = distributions([0.99, 0.01], [0.01, 0.99]);
    expect(predictiveOutcomeEntropy(models)).toBeGreaterThan(0.68);
    expect(expectedConditionalOutcomeEntropy(models)).toBeLessThan(0.06);
    expect(epistemicInformationGain(models)).toBeGreaterThan(0.62);
  });

  it('assigns zero information gain to shared noise', () => {
    const models = distributions([0.5, 0.5], [0.5, 0.5]);
    expect(predictiveOutcomeEntropy(models)).toBeCloseTo(Math.log(2), 12);
    expect(expectedConditionalOutcomeEntropy(models)).toBeCloseTo(Math.log(2), 12);
    expect(epistemicInformationGain(models)).toBeCloseTo(0, 12);
  });

  it('matches prior entropy minus expected posterior entropy', () => {
    const models = distributions([0.9, 0.1], [0.2, 0.8]);
    expect(
      posteriorEntropy(models.map((model) => model.weight)) - expectedPosteriorEntropy(models),
    ).toBeCloseTo(epistemicInformationGain(models), 12);
  });
});

describe('decision relevance', () => {
  it('counts only branches that materially change the decision', () => {
    const current = { actionId: 'patch-a', commitEligible: false, hardGate: 'unknown' };
    const sensitivity = estimateDecisionSensitivity(
      current,
      [
        { probability: 0.6, decision: current },
        {
          probability: 0.3,
          decision: { actionId: 'patch-b', commitEligible: false, hardGate: 'unknown' },
        },
        {
          probability: 0.1,
          decision: { actionId: 'patch-a', commitEligible: true, hardGate: 'passed' },
        },
      ],
      (left, right) =>
        left.actionId === right.actionId &&
        left.commitEligible === right.commitEligible &&
        left.hardGate === right.hardGate,
    );
    expect(sensitivity).toBeCloseTo(0.4, 12);
    expect(decisionWeightedInformationGain(0.5, sensitivity)).toBeCloseTo(0.2, 12);
  });
});

describe('discovery-only posterior tempering', () => {
  it('raises viable minority-model influence without reviving zero-weight models', () => {
    const truePosterior = [0.9, 0.08, 0.02, 0];
    const tempered = temperDiscoveryWeights(truePosterior, 0.5);
    expect(tempered[0]).toBeLessThan(truePosterior[0]);
    expect(tempered[1]).toBeGreaterThan(truePosterior[1]);
    expect(tempered[2]).toBeGreaterThan(truePosterior[2]);
    expect(tempered[3]).toBe(0);
    expect(truePosterior).toEqual([0.9, 0.08, 0.02, 0]);
  });

  it('records why the frontier temperature changed', () => {
    expect(
      resolveDiscoveryTemperatureDecision({
        posteriorWeights: [0.5, 0.5],
        stagnated: true,
        decisionRelevantDisagreement: true,
        remainingBudgetFraction: 0.8,
      }),
    ).toEqual({ temperature: 0.5, reason: 'stagnated-disagreement' });
    expect(
      resolveDiscoveryTemperatureDecision({
        posteriorWeights: [0.5, 0.5],
        stagnated: false,
        decisionRelevantDisagreement: true,
        remainingBudgetFraction: 0.2,
      }),
    ).toEqual({ temperature: 1, reason: 'low-budget' });
  });

  it('reports effective posterior sample size', () => {
    expect(effectivePosteriorSampleSize([0.5, 0.5])).toBeCloseTo(2, 12);
    expect(effectivePosteriorSampleSize([1, 0])).toBeCloseTo(1, 12);
  });
});

describe('rule and conflict entropy', () => {
  it('is highest at even support and zero at certainty', () => {
    expect(ruleSupportEntropy(0.5)).toBeCloseTo(Math.log(2), 12);
    expect(conflictEntropy(0)).toBe(0);
    expect(conflictEntropy(1)).toBe(0);
  });
});

describe('decision-relevant outcome projection', () => {
  it('projects boolean and categorical outcomes', () => {
    expect(outcomeKey(projectBoolean(true))).toBe('boolean:true');
    expect(outcomeKey(projectCategorical('serialization-failure'))).toBe(
      'categorical:serialization-failure',
    );
  });

  it('bins scalar outcomes instead of comparing differential entropy', () => {
    const bins = [
      { key: 'no-regression', upperExclusive: 0.01 },
      { key: 'minor', lowerInclusive: 0.01, upperExclusive: 0.15 },
      { key: 'major', lowerInclusive: 0.15 },
    ] as const;
    expect(projectScalar(0.08, bins)).toMatchObject({ kind: 'scalar-bin', bin: 'minor' });
  });

  it('removes volatile fields, normalizes paths, and sorts declared unordered arrays', () => {
    const left = projectStructured(
      {
        processId: 42,
        timestampMs: 10,
        diagnosticCodes: ['B', 'A'],
        file: '/tmp/candidate/src/a.ts',
        assertion: 'failed',
      },
      {
        temporaryRoots: ['/tmp/candidate'],
        unorderedArrayKeys: ['diagnosticCodes'],
      },
    );
    const right = projectStructured(
      {
        processId: 9001,
        timestampMs: 999,
        diagnosticCodes: ['A', 'B'],
        file: '/tmp/candidate/src/a.ts',
        assertion: 'failed',
      },
      {
        temporaryRoots: ['/tmp/candidate'],
        unorderedArrayKeys: ['diagnosticCodes'],
      },
    );
    expect(left).toEqual(right);
    expect(left).toMatchObject({
      kind: 'structured',
      value: {
        assertion: 'failed',
        diagnosticCodes: ['A', 'B'],
        file: '<root>/src/a.ts',
      },
    });
  });
});

describe('frontier scoring', () => {
  it('combines task progress, information, generalization, cost, risk, redundancy, and calibration', () => {
    const score = computeFrontierScore({
      expectedTaskProgress: 0.4,
      decisionWeightedInformationGain: 0.5,
      generalizationLeverage: 0.8,
      executionCost: 0.2,
      executionRisk: 0.1,
      redundancyPenalty: 0.25,
      calibrationPenalty: 0.1,
      remainingBudgetFraction: 0.8,
      discoveryWeight: 0.3,
    });
    expect(score.discoveryBonus).toBeLessThanOrEqual(0.3);
    expect(score.generalizationBonus).toBeGreaterThan(0);
    expect(score.costPenalty).toBeGreaterThan(0);
    expect(score.riskPenalty).toBeGreaterThan(0);
    expect(score.redundancyPenalty).toBeGreaterThan(0);
    expect(score.calibrationPenalty).toBeGreaterThan(0);
    expect(Number.isFinite(score.total)).toBe(true);
  });

  it('caps discovery so uncertainty cannot overwhelm exploitation value', () => {
    const score = computeFrontierScore({
      expectedTaskProgress: 0.1,
      decisionWeightedInformationGain: 100,
      generalizationLeverage: 0,
      executionCost: 0,
      executionRisk: 0,
      redundancyPenalty: 0,
      calibrationPenalty: 0,
      remainingBudgetFraction: 1,
      discoveryWeight: 1,
      discoveryBonusCapFraction: 0.3,
    });
    expect(score.discoveryBonus).toBe(0.3);
  });

  it('increases cost pressure as budget is depleted', () => {
    expect(computeBudgetPressure(0.8)).toBe(0);
    expect(computeBudgetPressure(0.1)).toBeGreaterThan(0.5);
  });

  it('rewards genuinely cross-boundary evaluations', () => {
    expect(computeGeneralizationLeverage(['file'])).toBeLessThan(
      computeGeneralizationLeverage(['package', 'persistence', 'runtime']),
    );
  });

  it('penalizes repeated equivalent evaluations', () => {
    expect(
      computeEvaluationRedundancy(
        ['typecheck', 'package-a', 'changed-files'],
        [['typecheck', 'package-a', 'changed-files']],
      ),
    ).toBe(1);
    expect(
      computeEvaluationRedundancy(
        ['typecheck', 'package-a'],
        [['benchmark', 'package-b']],
      ),
    ).toBe(0);
  });
});
