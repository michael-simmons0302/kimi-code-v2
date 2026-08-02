import { createDecorator } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/_base/state/stateRegistry';
import { IAgentAdaptiveRuntimeService } from '#/agent/adaptiveRuntime/adaptiveRuntime';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentStateService } from '#/agent/state/agentState';

export interface IAgentAdaptiveDirectiveService {
  readonly _serviceBrand: undefined;
  set(content: string | undefined): void;
  get(): string | undefined;
}

export const IAgentAdaptiveDirectiveService =
  createDecorator<IAgentAdaptiveDirectiveService>('agentAdaptiveDirectiveService');

export const adaptiveDirectiveStateKey = defineState<string | undefined>(
  'adaptivePrompt.directive',
  () => undefined,
);

export class AgentAdaptiveDirectiveService
  extends Disposable
  implements IAgentAdaptiveDirectiveService
{
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentAdaptiveRuntimeService private readonly runtime: IAgentAdaptiveRuntimeService,
    @IAgentStateService private readonly states: IAgentStateService,
    @IAgentContextInjectorService injector: IAgentContextInjectorService,
  ) {
    super();
    states.register(adaptiveDirectiveStateKey);
    this._register(
      injector.register('adaptive-immediate-directive', () => {
        if (!runtime.enabled()) return undefined;
        const content = this.get();
        return content === undefined
          ? undefined
          : `Immediate objective selected by verified search:\n${content}`;
      }),
    );
  }

  set(content: string | undefined): void {
    if (content !== undefined && content.length > 2_000) {
      throw new Error('Adaptive immediate directive exceeds 2,000 characters.');
    }
    this.states.set(adaptiveDirectiveStateKey, content?.trim() || undefined);
  }

  get(): string | undefined {
    return this.states.get(adaptiveDirectiveStateKey);
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentAdaptiveDirectiveService,
  AgentAdaptiveDirectiveService,
  ScopeActivation.OnScopeCreated,
  'adaptiveDirective',
);
