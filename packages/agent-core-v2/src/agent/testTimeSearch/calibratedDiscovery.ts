import type { IWorldModelCalibrationService } from '#/agent/worldModel/worldModelCalibration';
import { finiteEnsembleShrinkage } from './entropy';

export interface CalibratedModelInformation {
  readonly evaluatorFamily: string;
  readonly modelLineage: string;
  readonly posteriorWeight: number;
  readonly informationGain: number;
  readonly effectiveSampleSize: number;
}

export interface CalibratedDiscoveryContribution {
  readonly evaluatorFamily: string;
  readonly modelLineage: string;
  readonly posteriorWeight: number;
  readonly rawInformationGain: number;
  readonly finiteEnsembleInformationGain: number;
  readonly calibrationMultiplier: number;
  readonly calibratedInformationGain: number;
  readonly promotionEligible: boolean;
}

export interface CalibratedDiscoveryResult {
  readonly informationGain: number;
  readonly promotionEligible: boolean;
  readonly contributions: readonly CalibratedDiscoveryContribution[];
}

export function calibratedDiscoveryInformationGain(
  models: readonly CalibratedModelInformation[],
  calibration: Pick<
    IWorldModelCalibrationService,
    'informationGainMultiplier' | 'promotionEligible'
  >,
): CalibratedDiscoveryResult {
  if (models.length === 0) {
    return { informationGain: 0, promotionEligible: false, contributions: [] };
  }
  const totalWeight = models.reduce(
    (sum, model) => sum + sanitizeWeight(model.posteriorWeight),
    0,
  );
  const uniformWeight = 1 / models.length;
  const contributions = models.map((model) => {
    validateModel(model);
    const posteriorWeight = totalWeight > 0
      ? sanitizeWeight(model.posteriorWeight) / totalWeight
      : uniformWeight;
    const finiteEnsembleInformationGain = finiteEnsembleShrinkage(
      model.informationGain,
      model.effectiveSampleSize,
    );
    const calibrationMultiplier = calibration.informationGainMultiplier(
      model.evaluatorFamily,
      model.modelLineage,
    );
    const promotionEligible = calibration.promotionEligible(
      model.evaluatorFamily,
      model.modelLineage,
    );
    return Object.freeze({
      evaluatorFamily: model.evaluatorFamily,
      modelLineage: model.modelLineage,
      posteriorWeight,
      rawInformationGain: model.informationGain,
      finiteEnsembleInformationGain,
      calibrationMultiplier,
      calibratedInformationGain:
        posteriorWeight * finiteEnsembleInformationGain * calibrationMultiplier,
      promotionEligible,
    });
  });
  return Object.freeze({
    informationGain: contributions.reduce(
      (sum, contribution) => sum + contribution.calibratedInformationGain,
      0,
    ),
    promotionEligible: contributions.every(
      (contribution) => contribution.promotionEligible,
    ),
    contributions,
  });
}

function validateModel(model: CalibratedModelInformation): void {
  if (model.evaluatorFamily.trim().length === 0) {
    throw new Error('Calibrated discovery evaluatorFamily cannot be empty.');
  }
  if (model.modelLineage.trim().length === 0) {
    throw new Error('Calibrated discovery modelLineage cannot be empty.');
  }
  if (!Number.isFinite(model.informationGain) || model.informationGain < 0) {
    throw new Error('Calibrated discovery informationGain must be non-negative.');
  }
  if (!Number.isFinite(model.effectiveSampleSize) || model.effectiveSampleSize < 0) {
    throw new Error('Calibrated discovery effectiveSampleSize must be non-negative.');
  }
}

function sanitizeWeight(weight: number): number {
  return Number.isFinite(weight) && weight > 0 ? weight : 0;
}
