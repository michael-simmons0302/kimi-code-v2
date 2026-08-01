import { createDecorator } from '#/_base/di/instantiation';
import type {
  CandidateId,
  CausalRuleId,
  WorldModelSetId,
} from '#/agent/adaptiveRuntime/adaptiveProtocol';
import type { CausalValue } from '#/agent/causalRuleGraph/causalRuleGraph';

export type WorldState = CausalValue;
export type WorldAction = CausalValue;
export type WorldObservation = CausalValue;

export interface ProbabilityValue<T> {
  readonly probability: number;
  readonly value: T;
}

export interface PredictedTransition {
  readonly nextState: WorldState;
  readonly observation?: WorldObservation;
  readonly reward?: number;
  readonly terminal?: boolean;
  readonly explanationRuleIds?: readonly CausalRuleId[];
}

export interface TransitionDistribution {
  readonly outcomes: readonly ProbabilityValue<PredictedTransition>[];
}

export interface WorldModelManifest {
  readonly protocol: 'world-model-module/1';
  readonly candidateId: CandidateId;
  readonly parentCandidateIds: readonly CandidateId[];
  readonly sourceHash: string;
  readonly compiledHash: string;
  readonly ruleGraphHash: string;
  readonly stateSchemaHash: string;
  readonly actionSchemaHash: string;
  readonly observationSchemaHash: string;
  readonly deterministic: boolean;
  readonly supportedEvaluatorIds: readonly string[];
  readonly evidenceHead: string;
}

export type WorldModelCandidateStatus =
  | 'proposed'
  | 'parsed'
  | 'compiled'
  | 'sandbox-valid'
  | 'history-consistent'
  | 'held-out-consistent'
  | 'intervention-consistent'
  | 'planning-eligible'
  | 'active'
  | 'promoted'
  | 'quarantined'
  | 'rejected'
  | 'archived';

export interface WorldModelCandidate {
  readonly manifest: WorldModelManifest;
  readonly source: string;
  readonly compiledSource: string;
  readonly ruleIds: readonly CausalRuleId[];
  readonly status: WorldModelCandidateStatus;
  readonly createdAt: number;
  readonly evaluationRefs: readonly string[];
  readonly rejectionReason?: string;
}

export interface WorldModelBelief {
  readonly candidateId: CandidateId;
  readonly logWeight: number;
  readonly normalizedWeight: number;
  readonly planningEligible: boolean;
  readonly hardGateStatus: 'unknown' | 'passed' | 'failed';
  readonly calibrationStatus: 'uncalibrated' | 'calibrated' | 'miscalibrated';
  readonly supportingEvidenceRefs: readonly string[];
  readonly contradictingEvidenceRefs: readonly string[];
}

export interface WorldModelBeliefState {
  readonly worldModelSetId: WorldModelSetId;
  readonly evidenceHead: string;
  readonly beliefs: readonly WorldModelBelief[];
}

export type WorldModelMethod =
  | 'encodeObservation'
  | 'enumerateActions'
  | 'predictTransition'
  | 'predictObservation'
  | 'predictReward'
  | 'predictTerminal'
  | 'projectOutcome'
  | 'explainPrediction';

export interface ProposeWorldModelInput {
  readonly source: string;
  readonly ruleIds: readonly CausalRuleId[];
  readonly parentCandidateIds?: readonly CandidateId[];
  readonly ruleGraphHash: string;
  readonly stateSchemaHash: string;
  readonly actionSchemaHash: string;
  readonly observationSchemaHash: string;
  readonly deterministic: boolean;
  readonly supportedEvaluatorIds?: readonly string[];
  readonly evidenceHead: string;
}

export interface WorldModelLikelihoodUpdate {
  readonly candidateId: CandidateId;
  readonly evidenceRef: string;
  readonly logLikelihood: number;
  readonly deterministicContradiction?: boolean;
  readonly supports?: boolean;
}

export interface IAgentWorldModelService {
  readonly _serviceBrand: undefined;
  ready(): Promise<void>;
  propose(input: ProposeWorldModelInput): Promise<WorldModelCandidate>;
  invoke<T = unknown>(
    candidateId: CandidateId,
    method: WorldModelMethod,
    args: readonly unknown[],
    options?: { readonly timeoutMs?: number; readonly signal?: AbortSignal; readonly seed?: string },
  ): Promise<T>;
  updateLikelihood(update: WorldModelLikelihoodUpdate): Promise<WorldModelBeliefState>;
  setStatus(candidateId: CandidateId, status: WorldModelCandidateStatus, reason?: string): Promise<WorldModelCandidate>;
  get(candidateId: CandidateId): WorldModelCandidate | undefined;
  list(status?: WorldModelCandidateStatus): readonly WorldModelCandidate[];
  beliefState(): WorldModelBeliefState;
  activeCandidates(): readonly WorldModelCandidate[];
  flush(): Promise<void>;
}

export const IAgentWorldModelService = createDecorator<IAgentWorldModelService>(
  'agentWorldModelService',
);
