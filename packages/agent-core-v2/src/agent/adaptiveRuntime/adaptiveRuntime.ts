import {
  createDecorator,
  IInstantiationService,
  type ServiceIdentifier,
} from '#/_base/di/instantiation';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import type { AdaptivePromptPhase } from '#/agent/adaptivePrompt/adaptivePromptLibrary';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
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
  fail(
    phase: Extract<
      AdaptivePhase,
      | 'blocked'
      | 'cancelled'
      | 'budget-exhausted'
      | 'infrastructure-failed'
      | 'evidence-corrupted'
      | 'no-viable-model'
      | 'commit-rejected'
    >,
    reason: string,
  ): void;
}

export const IAgentAdaptiveRuntimeService = createDecorator<IAgentAdaptiveRuntimeService>(
  'agentAdaptiveRuntimeService',
);

export const IAgentAdaptiveRuntimeImplementation:
  ServiceIdentifier<IAgentAdaptiveRuntimeService> =
  createDecorator<IAgentAdaptiveRuntimeService>('agentAdaptiveRuntimeImplementation');

/**
 * Stable loop dependency. Disabled hosts observe a strict no-op runtime;
 * enabled hosts lazily resolve the full implementation registered by Evolve.
 */
export class AgentAdaptiveRuntimeFacade implements IAgentAdaptiveRuntimeService {
  declare readonly _serviceBrand: undefined;
  private implementationValue: IAgentAdaptiveRuntimeService | undefined;

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IInstantiationService private readonly instantiation: IInstantiationService,
  ) {}

  enabled(): boolean {
    return this.bootstrap.args.adaptiveMode === 'enabled';
  }

  runId(): AdaptiveRunId | undefined {
    return this.implementation()?.runId();
  }

  ensureRun(): AdaptiveRunId | undefined {
    return this.implementation()?.ensureRun();
  }

  phase(): AdaptivePhase {
    return this.implementation()?.phase() ?? 'inactive';
  }

  transition(
    to: AdaptivePhase,
    reason: string,
  ): AdaptivePhaseTransition | undefined {
    return this.implementation()?.transition(to, reason);
  }

  promptPhase(): AdaptivePromptPhase | undefined {
    return this.implementation()?.promptPhase();
  }

  update(update: AdaptiveCounterUpdate): void {
    this.implementation()?.update(update);
  }

  status(): AdaptiveStatusSnapshot | undefined {
    return this.implementation()?.status();
  }

  complete(reason: string): void {
    this.implementation()?.complete(reason);
  }

  fail(
    phase: Extract<
      AdaptivePhase,
      | 'blocked'
      | 'cancelled'
      | 'budget-exhausted'
      | 'infrastructure-failed'
      | 'evidence-corrupted'
      | 'no-viable-model'
      | 'commit-rejected'
    >,
    reason: string,
  ): void {
    this.implementation()?.fail(phase, reason);
  }

  private implementation(): IAgentAdaptiveRuntimeService | undefined {
    if (!this.enabled()) return undefined;
    this.implementationValue ??= this.instantiation.invokeFunction(
      (accessor) => accessor.get(IAgentAdaptiveRuntimeImplementation),
    );
    return this.implementationValue;
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentAdaptiveRuntimeService,
  AgentAdaptiveRuntimeFacade,
  ScopeActivation.OnDemand,
  'adaptiveRuntimeFacade',
);
