import { createDecorator } from '#/_base/di/instantiation';
import type { CandidateId, WorkspaceSnapshotId } from '#/agent/adaptiveRuntime/adaptiveProtocol';

export interface BaselineFileEntry {
  readonly relativePath: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly executable: boolean;
  readonly symbolicLinkTarget?: string;
}

export interface BaselineSnapshot {
  readonly protocol: 'candidate-baseline/1';
  readonly snapshotId: WorkspaceSnapshotId;
  readonly root: string;
  readonly kind: 'git' | 'directory';
  readonly gitCommit?: string;
  readonly dirtyPatchHash?: string;
  readonly files: readonly BaselineFileEntry[];
  readonly createdAt: number;
  readonly hash: string;
}

export interface CandidateWorkspace {
  readonly candidateId: CandidateId;
  readonly baselineSnapshotId: WorkspaceSnapshotId;
  readonly path: string;
  readonly workspaceHash: string;
  readonly patchHash: string;
  readonly createdAt: number;
}

export interface CandidateWorkspaceReconciliation {
  readonly unchanged: boolean;
  readonly baselineHash: string;
  readonly liveHash: string;
  readonly requiresRevalidation: boolean;
  readonly conflictedPaths: readonly string[];
}

export interface ISessionCandidateWorkspaceService {
  readonly _serviceBrand: undefined;
  ready(): Promise<void>;
  captureBaseline(signal?: AbortSignal): Promise<BaselineSnapshot>;
  baseline(): BaselineSnapshot | undefined;
  materialize(
    candidateId: CandidateId,
    patch: string,
    signal?: AbortSignal,
  ): Promise<CandidateWorkspace>;
  reconcileLive(patch: string, signal?: AbortSignal): Promise<CandidateWorkspaceReconciliation>;
  applyToLive(patch: string, signal?: AbortSignal): Promise<void>;
  cleanup(candidateId: CandidateId): Promise<void>;
  flush(): Promise<void>;
}

export const ISessionCandidateWorkspaceService =
  createDecorator<ISessionCandidateWorkspaceService>('sessionCandidateWorkspaceService');
