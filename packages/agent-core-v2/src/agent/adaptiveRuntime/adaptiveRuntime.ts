import { createDecorator } from '#/_base/di/instantiation';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
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

/** Default binding used when the host did not load Evolve registrations. */
export class DisabledAgentAdaptiveRuntimeService implements IAgentAdaptiveRuntimeService {
  declare readonly _serviceBrand: undefined;

  enabled(): boolean { return false; }
  runId(): AdaptiveRunId | undefined { return undefined; }
  ensureRun(): AdaptiveRunId | undefined { return undefined; }
  phase(): AdaptivePhase { return 'inactive'; }
  transition(): AdaptivePhaseTransition | undefined { return undefined; }
  promptPhase(): AdaptivePromptPhase | undefined { return undefined; }
  update(): void {}
  status(): AdaptiveStatusSnapshot | undefined { return undefined; }
  complete(): void {}
  fail(): void {}
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentAdaptiveRuntimeService,
  DisabledAgentAdaptiveRuntimeService,
  ScopeActivation.OnDemand,
  'adaptiveRuntimeDisabled',
);
