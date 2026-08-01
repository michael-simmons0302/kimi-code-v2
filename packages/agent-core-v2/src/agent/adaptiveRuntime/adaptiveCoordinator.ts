import { createDecorator } from '#/_base/di/instantiation';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import type { FinishReason } from '#/kosong/contract/provider';
import type { TokenUsage } from '#/kosong/contract/usage';

export interface AdaptivePrepareStepContext {
  readonly turnId: number;
  readonly step: number;
  readonly stepId: string;
  readonly signal: AbortSignal;
}

export interface AdaptiveObserveStepContext extends AdaptivePrepareStepContext {
  readonly usage: TokenUsage;
  readonly finishReason: FinishReason;
}

export interface AdaptiveObserveStepDecision {
  readonly stopTurn: boolean;
  readonly continueTurn: boolean;
}

export interface IAgentAdaptiveCoordinatorService {
  readonly _serviceBrand: undefined;
  prepareStep(context: AdaptivePrepareStepContext): Promise<void>;
  observeStep(context: AdaptiveObserveStepContext): Promise<AdaptiveObserveStepDecision>;
  flush(): Promise<void>;
}

export const IAgentAdaptiveCoordinatorService =
  createDecorator<IAgentAdaptiveCoordinatorService>('agentAdaptiveCoordinatorService');

/** Default binding used when the host did not load Evolve registrations. */
export class DisabledAgentAdaptiveCoordinatorService
  implements IAgentAdaptiveCoordinatorService
{
  declare readonly _serviceBrand: undefined;

  async prepareStep(): Promise<void> {}
  async observeStep(): Promise<AdaptiveObserveStepDecision> {
    return { stopTurn: false, continueTurn: false };
  }
  async flush(): Promise<void> {}
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentAdaptiveCoordinatorService,
  DisabledAgentAdaptiveCoordinatorService,
  ScopeActivation.OnDemand,
  'adaptiveCoordinatorDisabled',
);
