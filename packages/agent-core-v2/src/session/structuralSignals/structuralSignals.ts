import { createDecorator } from '#/_base/di/instantiation';
import type { ConflictId } from '#/agent/adaptiveRuntime/adaptiveProtocol';

export type StructuralSignalSource =
  | 'agent-event'
  | 'file-watch'
  | 'evaluation'
  | 'candidate'
  | 'world-model'
  | 'workspace';

export type StructuralSignal =
  | {
      readonly kind: 'file-change';
      readonly path: string;
      readonly action: 'created' | 'modified' | 'deleted';
      readonly entryKind: 'file' | 'directory';
    }
  | {
      readonly kind: 'agent-event';
      readonly agentId: string;
      readonly eventType: string;
      readonly event: unknown;
    }
  | {
      readonly kind: 'evaluation-result';
      readonly evaluationId: string;
      readonly evaluatorId: string;
      readonly status: string;
      readonly structureRefs?: readonly string[];
    }
  | {
      readonly kind: 'candidate-overlap';
      readonly candidateIds: readonly string[];
      readonly structureRefs: readonly string[];
    }
  | {
      readonly kind: 'prediction-contradiction';
      readonly candidateId: string;
      readonly ruleIds: readonly string[];
      readonly evidenceRefs: readonly string[];
      readonly structureRefs: readonly string[];
    }
  | {
      readonly kind: 'workspace-reconciled';
      readonly baselineHash: string;
      readonly liveHash: string;
      readonly conflictedPaths: readonly string[];
    };

export interface StructuralSignalEnvelope {
  readonly sequence: number;
  readonly signalId: string;
  readonly observedAtMs: number;
  readonly source: StructuralSignalSource;
  readonly sourceAgentId?: string;
  readonly workspaceSnapshotHash?: string;
  readonly payload: StructuralSignal;
  readonly occurrenceCount: number;
}

export type StructuralConflictKind =
  | 'prediction-conflict'
  | 'scope-conflict'
  | 'evidence-conflict'
  | 'candidate-conflict'
  | 'event-order-conflict'
  | 'persistence-conflict'
  | 'manifest-conflict'
  | 'public-contract-conflict'
  | 'coverage-conflict'
  | 'stale-evidence-conflict'
  | 'signal-overflow';

export interface StructuralConflict {
  readonly conflictId: ConflictId;
  readonly kind: StructuralConflictKind;
  readonly severity: 'information' | 'evaluation-required' | 'commit-blocking';
  readonly status: 'open' | 'scheduled' | 'resolved' | 'superseded' | 'stale';
  readonly openedAtSequence: number;
  readonly updatedAtSequence: number;
  readonly structureRefs: readonly string[];
  readonly ruleIds: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly suggestedEvaluatorIds: readonly string[];
  readonly message: string;
  readonly occurrenceCount: number;
}

export interface ISessionStructuralSignalsService {
  readonly _serviceBrand: undefined;
  ready(): Promise<void>;
  enqueue(
    source: StructuralSignalSource,
    payload: StructuralSignal,
    options?: {
      readonly sourceAgentId?: string;
      readonly workspaceSnapshotHash?: string;
    },
  ): Promise<StructuralSignalEnvelope>;
  conflicts(status?: StructuralConflict['status']): readonly StructuralConflict[];
  resolve(conflictId: ConflictId, status?: 'resolved' | 'superseded' | 'stale'): Promise<void>;
  flush(): Promise<void>;
}

export const ISessionStructuralSignalsService =
  createDecorator<ISessionStructuralSignalsService>('sessionStructuralSignalsService');
