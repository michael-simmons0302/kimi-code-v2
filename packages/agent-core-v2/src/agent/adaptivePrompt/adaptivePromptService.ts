import { createDecorator } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentAdaptiveRuntimeService } from '#/agent/adaptiveRuntime/adaptiveRuntime';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import {
  constraintForPhase,
  fragmentForPhase,
  promptHash,
  type AdaptivePromptFragment,
} from './adaptivePromptLibrary';

export interface AdaptivePromptSelection {
  readonly primary: AdaptivePromptFragment;
  readonly constraint: AdaptivePromptFragment;
  readonly primaryHash: string;
  readonly constraintHash: string;
}

export interface AdaptivePromptTrace {
  readonly protocol: 'adaptive-prompt/1';
  readonly phase: AdaptivePromptFragment['phase'];
  readonly fragmentIds: readonly string[];
  readonly versions: readonly number[];
  readonly contentHashes: readonly string[];
}

export interface IAgentAdaptivePromptService {
  readonly _serviceBrand: undefined;
  current(): AdaptivePromptSelection | undefined;
  trace(): AdaptivePromptTrace | undefined;
}

export const IAgentAdaptivePromptService = createDecorator<IAgentAdaptivePromptService>(
  'agentAdaptivePromptService',
);

export class AgentAdaptivePromptService
  extends Disposable
  implements IAgentAdaptivePromptService
{
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentAdaptiveRuntimeService private readonly runtime: IAgentAdaptiveRuntimeService,
    @IAgentContextInjectorService injector: IAgentContextInjectorService,
  ) {
    super();
    this._register(
      injector.register(
        'adaptive-operating-fragment',
        () => this.current()?.primary.content,
      ),
    );
    this._register(
      injector.register(
        'adaptive-constraint-fragment',
        () => this.current()?.constraint.content,
      ),
    );
  }

  current(): AdaptivePromptSelection | undefined {
    if (!this.runtime.enabled()) return undefined;
    this.runtime.ensureRun();
    const phase = this.runtime.promptPhase();
    if (phase === undefined) return undefined;
    const primary = fragmentForPhase(phase);
    const constraint = constraintForPhase(phase);
    return {
      primary,
      constraint,
      primaryHash: promptHash(primary.content),
      constraintHash: promptHash(constraint.content),
    };
  }

  trace(): AdaptivePromptTrace | undefined {
    const selection = this.current();
    if (selection === undefined) return undefined;
    return {
      protocol: 'adaptive-prompt/1',
      phase: selection.primary.phase,
      fragmentIds: [selection.primary.id, selection.constraint.id],
      versions: [selection.primary.version, selection.constraint.version],
      contentHashes: [selection.primaryHash, selection.constraintHash],
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
