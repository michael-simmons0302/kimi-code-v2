import { createDecorator } from '#/_base/di/instantiation';
import type { AdaptiveRunId, EvidenceId } from '#/agent/adaptiveRuntime/adaptiveProtocol';

export type EvaluationLedgerRecordType =
  | 'adaptive.run.started'
  | 'adaptive.phase.changed'
  | 'baseline.captured'
  | 'request.recorded'
  | 'tool.call.recorded'
  | 'tool.result.recorded'
  | 'evaluation.started'
  | 'evaluation.replicate.completed'
  | 'evaluation.completed'
  | 'counterexample.recorded'
  | 'structural.signal.recorded'
  | 'conflict.opened'
  | 'conflict.resolved'
  | 'causal.rule.proposed'
  | 'causal.rule.superseded'
  | 'world_model.proposed'
  | 'world_model.evaluated'
  | 'world_model.posterior.updated'
  | 'search.action.proposed'
  | 'search.action.selected'
  | 'task.action.executed'
  | 'search.checkpoint.committed'
  | 'solution.commit.selected'
  | 'final.claim.verified'
  | 'adaptive.run.completed'
  | 'adaptive.run.cancelled'
  | 'adaptive.run.failed';

export interface EvaluationLedgerRecord<TPayload = unknown> {
  readonly protocol: 'adaptive-ledger/1';
  readonly sequence: number;
  readonly previousRecordHash: string | null;
  readonly recordHash: string;
  readonly recordType: EvaluationLedgerRecordType;
  readonly adaptiveRunId?: AdaptiveRunId;
  readonly evidenceId?: EvidenceId;
  readonly payload: TPayload;
}

export interface EvaluationLedgerHead {
  readonly protocol: 'adaptive-ledger/1';
  readonly sequence: number;
  readonly recordHash: string | null;
}

export interface AppendEvaluationLedgerInput<TPayload = unknown> {
  readonly recordType: EvaluationLedgerRecordType;
  readonly adaptiveRunId?: AdaptiveRunId;
  readonly evidenceId?: EvidenceId;
  readonly payload: TPayload;
}

export interface EvaluationLedgerVerification {
  readonly valid: boolean;
  readonly records: number;
  readonly head: EvaluationLedgerHead;
  readonly error?: string;
}

export interface ISessionEvaluationLedgerService {
  readonly _serviceBrand: undefined;

  ready(): Promise<void>;
  append<TPayload>(input: AppendEvaluationLedgerInput<TPayload>): Promise<EvaluationLedgerRecord<TPayload>>;
  records(): AsyncIterable<EvaluationLedgerRecord>;
  head(): EvaluationLedgerHead;
  verify(): Promise<EvaluationLedgerVerification>;
  flush(): Promise<void>;
}

export const ISessionEvaluationLedgerService = createDecorator<ISessionEvaluationLedgerService>(
  'sessionEvaluationLedgerService',
);
