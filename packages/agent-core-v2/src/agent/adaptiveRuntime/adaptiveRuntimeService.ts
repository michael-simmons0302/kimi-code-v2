import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/_base/state/stateRegistry';
import type { AdaptivePromptPhase } from '#/agent/adaptivePrompt/adaptivePromptLibrary';
import { IAgentStateService } from '#/agent/state/agentState';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IEventBus } from '#/app/event/eventBus';
import { ISessionAdaptiveConfigService } from './adaptiveConfigService';
import {
  IAgentAdaptiveRuntimeImplementation,
  type IAgentAdaptiveRuntimeService,
  type AdaptiveCounterUpdate,
  type AdaptivePhaseTransition,
} from './adaptiveRuntime';
import {
  createAdaptiveRunId,
  emptyAdaptiveCost,
  remainingBudgetFraction,
  type AdaptiveCost,
  type AdaptivePhase,
  type AdaptiveRunId,
  type AdaptiveStatusSnapshot,
} from './adaptiveProtocol';
import './adaptiveEvents';

interface AdaptiveRuntimeState {
  readonly runId?: AdaptiveRunId;
  readonly phase: AdaptivePhase;
  readonly evaluationsCompleted: number;
  readonly evaluationsActive: number;
  readonly viableModels: number;
  readonly openConflicts: number;
  readonly normalizedPosteriorEntropy: number;
  readonly decisionWeightedUncertainty: number;
  readonly verifiedCandidates: number;
  readonly cost: AdaptiveCost;
}

function emptyState(): AdaptiveRuntimeState {
  return {
    phase: 'inactive',
    evaluationsCompleted: 0,
    evaluationsActive: 0,
    viableModels: 0,
    openConflicts: 0,
    normalizedPosteriorEntropy: 0,
    decisionWeightedUncertainty: 0,
    verifiedCandidates: 0,
    cost: emptyAdaptiveCost(),
  };
}

export const adaptiveRuntimeStateKey = defineState<AdaptiveRuntimeState>(
  'adaptiveRuntime.state',
  emptyState,
);

const VALID_TRANSITIONS: Readonly<Record<AdaptivePhase, readonly AdaptivePhase[]>> = {
  inactive: ['initializing'],
  initializing: ['indexing', 'infrastructure-failed', 'evidence-corrupted', 'cancelled'],
  indexing: ['discovering', 'modeling', 'evaluating', 'blocked', 'cancelled', 'infrastructure-failed'],
  discovering: ['modeling', 'evaluating', 'planning', 'blocked', 'cancelled', 'budget-exhausted'],
  modeling: ['discovering', 'evaluating', 'planning', 'no-viable-model', 'cancelled', 'budget-exhausted'],
  evaluating: ['discovering', 'modeling', 'planning', 'reconciling', 'committing', 'blocked', 'cancelled', 'budget-exhausted', 'infrastructure-failed'],
  planning: ['discovering', 'modeling', 'evaluating', 'acting', 'committing', 'blocked', 'cancelled', 'budget-exhausted'],
  acting: ['reconciling', 'blocked', 'cancelled', 'infrastructure-failed'],
  reconciling: ['discovering', 'modeling', 'evaluating', 'planning', 'committing', 'blocked', 'cancelled', 'evidence-corrupted'],
  committing: ['completed', 'commit-rejected', 'blocked', 'cancelled', 'infrastructure-failed'],
  completed: [],
  blocked: [],
  cancelled: [],
  'budget-exhausted': [],
  'infrastructure-failed': [],
  'evidence-corrupted': [],
  'no-viable-model': [],
  'commit-rejected': [],
};

export class AgentAdaptiveRuntimeService implements IAgentAdaptiveRuntimeService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @ISessionAdaptiveConfigService private readonly adaptiveConfig: ISessionAdaptiveConfigService,
    @IAgentStateService private readonly states: IAgentStateService,
    @IEventBus private readonly events: IEventBus,
  ) {
    this.states.register(adaptiveRuntimeStateKey);
  }

  enabled(): boolean {
    return this.bootstrap.args.adaptiveMode === 'enabled';
  }

  runId(): AdaptiveRunId | undefined {
    return this.state.runId;
  }

  ensureRun(): AdaptiveRunId | undefined {
    if (!this.enabled()) return undefined;
    if (this.state.runId !== undefined) return this.state.runId;
    const runId = createAdaptiveRunId();
    this.state = { ...emptyState(), runId, phase: 'initializing' };
    this.events.publish({ type: 'adaptive.run.started', runId });
    this.publishStatus();
    return runId;
  }

  phase(): AdaptivePhase {
    return this.state.phase;
  }

  transition(to: AdaptivePhase, reason: string): AdaptivePhaseTransition | undefined {
    const runId = this.ensureRun();
    if (runId === undefined) return undefined;
    const from = this.state.phase;
    if (from === to) return { from, to, reason };
    if (!VALID_TRANSITIONS[from].includes(to)) {
      throw new Error(`Invalid adaptive phase transition: ${from} -> ${to}`);
    }
    this.state = { ...this.state, phase: to };
    this.events.publish({ type: 'adaptive.phase.changed', runId, from, to, reason });
    this.publishStatus();
    return { from, to, reason };
  }

  promptPhase(): AdaptivePromptPhase | undefined {
    switch (this.state.phase) {
      case 'initializing':
      case 'indexing':
      case 'discovering':
        return 'hypothesis-formation';
      case 'modeling':
        return 'candidate-repair';
      case 'evaluating':
      case 'planning':
        return 'evaluation-selection';
      case 'acting':
      case 'reconciling':
        return 'cross-file-analysis';
      case 'committing':
        return 'commit';
      case 'inactive':
      case 'completed':
      case 'blocked':
      case 'cancelled':
      case 'budget-exhausted':
      case 'infrastructure-failed':
      case 'evidence-corrupted':
      case 'no-viable-model':
      case 'commit-rejected':
        return undefined;
    }
  }

  update(update: AdaptiveCounterUpdate): void {
    if (!this.enabled()) return;
    this.ensureRun();
    const cost = update.cost === undefined
      ? this.state.cost
      : { ...this.state.cost, ...update.cost };
    this.state = {
      ...this.state,
      evaluationsCompleted: update.evaluationsCompleted ?? this.state.evaluationsCompleted,
      evaluationsActive: update.evaluationsActive ?? this.state.evaluationsActive,
      viableModels: update.viableModels ?? this.state.viableModels,
      openConflicts: update.openConflicts ?? this.state.openConflicts,
      normalizedPosteriorEntropy:
        update.normalizedPosteriorEntropy ?? this.state.normalizedPosteriorEntropy,
      decisionWeightedUncertainty:
        update.decisionWeightedUncertainty ?? this.state.decisionWeightedUncertainty,
      verifiedCandidates: update.verifiedCandidates ?? this.state.verifiedCandidates,
      cost,
    };
    this.publishStatus();
  }

  status(): AdaptiveStatusSnapshot | undefined {
    const state = this.state;
    if (state.runId === undefined) return undefined;
    return {
      runId: state.runId,
      phase: state.phase,
      evaluationsCompleted: state.evaluationsCompleted,
      evaluationsActive: state.evaluationsActive,
      viableModels: state.viableModels,
      openConflicts: state.openConflicts,
      normalizedPosteriorEntropy: state.normalizedPosteriorEntropy,
      decisionWeightedUncertainty: state.decisionWeightedUncertainty,
      remainingBudgetFraction: remainingBudgetFraction(
        this.adaptiveConfig.snapshot().config.budget,
        state.cost,
      ),
      verifiedCandidates: state.verifiedCandidates,
    };
  }

  reset(reason: string): void {
    const previousRunId = this.state.runId;
    this.state = emptyState();
    if (previousRunId !== undefined) {
      this.events.publish({
        type: 'adaptive.run.cancelled',
        runId: previousRunId,
        reason,
      });
    }
  }

  complete(reason: string): void {
    const runId = this.ensureRun();
    if (runId === undefined) return;
    this.transition('completed', reason);
    this.events.publish({ type: 'adaptive.run.completed', runId, reason });
  }

  fail(
    phase: Extract<AdaptivePhase, 'blocked' | 'cancelled' | 'budget-exhausted' | 'infrastructure-failed' | 'evidence-corrupted' | 'no-viable-model' | 'commit-rejected'>,
    reason: string,
  ): void {
    const runId = this.ensureRun();
    if (runId === undefined) return;
    this.transition(phase, reason);
    this.events.publish({ type: 'adaptive.run.failed', runId, phase, reason });
  }

  private get state(): AdaptiveRuntimeState {
    return this.states.get(adaptiveRuntimeStateKey);
  }

  private set state(value: AdaptiveRuntimeState) {
    this.states.set(adaptiveRuntimeStateKey, value);
  }

  private publishStatus(): void {
    const status = this.status();
    if (status !== undefined) this.events.publish({ type: 'adaptive.status.updated', status });
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentAdaptiveRuntimeImplementation,
  AgentAdaptiveRuntimeService,
  ScopeActivation.OnDemand,
  'adaptiveRuntimeImplementation',
);
