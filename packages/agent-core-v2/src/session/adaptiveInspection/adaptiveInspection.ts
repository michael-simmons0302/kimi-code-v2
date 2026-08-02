import { createDecorator } from '#/_base/di/instantiation';
import type { AdaptiveStatusSnapshot } from '#/agent/adaptiveRuntime/adaptiveProtocol';
import type { CalibrationMetrics } from '#/agent/worldModel/worldModelCalibration';
import type { AdaptiveArtifactMetadata } from '#/session/adaptivePersistence/adaptivePersistence';
import type { StructuralConflict } from '#/session/structuralSignals/structuralSignals';

export const ADAPTIVE_INSPECTION_PROTOCOL = 'adaptive-inspection/1' as const;

export interface AdaptiveRunInspection {
  readonly runId: string;
  readonly status: string;
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly evaluations: number;
  readonly candidates: number;
  readonly finalClaims: number;
}

export interface AdaptiveEvidenceInspection {
  readonly ledgerValid: boolean;
  readonly ledgerRecords: number;
  readonly ledgerHeadHash: string | null;
  readonly evidenceNodes: number;
  readonly evidenceLinks: number;
  readonly recordTypeCounts: Readonly<Record<string, number>>;
}

export interface AdaptiveCheckpointInspection {
  readonly count: number;
  readonly latestCheckpointId?: string;
  readonly latestSequence?: number;
  readonly latestReason?: string;
}

export interface AdaptiveInspectionSnapshot {
  readonly protocol: typeof ADAPTIVE_INSPECTION_PROTOCOL;
  readonly status?: AdaptiveStatusSnapshot;
  readonly runs: readonly AdaptiveRunInspection[];
  readonly conflicts: readonly StructuralConflict[];
  readonly evidence: AdaptiveEvidenceInspection;
  readonly checkpoints: AdaptiveCheckpointInspection;
  readonly artifacts: readonly AdaptiveArtifactMetadata[];
  readonly calibration: readonly CalibrationMetrics[];
  readonly generatedAtSequence: number;
  readonly snapshotHash: string;
}

export interface ISessionAdaptiveInspectionService {
  readonly _serviceBrand: undefined;

  ready(): Promise<void>;
  status(agentId?: string): AdaptiveStatusSnapshot | undefined;
  runs(): Promise<readonly AdaptiveRunInspection[]>;
  conflicts(): readonly StructuralConflict[];
  evidence(): Promise<AdaptiveEvidenceInspection>;
  checkpoints(): AdaptiveCheckpointInspection;
  artifacts(): readonly AdaptiveArtifactMetadata[];
  calibration(): readonly CalibrationMetrics[];
  snapshot(agentId?: string): Promise<AdaptiveInspectionSnapshot>;
}

export const ISessionAdaptiveInspectionService =
  createDecorator<ISessionAdaptiveInspectionService>('sessionAdaptiveInspectionService');
