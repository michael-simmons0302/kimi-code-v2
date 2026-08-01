import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/_base/state/stateRegistry';
import { IAgentAdaptiveMemoryService } from '#/agent/adaptiveMemory/adaptiveMemory';
import { IAgentAdaptiveDirectiveService } from '#/agent/adaptivePrompt/adaptiveDirectiveService';
import { IAgentCausalRuleGraphService } from '#/agent/causalRuleGraph/causalRuleGraph';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentStateService } from '#/agent/state/agentState';
import {
  IAgentTestTimeSearchService,
  type SearchAction,
  type SearchOutcomePrediction,
  type SearchSelection,
  type SearchState,
} from '#/agent/testTimeSearch/testTimeSearch';
import { IAgentWorldModelService, type WorldModelCandidate } from '#/agent/worldModel/worldModel';
import {
  DEFAULT_ADAPTIVE_BUDGET,
  EVALUATION_SPEC_PROTOCOL,
  createEvaluationId,
  createEvidenceId,
  type CandidateId,
  type ConflictId,
  type EvidenceId,
} from './adaptiveProtocol';
import {
  IAgentAdaptiveCoordinatorImplementation,
  type IAgentAdaptiveCoordinatorService,
  type AdaptiveObserveStepContext,
  type AdaptiveObserveStepDecision,
  type AdaptivePrepareStepContext,
} from './adaptiveCoordinator';
import { IAgentAdaptiveRuntimeService } from './adaptiveRuntime';
import { ISessionCandidateWorkspaceService } from '#/session/candidateWorkspace/candidateWorkspace';
import { ISessionCodeStructureService } from '#/session/codeStructure/codeStructure';
import {
  ISessionEvaluationRegistry,
  ISessionEvaluationService,
  type EvaluationResult,
} from '#/session/evaluation/evaluation';
import {
  DEFAULT_SANDBOX_LIMITS,
  ISessionEvaluationSandbox,
  type SandboxMount,
} from '#/session/evaluationSandbox/evaluationSandbox';
import { ISessionEvaluationLedgerService } from '#/session/evaluationLedger/evaluationLedger';
import {
  ISessionStructuralSignalsService,
  type StructuralConflict,
} from '#/session/structuralSignals/structuralSignals';
import { IAgentWorldModelEvolutionService } from '#/session/worldModelEvolution/worldModelEvolution';

const MAX_INTERNAL_ACTIONS_PER_STEP = 8;
const MAX_ADAPTIVE_CONTINUATIONS = 64;
const DEFAULT_GOAL_VERSION = 1;

interface AdaptiveCoordinatorState {
  readonly initialized: boolean;
  readonly runRecorded: boolean;
  readonly continuationCount: number;
  readonly evaluationsCompleted: number;
  readonly verifiedCandidates: number;
  readonly goalVersion: number;
  readonly lastSelection?: {
    readonly actionId: string;
    readonly kind: SearchAction['kind'];
    readonly description: string;
    readonly nodeId: string;
  };
}

export const adaptiveCoordinatorStateKey = defineState<AdaptiveCoordinatorState>(
  'adaptiveCoordinator.state',
  () => ({
    initialized: false,
    runRecorded: false,
    continuationCount: 0,
    evaluationsCompleted: 0,
    verifiedCandidates: 0,
    goalVersion: DEFAULT_GOAL_VERSION,
  }),
);

export class AgentAdaptiveCoordinatorService
  extends Disposable
  implements IAgentAdaptiveCoordinatorService
{
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentAdaptiveRuntimeService private readonly runtime: IAgentAdaptiveRuntimeService,
    @IAgentAdaptiveDirectiveService private readonly directive: IAgentAdaptiveDirectiveService,
    @IAgentAdaptiveMemoryService private readonly memory: IAgentAdaptiveMemoryService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentStateService private readonly states: IAgentStateService,
    @IAgentCausalRuleGraphService private readonly rules: IAgentCausalRuleGraphService,
    @IAgentWorldModelService private readonly worldModels: IAgentWorldModelService,
    @IAgentTestTimeSearchService private readonly search: IAgentTestTimeSearchService,
    @IAgentWorldModelEvolutionService private readonly evolution: IAgentWorldModelEvolutionService,
    @ISessionCandidateWorkspaceService private readonly workspaces: ISessionCandidateWorkspaceService,
    @ISessionCodeStructureService private readonly structure: ISessionCodeStructureService,
    @ISessionEvaluationRegistry private readonly evaluators: ISessionEvaluationRegistry,
    @ISessionEvaluationService private readonly evaluation: ISessionEvaluationService,
    @ISessionEvaluationSandbox private readonly sandbox: ISessionEvaluationSandbox,
    @ISessionEvaluationLedgerService private readonly ledger: ISessionEvaluationLedgerService,
    @ISessionStructuralSignalsService private readonly signals: ISessionStructuralSignalsService,
  ) {
    super();
    states.register(adaptiveCoordinatorStateKey);
  }

  async prepareStep(step: AdaptivePrepareStepContext): Promise<void> {
    if (!this.runtime.enabled()) return;
    step.signal.throwIfAborted();
    const runId = this.runtime.ensureRun();
    if (runId === undefined) return;
    await Promise.all([
      this.ledger.ready(),
      this.sandbox.ready(),
      this.workspaces.ready(),
      this.structure.ready(),
      this.signals.ready(),
      this.rules.ready(),
      this.worldModels.ready(),
      this.search.ready(),
      this.memory.ready(),
    ]);

    if (!this.state.runRecorded) {
      await this.ledger.append({
        recordType: 'adaptive.run.started',
        adaptiveRunId: runId,
        payload: {
          architecture: 'evolve-architecture/1',
          turnId: step.turnId,
          step: step.step,
          stepId: step.stepId,
          goalVersion: this.state.goalVersion,
          sandbox: this.sandbox.backend(),
        },
      });
      this.state = { ...this.state, runRecorded: true };
    }

    if (!this.state.initialized) {
      await this.initialize(step.signal);
      this.state = { ...this.state, initialized: true };
    }
    await this.planUntilExternalAction(step.signal);
  }

  async observeStep(
    step: AdaptiveObserveStepContext,
  ): Promise<AdaptiveObserveStepDecision> {
    if (!this.runtime.enabled()) return { stopTurn: false, continueTurn: false };
    if (isTerminalPhase(this.runtime.phase())) {
      return { stopTurn: true, continueTurn: false };
    }

    const finalResponseStep = this.runtime.phase() === 'committing';
    if (!finalResponseStep) {
      this.runtime.transition(
        'reconciling',
        'Reconciling the observed step outcome with the causal models.',
      );
    }

    const previousBaseline = this.workspaces.baseline();
    const reconciliation =
      previousBaseline === undefined
        ? undefined
        : await this.workspaces.reconcileLive('', step.signal);
    const baseline = await this.workspaces.captureBaseline(step.signal);
    const structure = await this.structure.rebuild(step.signal);
    await this.memory.invalidateForStructure(
      structure.hash,
      'The repository structure changed after a real task action.',
    );

    const actionEvidenceId = createEvidenceId();
    await this.ledger.append({
      recordType: 'task.action.executed',
      adaptiveRunId: this.runtime.runId(),
      evidenceId: actionEvidenceId,
      payload: {
        turnId: step.turnId,
        step: step.step,
        stepId: step.stepId,
        finishReason: step.finishReason,
        usage: step.usage,
        previousBaselineHash: previousBaseline?.hash,
        baselineHash: baseline.hash,
        reconciliation,
        finalResponseStep,
        ledgerHead: this.ledger.head().recordHash,
      },
    });

    await this.memory.saveSummary({
      kind: 'trajectory',
      goalVersion: this.state.goalVersion,
      structureHash: structure.hash,
      claims: [
        {
          text: `The real step ended with finish reason ${step.finishReason}.`,
          evidenceRefs: [actionEvidenceId],
        },
      ],
      trajectory: {
        attemptedCause:
          this.state.lastSelection?.description ??
          'Advance the current task using the highest-value supported action.',
        selectedEvaluation: 'Observe the real KC step and reconcile its direct result.',
        observedOutcome: `Finish reason: ${step.finishReason}.`,
        rulesSupported: [],
        rulesRejected: [],
        unresolvedConflicts: this.signals
          .conflicts('open')
          .map((conflict) => conflict.conflictId),
        usefulArtifactRefs: [],
        verifiedProgress:
          this.state.verifiedCandidates > 0
            ? `${String(this.state.verifiedCandidates)} verification result(s) currently pass.`
            : 'No commit-eligible verification result exists yet.',
        remainingDecision: finalResponseStep
          ? 'Verify that the final response remains supported by the committed evidence.'
          : 'Determine whether hard gates pass or another action is required.',
      },
    });

    if (
      !finalResponseStep &&
      (reconciliation?.unchanged === false || step.finishReason !== 'tool_calls')
    ) {
      await this.verifyCurrentWorkspace(step.signal);
    }

    const assessment = this.search.assessCommit({
      hardGatesPass: this.state.verifiedCandidates > 0,
      commitBlockingConflicts: this.signals
        .conflicts('open')
        .filter((conflict) => conflict.severity === 'commit-blocking').length,
      actionStableAcrossModels:
        (this.runtime.status()?.normalizedPosteriorEntropy ?? 1) <= 0.25 ||
        this.worldModels.activeCandidates().length <= 1,
      expectedAdditionalInformationValue:
        this.runtime.status()?.decisionWeightedUncertainty ?? 1,
      expectedAdditionalCost: 0.1,
      liveWorkspaceReconciled:
        reconciliation === undefined || reconciliation.conflictedPaths.length === 0,
      claimsSupported: this.state.verifiedCandidates > 0,
    });

    if (finalResponseStep) {
      if (!assessment.eligible) {
        this.runtime.fail(
          'commit-rejected',
          assessment.reasons.join('; ') || 'Final commit gates did not pass.',
        );
        this.directive.set(undefined);
        await this.flush();
        return { stopTurn: true, continueTurn: false };
      }
      await this.ledger.append({
        recordType: 'solution.commit.selected',
        adaptiveRunId: this.runtime.runId(),
        payload: {
          assessment,
          selection: this.state.lastSelection,
          baselineHash: baseline.hash,
          structureHash: structure.hash,
          finalResponseStep: true,
        },
      });
      this.runtime.complete('Verified solution and final response committed.');
      this.directive.set(undefined);
      await this.flush();
      return { stopTurn: true, continueTurn: false };
    }

    if (step.finishReason !== 'tool_calls' && assessment.eligible) {
      this.runtime.transition('committing', 'All commit gates passed.');
      await this.search.checkpoint();
      this.directive.set(
        'Return only the completed change, decisive verification, and unresolved material risk. Omit investigation history and unsupported claims.',
      );
      return { stopTurn: false, continueTurn: true };
    }

    if (this.state.continuationCount >= MAX_ADAPTIVE_CONTINUATIONS) {
      this.runtime.fail('budget-exhausted', 'Adaptive continuation budget exhausted.');
      this.directive.set(undefined);
      await this.flush();
      return { stopTurn: true, continueTurn: false };
    }

    this.runtime.transition('planning', 'Further evidence or task progress is required.');
    this.state = {
      ...this.state,
      continuationCount: this.state.continuationCount + 1,
    };
    return { stopTurn: false, continueTurn: true };
  }

  async flush(): Promise<void> {
    await Promise.all([
      this.memory.flush(),
      this.search.flush(),
      this.worldModels.flush(),
      this.rules.flush(),
      this.signals.flush(),
      this.workspaces.flush(),
      this.evaluation.flush(),
      this.ledger.flush(),
    ]);
  }

  private get state(): AdaptiveCoordinatorState {
    return this.states.get(adaptiveCoordinatorStateKey);
  }

  private set state(value: AdaptiveCoordinatorState) {
    this.states.set(adaptiveCoordinatorStateKey, value);
  }

  private async initialize(signal: AbortSignal): Promise<void> {
    this.runtime.transition(
      'indexing',
      'Capturing the workspace and building the structural graph.',
    );
    const baseline =
      this.workspaces.baseline() ?? (await this.workspaces.captureBaseline(signal));
    await this.ledger.append({ recordType: 'baseline.captured', payload: baseline });
    const structure = this.structure.snapshot() ?? (await this.structure.rebuild(signal));
    this.runtime.transition('discovering', 'Deriving repository-scale causal invariants.');
    await this.seedRepositoryRules(structure.hash);
    this.runtime.transition('modeling', 'Constructing executable causal models.');
    await this.ensureWorldModelPopulation(signal, false);
  }

  private async seedRepositoryRules(structureHash: string): Promise<void> {
    if (this.rules.list().length > 0) return;
    const nodes = this.structure.snapshot()?.nodes ?? [];
    const evidence = [`structure:${structureHash}`];
    await this.proposeRepositoryRule(
      nodes
        .filter((node) =>
          ['interface', 'type', 'service-registration', 'tool-registration'].includes(
            node.kind,
          ),
        )
        .map((node) => node.id),
      'change-public-contract',
      [
        { target: 'implementations', operation: 'invalidate' },
        { target: 'callers', operation: 'invalidate' },
        { target: 'tests', operation: 'invalidate' },
      ],
      evidence,
    );
    await this.proposeRepositoryRule(
      nodes
        .filter((node) =>
          ['config-section', 'persistence-shape', 'generated-artifact'].includes(node.kind),
        )
        .map((node) => node.id),
      'change-persisted-contract',
      [
        { target: 'compatibility', operation: 'invalidate' },
        { target: 'generated-manifests', operation: 'invalidate' },
        { target: 'round-trip-tests', operation: 'invalidate' },
      ],
      evidence,
    );
  }

  private async proposeRepositoryRule(
    subjectRefs: readonly string[],
    action: string,
    predictedEffects: readonly { readonly target: string; readonly operation: 'invalidate' }[],
    supportingEvidenceRefs: readonly string[],
  ): Promise<void> {
    if (subjectRefs.length === 0) return;
    await this.rules.propose({
      scope: 'repository',
      condition: { expression: { anySubjectChanges: subjectRefs } },
      intervention: { action: { type: action } },
      predictedEffects,
      subjectRefs,
      supportingEvidenceRefs,
    });
  }

  private async ensureWorldModelPopulation(
    signal: AbortSignal,
    forceAlternative: boolean,
  ): Promise<void> {
    const active = this.worldModels.activeCandidates();
    if (active.length >= 2 && !forceAlternative) return;
    const ruleSnapshot = this.rules.snapshot();
    const evidenceHead = this.ledger.head().recordHash ?? 'genesis';
    const kind = forceAlternative ? 'adversarial-alternative' : 'propose';
    const result = await this.evolution.evolve(
      {
        kind,
        objective: this.currentObjective(),
        observations: await this.compactObservations(),
        counterexamples: [],
        conflicts: this.signals.conflicts('open'),
        ruleIds: ruleSnapshot.rules.map((rule) => rule.ruleId),
        parentCandidateIds: active.map((candidate) => candidate.manifest.candidateId),
        parentCandidates: active,
        ruleGraphHash: ruleSnapshot.hash,
        stateSchemaHash: hashValue('adaptive-state/1'),
        actionSchemaHash: hashValue('adaptive-action/1'),
        observationSchemaHash: hashValue('adaptive-observation/1'),
        evidenceHead,
        maximumCandidates: forceAlternative ? 2 : 4,
      },
      signal,
    );
    for (const bundle of result.candidates) {
      const candidate = await this.worldModels.propose({
        source: bundle.source,
        ruleIds: bundle.ruleIds,
        parentCandidateIds: bundle.parentCandidateIds,
        ruleGraphHash: ruleSnapshot.hash,
        stateSchemaHash: hashValue('adaptive-state/1'),
        actionSchemaHash: hashValue('adaptive-action/1'),
        observationSchemaHash: hashValue('adaptive-observation/1'),
        deterministic: bundle.deterministic,
        supportedEvaluatorIds: bundle.supportedEvaluatorIds,
        evidenceHead,
      });
      await this.ledger.append({
        recordType: 'world_model.proposed',
        adaptiveRunId: this.runtime.runId(),
        payload: {
          requestId: result.requestId,
          providerTraceId: result.providerTraceId,
          kind,
          candidateId: candidate.manifest.candidateId,
          parentCandidateIds: candidate.manifest.parentCandidateIds,
          rationaleSummary: bundle.rationaleSummary,
          sourceHash: candidate.manifest.sourceHash,
        },
      });
    }
    this.runtime.update({ viableModels: this.worldModels.activeCandidates().length });
  }

  private async planUntilExternalAction(signal: AbortSignal): Promise<void> {
    for (let iteration = 0; iteration < MAX_INTERNAL_ACTIONS_PER_STEP; iteration += 1) {
      signal.throwIfAborted();
      const state = this.buildSearchState();
      const rootId = await this.search.begin(state);
      const actions = this.generateActions();
      await this.search.addActions(rootId, actions);
      const selection = await this.search.select(rootId);
      this.state = {
        ...this.state,
        lastSelection: {
          actionId: selection.action.actionId,
          kind: selection.action.kind,
          description: selection.action.description,
          nodeId: selection.nodeId,
        },
      };
      const handled = await this.executeInternalAction(selection, signal);
      if (!handled) {
        this.runtime.transition('acting', selection.action.description);
        this.directive.set(selection.action.description);
        return;
      }
    }
    this.runtime.fail(
      'budget-exhausted',
      `Internal adaptive action budget exceeded ${String(MAX_INTERNAL_ACTIONS_PER_STEP)} actions in one step.`,
    );
    throw new Error('Adaptive internal action budget exhausted before a real task action was selected.');
  }

  private generateActions(): readonly SearchAction[] {
    const conflicts = this.signals
      .conflicts('open')
      .filter((conflict) => conflict.status === 'open');
    const actions: SearchAction[] = [];
    for (const conflict of conflicts.slice(0, 4)) {
      const evaluatorId = firstRegisteredEvaluator(
        conflict.suggestedEvaluatorIds,
        this.evaluators,
      );
      if (evaluatorId === undefined) continue;
      actions.push(this.conflictEvaluationAction(conflict, evaluatorId));
    }
    for (const evaluator of this.evaluators.list().slice(0, 4)) {
      if (actions.some((action) => action.actionId === `evaluate:${evaluator.evaluatorId}`)) continue;
      actions.push({
        actionId: `evaluate:${evaluator.evaluatorId}`,
        kind: 'run-evaluation',
        description: `Run evaluator ${evaluator.evaluatorId} on the current workspace.`,
        payload: { evaluatorId: evaluator.evaluatorId },
        prior: evaluator.level === 'validity' ? 0.95 : 0.6,
        expectedTaskValue: evaluator.level === 'validity' ? 0.8 : 0.5,
        expectedProgress: 0.7,
        generalizationLeverage: evaluator.scale === 'repository' ? 0.8 : 0.4,
        decisionSensitivity: 0.9,
        calibrationFactor: evaluator.mode === 'deterministic' ? 1 : 0.7,
        wallCost: evaluator.defaultTimeoutMs / 1_000,
        tokenCost: 0,
        toolCost: 1,
        executionRisk: 0.05,
        redundancyPenalty: 0,
        hardGate: evaluator.level === 'validity',
        predictions: this.predictionsForEvaluator(evaluator.evaluatorId),
      });
    }
    if (this.worldModels.activeCandidates().length < 2) {
      actions.push({
        actionId: 'expand-world-model-population',
        kind: 'expand-world-model-population',
        description: 'Propose an independent alternative causal model before committing.',
        payload: {},
        prior: 0.9,
        expectedTaskValue: 0.3,
        expectedProgress: 0.4,
        generalizationLeverage: 0.9,
        decisionSensitivity: 0.8,
        calibrationFactor: 0.6,
        wallCost: 5,
        tokenCost: 1,
        toolCost: 0,
        executionRisk: 0.05,
        redundancyPenalty: 0,
      });
    }
    actions.push({
      actionId: 'execute-task-action',
      kind: 'execute-task-action',
      description: this.actionDirective(conflicts),
      payload: {},
      prior: 0.8,
      expectedTaskValue: 0.9,
      expectedProgress: 0.9,
      generalizationLeverage: 0.5,
      decisionSensitivity: 0.8,
      calibrationFactor: 1,
      wallCost: 1,
      tokenCost: 1,
      toolCost: 1,
      executionRisk: 0.15,
      redundancyPenalty: 0,
      predictions: this.predictionsForTaskAction(),
    });
    return actions;
  }

  private conflictEvaluationAction(
    conflict: StructuralConflict,
    evaluatorId: string,
  ): SearchAction {
    return {
      actionId: `conflict:${conflict.conflictId}:${evaluatorId}`,
      kind: 'run-evaluation',
      description: `Resolve ${conflict.kind} with evaluator ${evaluatorId}.`,
      payload: { evaluatorId, conflictId: conflict.conflictId },
      prior: conflict.severity === 'commit-blocking' ? 1 : 0.8,
      expectedTaskValue: 0.7,
      expectedProgress: 0.6,
      generalizationLeverage: conflict.structureRefs.length > 1 ? 0.8 : 0.4,
      decisionSensitivity: conflict.severity === 'commit-blocking' ? 1 : 0.7,
      calibrationFactor: 1,
      wallCost: 2,
      tokenCost: 0,
      toolCost: 1,
      executionRisk: 0.05,
      redundancyPenalty: Math.min(1, Math.max(0, conflict.occurrenceCount - 1) / 10),
      hardGate: conflict.severity === 'commit-blocking',
      predictions: this.predictionsForEvaluator(evaluatorId),
    };
  }

  private predictionsForEvaluator(
    evaluatorId: string,
  ): readonly SearchOutcomePrediction[] | undefined {
    const candidates = this.worldModels.activeCandidates();
    if (candidates.length < 2) return undefined;
    return candidates.map((candidate, index) => ({
      candidateId: candidate.manifest.candidateId,
      modelWeight:
        this.worldModels
          .beliefState()
          .beliefs.find(
            (belief) => belief.candidateId === candidate.manifest.candidateId,
          )?.normalizedWeight ?? 1 / candidates.length,
      distribution: predictedEvaluationDistribution(candidate, evaluatorId, index),
    }));
  }

  private predictionsForTaskAction(): readonly SearchOutcomePrediction[] | undefined {
    const candidates = this.worldModels.activeCandidates();
    if (candidates.length < 2) return undefined;
    return candidates.map((candidate, index) => ({
      candidateId: candidate.manifest.candidateId,
      modelWeight:
        this.worldModels
          .beliefState()
          .beliefs.find(
            (belief) => belief.candidateId === candidate.manifest.candidateId,
          )?.normalizedWeight ?? 1 / candidates.length,
      distribution: index % 2 === 0
        ? { progress: 0.7, no_progress: 0.2, regression: 0.1 }
        : { progress: 0.4, no_progress: 0.4, regression: 0.2 },
    }));
  }

  private async executeInternalAction(
    selection: SearchSelection,
    signal: AbortSignal,
  ): Promise<boolean> {
    switch (selection.action.kind) {
      case 'run-evaluation':
      case 'run-replicate':
      case 'evaluate-task-patch': {
        await this.runEvaluation(selection, signal);
        return true;
      }
      case 'expand-world-model-population':
      case 'revise-world-model': {
        await this.ensureWorldModelPopulation(signal, true);
        await this.search.observe(selection, 'population-expanded', 0.3, this.buildSearchState());
        return true;
      }
      case 'inspect-structure': {
        const snapshot = await this.structure.rebuild(signal);
        await this.search.observe(selection, 'structure-indexed', 0.2, {
          ...this.buildSearchState(),
          structureIndexHash: snapshot.hash,
        });
        return true;
      }
      case 'construct-intervention':
      case 'propose-task-patch':
      case 'simulate-task-action':
      case 'execute-task-action':
      case 'commit-solution':
        return false;
    }
  }

  private async runEvaluation(
    selection: SearchSelection,
    signal: AbortSignal,
  ): Promise<void> {
    const payload = selection.action.payload as {
      readonly evaluatorId?: unknown;
      readonly conflictId?: unknown;
    };
    const evaluatorId =
      typeof payload.evaluatorId === 'string' ? payload.evaluatorId : undefined;
    if (evaluatorId === undefined) {
      await this.search.observe(selection, 'invalid-evaluation-action', -1, this.buildSearchState());
      return;
    }
    const definition = this.evaluators.get(evaluatorId);
    this.runtime.transition('evaluating', `Running ${evaluatorId}.`);
    this.runtime.update({ evaluationsActive: 1 });
    const result = await this.evaluation.evaluate(
      {
        protocol: EVALUATION_SPEC_PROTOCOL,
        evaluationId: createEvaluationId(),
        adaptiveRunId: this.runtime.runId(),
        evaluatorId,
        evaluatorVersion: definition.version,
        input: await this.evaluationInput(definition.scale, signal),
        budget: {
          timeoutMs: definition.defaultTimeoutMs,
          maximumReplicates: definition.mode === 'stochastic' ? 16 : 1,
          maximumOutputBytes: 8 * 1024 * 1024,
        },
        seed: definition.mode === 'stochastic'
          ? `${evaluatorId}:${String(this.state.evaluationsCompleted + 1)}`
          : undefined,
        tags: ['adaptive', selection.action.kind],
      },
      signal,
    );
    const success = result.status === 'passed';
    const evidenceId = createEvidenceId();
    await this.ledger.append({
      recordType: 'evaluation.completed',
      adaptiveRunId: this.runtime.runId(),
      evidenceId,
      payload: {
        result,
        selection: {
          decisionId: selection.decisionId,
          actionId: selection.action.actionId,
          nodeId: selection.nodeId,
        },
      },
    });
    await this.updateWorldModelBeliefs(result, evidenceId);
    const conflictId =
      typeof payload.conflictId === 'string'
        ? (payload.conflictId as ConflictId)
        : undefined;
    if (success && conflictId !== undefined) await this.signals.resolve(conflictId);
    this.state = {
      ...this.state,
      evaluationsCompleted: this.state.evaluationsCompleted + 1,
      verifiedCandidates: this.state.verifiedCandidates + (success ? 1 : 0),
    };
    this.runtime.update({
      evaluationsActive: 0,
      evaluationsCompleted: this.state.evaluationsCompleted,
      verifiedCandidates: this.state.verifiedCandidates,
      openConflicts: this.signals.conflicts('open').length,
      viableModels: this.worldModels.activeCandidates().length,
      cost: {
        evaluations: this.state.evaluationsCompleted,
        wallMs: result.cost.wallMs,
        inputTokens: result.cost.inputTokens ?? 0,
        outputTokens: result.cost.outputTokens ?? 0,
      },
    });
    await this.memory.saveSummary({
      kind: success ? 'verified-progress' : 'failure',
      goalVersion: this.state.goalVersion,
      structureHash: this.structure.snapshot()?.hash ?? 'unknown',
      claims: [
        {
          text: success
            ? `Evaluator ${evaluatorId} passed.`
            : `Evaluator ${evaluatorId} did not pass: ${result.status}.`,
          evidenceRefs: [evidenceId],
        },
      ],
      exactDiagnostics: diagnosticsFrom(result),
      decisiveCounterexampleRefs: success ? [] : [evidenceId],
      artifactRefs: result.artifactRefs.map((artifact) => artifact.artifactId),
    });
    await this.search.observe(
      selection,
      result.status,
      success ? 1 : result.status === 'inconclusive' ? -0.1 : -0.8,
      this.buildSearchState(),
    );
    this.runtime.transition('planning', `Evaluator ${evaluatorId} completed with ${result.status}.`);
  }

  private async evaluationInput(
    scale: string,
    signal: AbortSignal,
  ): Promise<unknown> {
    const baseline = this.workspaces.baseline() ?? (await this.workspaces.captureBaseline(signal));
    const snapshot = this.structure.snapshot() ?? (await this.structure.rebuild(signal));
    if (scale === 'runtime' || scale === 'repository' || scale === 'package') {
      const packageRoot = await findPackageRoot(baseline.root);
      const mount = packageRoot === baseline.root
        ? []
        : [{ source: packageRoot, target: '/mnt/package-root' } satisfies SandboxMount];
      return {
        protocol: 'evaluation-sandbox/1',
        workspacePath: baseline.root,
        cwd: '.',
        args: ['node', '--version'],
        env: { ADAPTIVE_STRUCTURE_HASH: snapshot.hash },
        capabilities: ['workspace-read', 'process-spawn', ...(mount.length > 0 ? ['additional-read-mount'] : [])],
        mounts: mount,
        limits: DEFAULT_SANDBOX_LIMITS,
      };
    }
    return {
      baselineHash: baseline.hash,
      structureHash: snapshot.hash,
      scale,
    };
  }

  private async updateWorldModelBeliefs(
    result: EvaluationResult,
    evidenceId: EvidenceId,
  ): Promise<void> {
    const candidates = this.worldModels.activeCandidates();
    for (const [index, candidate] of candidates.entries()) {
      const predictedPass = index % 2 === 0 ? 0.75 : 0.45;
      const observedPass = result.status === 'passed';
      const probability = observedPass ? predictedPass : 1 - predictedPass;
      await this.worldModels.updateLikelihood({
        candidateId: candidate.manifest.candidateId,
        evidenceRef: evidenceId,
        logLikelihood: Math.log(Math.max(1e-9, probability)),
        deterministicContradiction:
          candidate.manifest.deterministic && probability <= 1e-9,
        supports: observedPass,
      });
    }
    const beliefs = this.worldModels.beliefState();
    const entropy = normalizedBeliefEntropy(beliefs.beliefs.map((belief) => belief.normalizedWeight));
    this.runtime.update({
      normalizedPosteriorEntropy: entropy,
      decisionWeightedUncertainty: entropy,
      viableModels: this.worldModels.activeCandidates().length,
    });
  }

  private buildSearchState(): SearchState {
    const baseline = this.workspaces.baseline();
    const structure = this.structure.snapshot();
    const beliefs = this.worldModels.beliefState();
    const conflicts = this.signals.conflicts('open');
    const trajectorySummaryHash = hashValue(
      this.memory.summaries({ goalVersion: this.state.goalVersion }),
    );
    return {
      workspaceSnapshotHash: baseline?.hash ?? 'uncaptured',
      beliefStateHash: hashValue(beliefs),
      causalRuleGraphHash: this.rules.snapshot().hash,
      structureIndexHash: structure?.hash ?? 'unindexed',
      unresolvedConflictHash: hashValue(conflicts),
      trajectorySummaryHash,
      verifiedCandidateIds: this.worldModels
        .activeCandidates()
        .filter((candidate) => candidate.status === 'active' || candidate.status === 'promoted')
        .map((candidate) => candidate.manifest.candidateId),
      remainingBudget: {
        ...DEFAULT_ADAPTIVE_BUDGET,
        maxEvaluations: Math.max(
          0,
          DEFAULT_ADAPTIVE_BUDGET.maxEvaluations - this.state.evaluationsCompleted,
        ),
        maxCandidates: Math.max(
          0,
          DEFAULT_ADAPTIVE_BUDGET.maxCandidates - this.worldModels.list().length,
        ),
      },
      goalVersion: this.state.goalVersion,
    };
  }

  private actionDirective(conflicts: readonly StructuralConflict[]): string {
    const open = conflicts
      .filter((conflict) => conflict.severity !== 'information')
      .map((conflict) => conflict.message);
    const selected = this.state.lastSelection?.description;
    return [
      selected ?? this.currentObjective(),
      open.length > 0
        ? `Resolve these repository constraints while acting: ${open.join('; ')}`
        : 'Execute the next task action while preserving verified repository invariants.',
      'Use direct tool evidence. Do not claim verification before its evaluator result exists.',
    ].join('\n');
  }

  private currentObjective(): string {
    for (const message of [...this.context.get()].reverse()) {
      if (message.role !== 'user') continue;
      const text = message.content
        .flatMap((part) => (part.type === 'text' ? [part.text] : []))
        .join('')
        .trim();
      if (text.length > 0) return text;
    }
    return 'Complete the current repository task with verified evidence.';
  }

  private async compactObservations(): Promise<readonly unknown[]> {
    const candidates = [];
    for await (const record of this.ledger.records()) {
      if (
        record.recordType === 'evaluation.completed' ||
        record.recordType === 'counterexample.recorded' ||
        record.recordType === 'tool.result.recorded'
      ) {
        candidates.push({
          evidenceId: record.evidenceId,
          recordType: record.recordType,
          payload: record.payload,
        });
      }
    }
    const selection = this.memory.selectEvidence(
      candidates.map((candidate, index) => ({
        evidenceId:
          candidate.evidenceId ??
          (`ledger:${String(index)}` as EvidenceId),
        text: JSON.stringify(candidate),
        contentHash: hashValue(candidate),
        tokenEstimate: Math.max(1, Math.ceil(JSON.stringify(candidate).length / 4)),
        structuralRelevance: candidate.recordType === 'tool.result.recorded' ? 0.8 : 0.5,
        causalRelevance: candidate.recordType === 'counterexample.recorded' ? 1 : 0.7,
        decisionRelevance: candidate.recordType === 'evaluation.completed' ? 1 : 0.6,
        recency: Math.min(1, (index + 1) / Math.max(1, candidates.length)),
        redundancy: 0,
        exactDiagnostic: candidate.recordType === 'evaluation.completed',
        decisiveCounterexample: candidate.recordType === 'counterexample.recorded',
      })),
      16_000,
    );
    return selection.selected.map((candidate) => ({
      evidenceId: candidate.evidenceId,
      text: candidate.text,
    }));
  }
}

function predictedEvaluationDistribution(
  candidate: WorldModelCandidate,
  evaluatorId: string,
  index: number,
): Readonly<Record<string, number>> {
  const supported = candidate.manifest.supportedEvaluatorIds.includes(evaluatorId);
  if (supported) return index % 2 === 0 ? { passed: 0.8, failed: 0.15, inconclusive: 0.05 } : { passed: 0.55, failed: 0.35, inconclusive: 0.1 };
  return index % 2 === 0 ? { passed: 0.4, failed: 0.45, inconclusive: 0.15 } : { passed: 0.25, failed: 0.55, inconclusive: 0.2 };
}

function firstRegisteredEvaluator(
  suggested: readonly string[],
  registry: ISessionEvaluationRegistry,
): string | undefined {
  const available = new Set(registry.list().map((definition) => definition.evaluatorId));
  return suggested.find((candidate) => available.has(candidate));
}

function diagnosticsFrom(result: EvaluationResult): readonly string[] {
  return result.assertions
    .filter((assertion) => !assertion.passed)
    .map((assertion) => assertion.message ?? assertion.assertionId);
}

function normalizedBeliefEntropy(weights: readonly number[]): number {
  const positive = weights.filter((weight) => Number.isFinite(weight) && weight > 0);
  if (positive.length <= 1) return 0;
  const total = positive.reduce((sum, weight) => sum + weight, 0);
  const entropy = -positive.reduce((sum, weight) => {
    const p = weight / total;
    return sum + p * Math.log(p);
  }, 0);
  return entropy / Math.log(positive.length);
}

function hashValue(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, current: unknown) => {
    if (
      current !== null &&
      typeof current === 'object' &&
      !Array.isArray(current) &&
      !(current instanceof Uint8Array)
    ) {
      const source = current as Record<string, unknown>;
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(source).sort()) {
        if (source[key] !== undefined) sorted[key] = source[key];
      }
      return sorted;
    }
    return current;
  });
}

async function findPackageRoot(start: string): Promise<string> {
  let current = start;
  while (true) {
    try {
      const stat = await lstat(`${current}/package.json`);
      if (stat.isFile()) return current;
    } catch {
    }
    const parent = current.replace(/[\\/][^\\/]+$/, '');
    if (parent === current || parent.length === 0) return start;
    current = parent;
  }
}

function isTerminalPhase(phase: string): boolean {
  return [
    'completed',
    'blocked',
    'cancelled',
    'budget-exhausted',
    'infrastructure-failed',
    'evidence-corrupted',
    'no-viable-model',
    'commit-rejected',
  ].includes(phase);
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentAdaptiveCoordinatorImplementation,
  AgentAdaptiveCoordinatorService,
  ScopeActivation.OnDemand,
  'adaptiveCoordinatorImplementation',
);