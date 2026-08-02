import { createDecorator } from '#/_base/di/instantiation';

export const WORLD_MODEL_CALIBRATION_PROTOCOL = 'adaptive-calibration/1' as const;

export type CalibrationTargetKind =
  | 'boolean'
  | 'categorical'
  | 'scalar-interval';

export type CalibrationStatus =
  | 'uncalibrated'
  | 'calibrated'
  | 'miscalibrated'
  | 'severely-miscalibrated';

export interface BooleanCalibrationObservation {
  readonly kind: 'boolean';
  readonly probability: number;
  readonly observed: boolean;
}

export interface CategoricalCalibrationObservation {
  readonly kind: 'categorical';
  readonly probabilities: Readonly<Record<string, number>>;
  readonly observedCategory: string;
}

export interface ScalarIntervalCalibrationObservation {
  readonly kind: 'scalar-interval';
  readonly lower: number;
  readonly upper: number;
  readonly observed: number;
  readonly confidenceLevel: number;
}

export type CalibrationObservation =
  | BooleanCalibrationObservation
  | CategoricalCalibrationObservation
  | ScalarIntervalCalibrationObservation;

export interface CalibrationObservationEnvelope {
  readonly evaluatorFamily: string;
  readonly modelLineage: string;
  readonly split: 'adaptation' | 'confirmation' | 'promotion' | 'held-out';
  readonly sequence: number;
  readonly observation: CalibrationObservation;
}

export interface ReliabilityBin {
  readonly lowerInclusive: number;
  readonly upperInclusive: number;
  readonly count: number;
  readonly predictedMean: number;
  readonly observedMean: number;
}

export interface CalibrationMetrics {
  readonly protocol: typeof WORLD_MODEL_CALIBRATION_PROTOCOL;
  readonly evaluatorFamily: string;
  readonly modelLineage: string;
  readonly observations: number;
  readonly booleanAndCategoricalObservations: number;
  readonly intervalObservations: number;
  readonly brierScore?: number;
  readonly logLoss?: number;
  readonly intervalCoverage?: number;
  readonly expectedCalibrationError?: number;
  readonly reliabilityBins: readonly ReliabilityBin[];
  readonly status: CalibrationStatus;
  readonly informationGainMultiplier: number;
  readonly promotionEligible: boolean;
  readonly regimeShift: boolean;
  readonly updatedAtSequence: number;
}

export interface CalibrationSnapshot {
  readonly protocol: typeof WORLD_MODEL_CALIBRATION_PROTOCOL;
  readonly metrics: readonly CalibrationMetrics[];
  readonly observations: readonly CalibrationObservationEnvelope[];
  readonly hash: string;
}

export interface IWorldModelCalibrationService {
  readonly _serviceBrand: undefined;

  ready(): Promise<void>;
  record(observation: CalibrationObservationEnvelope): Promise<CalibrationMetrics>;
  recordMany(
    observations: readonly CalibrationObservationEnvelope[],
  ): Promise<readonly CalibrationMetrics[]>;
  recalibrateHeldOut(
    evaluatorFamily: string,
    modelLineage: string,
    observations: readonly CalibrationObservationEnvelope[],
  ): Promise<CalibrationMetrics>;
  metrics(evaluatorFamily: string, modelLineage: string): CalibrationMetrics;
  informationGainMultiplier(
    evaluatorFamily: string,
    modelLineage: string,
  ): number;
  promotionEligible(evaluatorFamily: string, modelLineage: string): boolean;
  snapshot(): CalibrationSnapshot;
  flush(): Promise<void>;
}

export const IWorldModelCalibrationService =
  createDecorator<IWorldModelCalibrationService>('worldModelCalibrationService');
