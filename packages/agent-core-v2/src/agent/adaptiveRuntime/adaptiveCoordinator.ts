import {
  createDecorator,
  IInstantiationService,
  type ServiceIdentifier,
} from '#/_base/di/instantiation';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
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

export const IAgentAdaptiveCoordinatorImplementation:
  ServiceIdentifier<IAgentAdaptiveCoordinatorService> =
  createDecorator<IAgentAdaptiveCoordinatorService>('agentAdaptiveCoordinatorImplementation');

/** Stable loop dependency with a strict disabled path. */
export class AgentAdaptiveCoordinatorFacade
  implements IAgentAdaptiveCoordinatorService
{
  declare readonly _serviceBrand: undefined;
  private implementationValue: IAgentAdaptiveCoordinatorService | undefined;

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IInstantiationService private readonly instantiation: IInstantiationService,
  ) {}

  async prepareStep(context: AdaptivePrepareStepContext): Promise<void> {
    await this.implementation()?.prepareStep(context);
  }

  async observeStep(
    context: AdaptiveObserveStepContext,
  ): Promise<AdaptiveObserveStepDecision> {
    return this.implementation()?.observeStep(context) ?? {
      stopTurn: false,
      continueTurn: false,
    };
  }

  async flush(): Promise<void> {
    await this.implementationValue?.flush();
  }

  private implementation(): IAgentAdaptiveCoordinatorService | undefined {
    if (this.bootstrap.args.adaptiveMode !== 'enabled') return undefined;
    this.implementationValue ??= this.instantiation.invokeFunction(
      (accessor) => accessor.get(IAgentAdaptiveCoordinatorImplementation),
    );
    return this.implementationValue;
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentAdaptiveCoordinatorService,
  AgentAdaptiveCoordinatorFacade,
  ScopeActivation.OnDemand,
  'adaptiveCoordinatorFacade',
);