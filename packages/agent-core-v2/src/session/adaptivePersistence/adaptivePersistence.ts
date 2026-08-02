import { createDecorator } from '#/_base/di/instantiation';

export const ADAPTIVE_ARTIFACT_INDEX_PROTOCOL = 'adaptive-artifact-index/1' as const;
export const ADAPTIVE_LAYOUT_PROTOCOL = 'adaptive-layout/1' as const;

export type AdaptiveArtifactSensitivity =
  | 'public'
  | 'workspace-private'
  | 'secret-redacted'
  | 'protected-evaluator';

export interface AdaptiveArtifactMetadata {
  readonly artifactHash: string;
  readonly byteLength: number;
  readonly mediaType: string;
  readonly sensitivity: AdaptiveArtifactSensitivity;
  readonly createdAtSequence: number;
  readonly referenceCount: number;
  readonly pinned: boolean;
  readonly labels: Readonly<Record<string, string>>;
}

export interface PutAdaptiveArtifactInput {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly sensitivity: AdaptiveArtifactSensitivity;
  readonly createdAtSequence: number;
  readonly labels?: Readonly<Record<string, string>>;
  readonly pin?: boolean;
}

export interface AdaptiveArtifactIndex {
  readonly protocol: typeof ADAPTIVE_ARTIFACT_INDEX_PROTOCOL;
  readonly artifacts: readonly AdaptiveArtifactMetadata[];
  readonly updatedAtSequence: number;
}

export interface AdaptivePersistenceLayout {
  readonly protocol: typeof ADAPTIVE_LAYOUT_PROTOCOL;
  readonly sessionRoot: string;
  readonly sessionScopes: Readonly<{
    manifest: string;
    ledger: string;
    signals: string;
    evidence: string;
    conflicts: string;
    causalRules: string;
    worldModels: string;
    evaluations: string;
    search: string;
    checkpoints: string;
    candidates: string;
    memory: string;
    artifacts: string;
    workspaces: string;
    ephemeralAgents: string;
  }>;
  readonly globalRoot: string;
  readonly globalScopes: Readonly<{
    programArchive: string;
    promotedPrompts: string;
    promotedSearchPolicy: string;
    calibration: string;
    benchmarkHistory: string;
    artifacts: string;
  }>;
}

export interface AdaptiveGarbageCollectionResult {
  readonly deleted: readonly string[];
  readonly retainedReferenced: readonly string[];
  readonly retainedPinned: readonly string[];
  readonly retainedYoung: readonly string[];
}

export interface ISessionAdaptivePersistenceService {
  readonly _serviceBrand: undefined;

  ready(): Promise<void>;
  layout(): AdaptivePersistenceLayout;
  putArtifact(input: PutAdaptiveArtifactInput): Promise<AdaptiveArtifactMetadata>;
  putPromotedArtifact(input: PutAdaptiveArtifactInput): Promise<AdaptiveArtifactMetadata>;
  getArtifact(artifactHash: string): Promise<Uint8Array | undefined>;
  getPromotedArtifact(artifactHash: string): Promise<Uint8Array | undefined>;
  metadata(artifactHash: string): AdaptiveArtifactMetadata | undefined;
  promotedMetadata(artifactHash: string): AdaptiveArtifactMetadata | undefined;
  retain(artifactHash: string): Promise<AdaptiveArtifactMetadata>;
  release(artifactHash: string): Promise<AdaptiveArtifactMetadata>;
  pin(artifactHash: string): Promise<AdaptiveArtifactMetadata>;
  garbageCollect(input: {
    readonly currentSequence: number;
    readonly minimumAgeSequences: number;
    readonly maximumDeletes?: number;
  }): Promise<AdaptiveGarbageCollectionResult>;
  listArtifacts(): readonly AdaptiveArtifactMetadata[];
  listPromotedArtifacts(): readonly AdaptiveArtifactMetadata[];
  flush(): Promise<void>;
}

export const ISessionAdaptivePersistenceService =
  createDecorator<ISessionAdaptivePersistenceService>('sessionAdaptivePersistenceService');
