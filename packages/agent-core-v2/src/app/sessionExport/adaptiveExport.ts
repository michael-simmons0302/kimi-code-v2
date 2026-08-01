import { createDecorator } from '#/_base/di/instantiation';

export const ADAPTIVE_EXPORT_PROTOCOL = 'adaptive-export-manifest/1' as const;

export interface AdaptiveExportManifest {
  readonly protocol: typeof ADAPTIVE_EXPORT_PROTOCOL;
  readonly architectureVersion: string;
  readonly adaptiveRunCount: number;
  readonly latestRunId?: string;
  readonly latestRunStatus?: string;
  readonly ledgerHeadHash: string | null;
  readonly ledgerRecords: number;
  readonly artifactCount: number;
  readonly exportedArtifactCount: number;
  readonly redactedArtifactCount: number;
  readonly candidateCount: number;
  readonly evaluationCount: number;
  readonly checkpointCount: number;
  readonly checkpointProtocol: string;
  readonly sandboxBackend?: string;
  readonly baselineSnapshotHash?: string;
  readonly redaction: Readonly<{
    protectedEvaluatorArtifactsExcluded: boolean;
    credentialsExcluded: true;
    transientWorkspacesExcluded: true;
    hiddenPromotionInputsExcluded: true;
  }>;
  readonly verification: Readonly<{
    ledgerValid: boolean;
    artifactIndexValid: boolean;
    checkpointIndexValid: boolean;
  }>;
  readonly generatedAtSequence: number;
  readonly manifestHash: string;
}

export interface AdaptiveExportPreparation {
  readonly manifest: AdaptiveExportManifest;
  readonly excludedArtifactHashes: readonly string[];
  readonly retainedArtifactHashes: readonly string[];
  readonly excludedPathFragments: readonly string[];
}

export interface ISessionAdaptiveExportService {
  readonly _serviceBrand: undefined;

  prepare(): Promise<AdaptiveExportPreparation>;
  manifest(): Promise<AdaptiveExportManifest | undefined>;
  verify(manifest: AdaptiveExportManifest): Promise<boolean>;
}

export const ISessionAdaptiveExportService =
  createDecorator<ISessionAdaptiveExportService>('sessionAdaptiveExportService');
