import { createDecorator } from '#/_base/di/instantiation';
import type { AdaptivePromptPhase } from '#/agent/adaptivePrompt/adaptivePromptLibrary';
import type {
  AdaptiveCost,
  AdaptivePhase,
  AdaptiveRunId,
  AdaptiveStatusSnapshot,
} from './adaptiveProtocol';

export interface AdaptivePhaseTransition {
  readonly from: AdaptivePhase;
  readonly to: AdaptivePhase;
  readonly reason: string;
}

export interface AdaptiveCounterUpdate {
  readonly evaluationsCompleted?: number;
  readonly evaluationsActive?: number;
  readonly viableModels?: number;
  readonly openConflicts?: number;
  readonly normalizedPosteriorEntropy?: number;
  readonly decisionWeightedUncertainty?: number;
  readonly verifiedCandidates?: number;
  readonly cost?: Partial<AdaptiveCost>;
}

export interface IAgentAdaptiveRuntimeService {
  readonly _serviceBrand: undefined;

  enabled(): boolean;
  runId(): AdaptiveRunId | undefined;
  ensureRun(): AdaptiveRunId | undefined;
  phase(): AdaptivePhase;
  transition(to: AdaptivePhase, reason: string): AdaptivePhaseTransition | undefined;
  promptPhase(): AdaptivePromptPhase | undefined;
  update(update: AdaptiveCounterUpdate): void;
  status(): AdaptiveStatusSnapshot | undefined;
  complete(reason: string): void;
  fail(phase: Extract<AdaptivePhase, 'blocked' | 'cancelled' | 'budget-exhausted' | 'infrastructure-failed' | 'evidence-corrupted' | 'no-viable-model' | 'commit-rejected'>, reason: string): void;
}

export const IAgentAdaptiveRuntimeService = createDecorator<IAgentAdaptiveRuntimeService>(
  'agentAdaptiveRuntimeService',
);
