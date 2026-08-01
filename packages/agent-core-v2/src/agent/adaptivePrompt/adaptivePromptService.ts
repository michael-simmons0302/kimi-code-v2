import { createHash } from 'node:crypto';

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentAdaptiveRuntimeService } from '#/agent/adaptiveRuntime/adaptiveRuntime';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { fragmentForPhase, type AdaptivePromptFragment } from './adaptivePromptLibrary';
import { createDecorator } from '#/_base/di/instantiation';

export interface AdaptivePromptSelection {
  readonly fragment: AdaptivePromptFragment;
  readonly contentHash: string;
}

export interface IAgentAdaptivePromptService {
  readonly _serviceBrand: undefined;
  current(): AdaptivePromptSelection | undefined;
}

export const IAgentAdaptivePromptService = createDecorator<IAgentAdaptivePromptService>(
  'agentAdaptivePromptService',
);

export class AgentAdaptivePromptService extends Disposable implements IAgentAdaptivePromptService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentAdaptiveRuntimeService private readonly runtime: IAgentAdaptiveRuntimeService,
    @IAgentContextInjectorService injector: IAgentContextInjectorService,
  ) {
    super();
    this._register(
      injector.register('adaptive-operating-fragment', () => this.current()?.fragment.content),
    );
  }

  current(): AdaptivePromptSelection | undefined {
    if (!this.runtime.enabled()) return undefined;
    this.runtime.ensureRun();
    const phase = this.runtime.promptPhase();
    if (phase === undefined) return undefined;
    const fragment = fragmentForPhase(phase);
    return {
      fragment,
      contentHash: createHash('sha256').update(fragment.content).digest('hex'),
    };
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentAdaptivePromptService,
  AgentAdaptivePromptService,
  ScopeActivation.OnScopeCreated,
  'adaptivePrompt',
);
