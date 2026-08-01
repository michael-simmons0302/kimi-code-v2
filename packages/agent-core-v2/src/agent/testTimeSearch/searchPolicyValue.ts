import { createDecorator } from '#/_base/di/instantiation';

export const SEARCH_POLICY_CHECKPOINT_PROTOCOL = 'adaptive-policy-checkpoint/1' as const;
export const SEARCH_EXPERIENCE_PROTOCOL = 'adaptive-search-experience/1' as const;

export interface SearchPolicyActionFeatures {
  readonly actionId: string;
  readonly category: string;
  readonly deterministicPrior: number;
  readonly expectedTaskProgress: number;
  readonly conflictUrgency: number;
  readonly decisionWeightedInformationGain: number;
  readonly generalizationLeverage: number;
  readonly cost: number;
  readonly risk: number;
  readonly redundancy: number;
}

export interface SearchPolicyStateFeatures {
  readonly stateHash: string;
  readonly remainingBudgetFraction: number;
  readonly normalizedPosteriorEntropy: number;
  readonly openConflicts: number;
  readonly viableModels: number;
  readonly verifiedCandidates: number;
  readonly actions: readonly SearchPolicyActionFeatures[];
}

export interface SearchPolicyActionEstimate {
  readonly actionId: string;
  readonly prior: number;
  readonly value: number;
  readonly cost: number;
  readonly risk: number;
  readonly uncertainty: number;
}

export interface SearchPolicyValueEstimate {
  readonly backend: 'deterministic-cold-start' | 'promoted-linear-checkpoint';
  readonly checkpointHash?: string;
  readonly stateValue: number;
  readonly stateValueUncertainty: number;
  readonly actions: readonly SearchPolicyActionEstimate[];
  readonly fallbackReason?: string;
}

export interface SearchPolicyCheckpoint {
  readonly protocol: typeof SEARCH_POLICY_CHECKPOINT_PROTOCOL;
  readonly checkpointId: string;
  readonly featureNames: readonly string[];
  readonly policyWeights: Readonly<Record<string, number>>;
  readonly valueWeights: Readonly<Record<string, number>>;
  readonly uncertaintyWeights: Readonly<Record<string, number>>;
  readonly bias: Readonly<{
    policy: number;
    value: number;
    uncertainty: number;
  }>;
  readonly calibration: Readonly<{
    temperature: number;
    valueScale: number;
    uncertaintyFloor: number;
  }>;
  readonly promotion: Readonly<{
    promoted: boolean;
    independentWindowsPassed: number;
    confirmationScore: number;
    promotionScore: number;
    hardGateRegressions: number;
  }>;
  readonly trainingManifestHash: string;
  readonly modelCardHash: string;
  readonly checkpointHash: string;
}

export interface SearchExperienceRecord {
  readonly protocol: typeof SEARCH_EXPERIENCE_PROTOCOL;
  readonly sequence: number;
  readonly state: SearchPolicyStateFeatures;
  readonly legalActionIds: readonly string[];
  readonly visitDistribution: Readonly<Record<string, number>>;
  readonly selectedActionId: string;
  readonly resultingEvidenceRefs: readonly string[];
  readonly verifiedReturn: number;
  readonly cost: number;
  readonly terminalOutcome: string;
  readonly taskFamily: string;
  readonly repositorySplit: 'development' | 'confirmation' | 'promotion';
}

export interface IAgentSearchPolicyValueService {
  readonly _serviceBrand: undefined;

  ready(): Promise<void>;
  estimate(state: SearchPolicyStateFeatures): SearchPolicyValueEstimate;
  recordExperience(record: SearchExperienceRecord): Promise<void>;
  activeCheckpoint(): SearchPolicyCheckpoint | undefined;
  reloadCheckpoint(): Promise<void>;
  flush(): Promise<void>;
}

export const IAgentSearchPolicyValueService =
  createDecorator<IAgentSearchPolicyValueService>('agentSearchPolicyValueService');
