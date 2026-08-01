import { createDecorator } from '#/_base/di/instantiation';
import type { AdaptiveBudget, AdaptiveCost } from '#/agent/adaptiveRuntime/adaptiveProtocol';

export const SEARCH_CHECKPOINT_PROTOCOL = 'adaptive-search-checkpoint/1' as const;

export interface SearchCheckpointRandomState {
  readonly generatorId: string;
  readonly state: string;
}

export interface SearchCheckpointEvaluatorState {
  readonly evaluationId: string;
  readonly evaluatorId: string;
  readonly status: 'queued' | 'running' | 'completed' | 'cancelled';
  readonly replicateCount: number;
}

export interface SearchCheckpointTranspositionState {
  readonly entries: number;
  readonly hits: number;
  readonly evictions: number;
  readonly hash: string;
}

export interface SearchCheckpointInput<TState = unknown> {
  readonly ledgerHeadHash: string;
  readonly createdAtSequence: number;
  readonly architectureVersion: string;
  readonly protocolVersions: Readonly<Record<string, string>>;
  readonly configHash?: string;
  readonly workspaceSnapshotHash?: string;
  readonly state: TState;
  readonly budget: AdaptiveBudget;
  readonly cost: AdaptiveCost;
  readonly randomStates: readonly SearchCheckpointRandomState[];
  readonly activeEvaluators: readonly SearchCheckpointEvaluatorState[];
  readonly frontierTemperature: number;
  readonly transpositions: SearchCheckpointTranspositionState;
  readonly reason: string;
}

export interface SearchCheckpoint<TState = unknown>
  extends SearchCheckpointInput<TState> {
  readonly protocol: typeof SEARCH_CHECKPOINT_PROTOCOL;
  readonly checkpointId: string;
  readonly previousCheckpointHash: string | null;
  readonly checkpointHash: string;
}

export interface SearchCheckpointHead {
  readonly protocol: typeof SEARCH_CHECKPOINT_PROTOCOL;
  readonly checkpointId: string | null;
  readonly checkpointHash: string | null;
  readonly sequence: number;
}

export type SearchCheckpointRejectionReason =
  | 'invalid-hash'
  | 'duplicate-hash'
  | 'missing-parent'
  | 'forked-chain'
  | 'cycle'
  | 'ledger-ahead'
  | 'incompatible';

export interface SearchCheckpointRejection {
  readonly checkpointId: string;
  readonly checkpointHash: string;
  readonly reason: SearchCheckpointRejectionReason;
  readonly detail: string;
}

export interface SearchCheckpointRecovery<TState = unknown> {
  readonly checkpoint?: SearchCheckpoint<TState>;
  readonly recoveredFromPrior: boolean;
  readonly exactRequestedHead: boolean;
  readonly rejected: readonly SearchCheckpointRejection[];
}

export interface SearchCheckpointCompatibility {
  readonly architectureVersion: string;
  readonly protocolVersions: Readonly<Record<string, string>>;
  readonly configHash?: string;
  readonly workspaceSnapshotHash?: string;
}

export interface ISessionSearchCheckpointService {
  readonly _serviceBrand: undefined;

  ready(): Promise<void>;
  commit<TState>(input: SearchCheckpointInput<TState>): Promise<SearchCheckpoint<TState>>;
  latest<TState = unknown>(): SearchCheckpoint<TState> | undefined;
  recover<TState = unknown>(
    compatibility: SearchCheckpointCompatibility,
  ): Promise<SearchCheckpointRecovery<TState>>;
  list(): readonly SearchCheckpoint[];
  flush(): Promise<void>;
}

export const ISessionSearchCheckpointService =
  createDecorator<ISessionSearchCheckpointService>('sessionSearchCheckpointService');
