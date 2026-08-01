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
  IAgentAdaptiveCoordinatorService,
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
      'repository',
    );
    await this.proposeRepositoryRule(
      nodes
        .filter((node) =>
          ['wire-model', 'wire-operation', 'persistence-schema'].includes(node.kind),
        )
        .map((node) => node.id),
      'change-persisted-contract',
      [
        { target: 'restore', operation: 'invalidate' },
        { target: 'replay', operation: 'invalidate' },
        { target: 'export', operation: 'invalidate' },
      ],
      evidence,
      'repository',
    );
    await this.proposeRepositoryRule(
      nodes
        .filter((node) =>
          ['event-type', 'event-publisher', 'event-subscriber'].includes(node.kind),
        )
        .map((node) => node.id),
      'change-event-contract',
      [
        { target: 'publishers', operation: 'invalidate' },
        { target: 'subscribers', operation: 'invalidate' },
        { target: 'event-order', operation: 'invalidate' },
      ],
      evidence,
      'runtime',
    );
    await this.proposeRepositoryRule(
      nodes
        .filter((node) => node.kind === 'generated-artifact')
        .map((node) => node.id),
      'change-generated-source',
      [{ target: 'generated-artifacts', operation: 'invalidate' }],
      evidence,
      'repository',
    );
  }

  private async proposeRepositoryRule(
    subjectRefs: readonly string[],
    actionType: string,
    predictedEffects: Parameters<IAgentCausalRuleGraphService['propose']>[0]['predictedEffects'],
    supportingEvidenceRefs: readonly string[],
    scope: 'repository' | 'runtime',
  ): Promise<void> {
    if (subjectRefs.length === 0) return;
    await this.rules.propose({
      scope,
      condition: { expression: { changedStructures: subjectRefs } },
      intervention: { action: { type: actionType } },
      predictedEffects,
      subjectRefs,
      supportingEvidenceRefs,
    });
  }

  private async ensureWorldModelPopulation(
    signal: AbortSignal,
    forceExpansion: boolean,
  ): Promise<void> {
    const active = this.worldModels.activeCandidates();
    if (!forceExpansion && active.length >= 3) return;
    const kind =
      active.length === 0
        ? 'propose'
        : forceExpansion
          ? 'expand-state-abstraction'
          : 'adversarial-alternative';
    const proposed = await this.evolution.evolve(
      {
        kind,
        objective: this.currentObjective(),
        observations: [this.structureSummary(), this.memorySummary()],
        counterexamples: this.worldModels.list('rejected').map((candidate) => ({
          candidateId: candidate.manifest.candidateId,
          reason: candidate.rejectionReason,
          evaluationRefs: candidate.evaluationRefs,
        })),
        conflicts: this.signals.conflicts('open'),
        ruleIds: this.rules.list().map((rule) => rule.ruleId),
        parentCandidateIds: this.worldModels
          .list()
          .map((candidate) => candidate.manifest.candidateId),
        parentCandidates: this.worldModels.list(),
        ruleGraphHash: this.rules.snapshot().hash,
        stateSchemaHash: hashText('adaptive-state-schema/1'),
        actionSchemaHash: hashText('adaptive-action-schema/1'),
        observationSchemaHash: hashText('adaptive-observation-schema/1'),
        evidenceHead: this.ledger.head().recordHash ?? '',
        maximumCandidates: Math.max(
          3,
          Math.min(8, DEFAULT_ADAPTIVE_BUDGET.maxCandidates),
        ),
      },
      signal,
    );

    for (const bundle of proposed.candidates) {
      try {
        const candidate = await this.worldModels.propose({
          source: bundle.source,
          ruleIds: bundle.ruleIds,
          parentCandidateIds: bundle.parentCandidateIds,
          ruleGraphHash: this.rules.snapshot().hash,
          stateSchemaHash: hashText('adaptive-state-schema/1'),
          actionSchemaHash: hashText('adaptive-action-schema/1'),
          observationSchemaHash: hashText('adaptive-observation-schema/1'),
          deterministic: bundle.deterministic,
          supportedEvaluatorIds: bundle.supportedEvaluatorIds,
          evidenceHead: this.ledger.head().recordHash ?? '',
        });
        await this.validateCandidate(candidate, signal);
      } catch (error) {
        await this.ledger.append({
          recordType: 'world_model.evaluated',
          payload: {
            sourceHash: hashText(bundle.source),
            status: 'rejected',
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }

    if (this.worldModels.activeCandidates().length === 0) {
      this.runtime.fail(
        'no-viable-model',
        'No generated causal model passed sandbox validation.',
      );
      throw new Error('No generated causal model passed sandbox validation.');
    }
  }

  private async validateCandidate(
    candidate: WorldModelCandidate,
    signal: AbortSignal,
  ): Promise<void> {
    const observation = {
      objective: this.currentObjective(),
      structureHash: this.structure.snapshot()?.hash,
      evidenceHead: this.ledger.head().recordHash,
      conflicts: this.signals.conflicts('open'),
    };
    const encoded = await this.worldModels.invoke(
      candidate.manifest.candidateId,
      'encodeObservation',
      [observation, { seed: candidate.manifest.sourceHash }],
      { signal, timeoutMs: 10_000 },
    );
    const actions = await this.worldModels.invoke<unknown[]>(
      candidate.manifest.candidateId,
      'enumerateActions',
      [encoded, { seed: candidate.manifest.sourceHash }],
      { signal, timeoutMs: 10_000 },
    );
    if (!Array.isArray(actions)) {
      await this.worldModels.setStatus(
        candidate.manifest.candidateId,
        'rejected',
        'enumerateActions did not return an array.',
      );
      throw new Error('World model enumerateActions did not return an array.');
    }
    await this.worldModels.setStatus(candidate.manifest.candidateId, 'history-consistent');
    await this.worldModels.setStatus(candidate.manifest.candidateId, 'planning-eligible');
  }

  private async planUntilExternalAction(signal: AbortSignal): Promise<void> {
    this.runtime.transition('planning', 'Selecting the next evaluation or task action.');
    let nodeId = await this.search.begin(this.searchState());
    for (let index = 0; index < MAX_INTERNAL_ACTIONS_PER_STEP; index += 1) {
      signal.throwIfAborted();
      await this.search.addActions(nodeId, await this.generateActions(signal));
      const selection = await this.search.select(nodeId);
      this.state = {
        ...this.state,
        lastSelection: {
          actionId: selection.action.actionId,
          kind: selection.action.kind,
          description: selection.action.description,
          nodeId: selection.nodeId,
        },
      };
      switch (selection.action.kind) {
        case 'inspect-structure':
          nodeId = (await this.observeInternal(selection, 'inspected', 0.1)) ?? nodeId;
          continue;
        case 'run-evaluation':
        case 'run-replicate':
        case 'evaluate-task-patch':
          nodeId = (await this.executeEvaluation(selection, signal)) ?? nodeId;
          continue;
        case 'revise-world-model':
        case 'expand-world-model-population':
          this.runtime.transition('modeling', selection.action.description);
          await this.ensureWorldModelPopulation(signal, true);
          nodeId =
            (await this.observeInternal(selection, 'population-expanded', 0.15)) ??
            nodeId;
          this.runtime.transition('planning', 'World-model population updated.');
          continue;
        case 'construct-intervention':
        case 'simulate-task-action':
          nodeId = (await this.observeInternal(selection, 'simulated', 0.05)) ?? nodeId;
          continue;
        case 'propose-task-patch':
        case 'execute-task-action':
          this.runtime.transition('acting', selection.action.description);
          this.directive.set(selection.action.description);
          return;
        case 'commit-solution':
          this.runtime.transition('committing', 'Preparing the verified final response.');
          this.directive.set(selection.action.description);
          return;
      }
    }
    this.runtime.transition(
      'acting',
      'Internal search budget reached; perform the highest-value reversible task action.',
    );
    this.directive.set(
      'Perform the highest-value reversible task action selected by the current evidence. Do not claim completion without verification.',
    );
  }

  private async generateActions(signal: AbortSignal): Promise<readonly SearchAction[]> {
    const actions: SearchAction[] = [];
    for (const conflict of this.signals.conflicts('open').slice(0, 8)) {
      actions.push(await this.evaluationActionForConflict(conflict, signal));
    }
    if (this.worldModels.activeCandidates().length < 3) {
      actions.push(
        baseAction({
          actionId: 'expand-world-model-population',
          kind: 'expand-world-model-population',
          description:
            'Generate additional executable causal models because the active epistemic ensemble is too small.',
          payload: { reason: 'minimum-ensemble-size' },
          prior: 0.5,
          expectedTaskValue: 0.1,
          expectedProgress: 0.15,
          decisionSensitivity: 0.8,
          generalizationLeverage: 0.7,
        }),
      );
    }
    actions.push(
      await this.withPredictions(
        baseAction({
          actionId: 'execute-best-task-action',
          kind: 'execute-task-action',
          description:
            'Advance the user task with the highest-value code action supported by the current causal rules. Trace cross-file effects and use ordinary KC permissions.',
          payload: { objective: this.currentObjective() },
          prior: 0.8,
          expectedTaskValue: 0.5,
          expectedProgress: 0.6,
          decisionSensitivity: 0.9,
          generalizationLeverage: 0.7,
        }),
        signal,
      ),
    );
    actions.push(
      await this.withPredictions(
        baseAction({
          actionId: 'commit-verified-solution',
          kind: 'commit-solution',
          description:
            'Return only the completed change, decisive verification, and unresolved material risk. Do not include investigation history.',
          payload: { verifiedCandidates: this.state.verifiedCandidates },
          prior: this.state.verifiedCandidates > 0 ? 0.7 : 0.05,
          expectedTaskValue: this.state.verifiedCandidates > 0 ? 0.8 : -0.5,
          expectedProgress: 0,
          decisionSensitivity: 1,
          generalizationLeverage: 0,
        }),
        signal,
      ),
    );
    return actions;
  }

  private async evaluationActionForConflict(
    conflict: StructuralConflict,
    signal: AbortSignal,
  ): Promise<SearchAction> {
    return this.withPredictions(
      baseAction({
        actionId: `evaluate-conflict:${conflict.conflictId}`,
        kind: 'run-evaluation',
        description: `Resolve ${conflict.kind}: ${conflict.message}`,
        payload: {
          evaluatorId: 'sandbox.command',
          command: commandForConflict(conflict),
          conflictId: conflict.conflictId,
        },
        prior: conflict.severity === 'commit-blocking' ? 1 : 0.7,
        expectedTaskValue:
          conflict.severity === 'commit-blocking' ? 0.5 : 0.25,
        expectedProgress: 0.2,
        decisionSensitivity:
          conflict.severity === 'commit-blocking' ? 1 : 0.7,
        generalizationLeverage:
          conflict.kind === 'persistence-conflict' ||
          conflict.kind === 'event-order-conflict'
            ? 1
            : 0.7,
        hardGate: conflict.severity === 'commit-blocking',
      }),
      signal,
    );
  }

  private async withPredictions(
    action: SearchAction,
    signal: AbortSignal,
  ): Promise<SearchAction> {
    const beliefs = new Map(
      this.worldModels
        .beliefState()
        .beliefs.map((belief) => [belief.candidateId, belief.normalizedWeight]),
    );
    const predictions: SearchOutcomePrediction[] = [];
    for (const candidate of this.worldModels.activeCandidates()) {
      try {
        const state = await this.worldModels.invoke(
          candidate.manifest.candidateId,
          'encodeObservation',
          [
            {
              objective: this.currentObjective(),
              structureHash: this.structure.snapshot()?.hash,
              conflicts: this.signals.conflicts('open'),
            },
            { seed: action.actionId },
          ],
          { signal, timeoutMs: 5_000, seed: action.actionId },
        );
        const predicted = await this.worldModels.invoke<{
          readonly outcomes?: readonly {
            readonly probability?: number;
            readonly value?: unknown;
            readonly nextState?: unknown;
          }[];
        }>(
          candidate.manifest.candidateId,
          'predictTransition',
          [state, { type: action.kind, payload: action.payload }, { seed: action.actionId }],
          { signal, timeoutMs: 5_000, seed: action.actionId },
        );
        const distribution: Record<string, number> = {};
        for (const outcome of predicted?.outcomes ?? []) {
          const key = hashValue(outcome.value ?? outcome.nextState ?? outcome);
          distribution[key] =
            (distribution[key] ?? 0) + Math.max(0, outcome.probability ?? 0);
        }
        if (Object.keys(distribution).length === 0) distribution['unknown'] = 1;
        predictions.push({
          candidateId: candidate.manifest.candidateId,
          modelWeight: beliefs.get(candidate.manifest.candidateId) ?? 0,
          distribution,
        });
      } catch (error) {
        await this.worldModels.setStatus(
          candidate.manifest.candidateId,
          'quarantined',
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    return { ...action, predictions };
  }

  private async executeEvaluation(
    selection: SearchSelection,
    signal: AbortSignal,
  ): Promise<ReturnType<IAgentTestTimeSearchService['observe']> extends Promise<infer T> ? T : never> {
    const payload = selection.action.payload as {
      readonly evaluatorId?: string;
      readonly command?: readonly string[];
      readonly conflictId?: ConflictId;
    };
    const evaluatorId = payload.evaluatorId ?? 'sandbox.command';
    if (!this.evaluators.list().some((definition) => definition.evaluatorId === evaluatorId)) {
      return this.observeInternal(selection, 'evaluator-unavailable', -0.25);
    }
    this.runtime.transition('evaluating', selection.action.description);
    const baseline =
      this.workspaces.baseline() ?? (await this.workspaces.captureBaseline(signal));
    const candidateId = hashText(`${selection.decisionId}:${baseline.hash}`) as CandidateId;
    const workspace = await this.workspaces.materialize(candidateId, '', signal);
    try {
      const result = await this.runSandboxEvaluation(
        evaluatorId,
        workspace.path,
        payload.command ?? ['pnpm', 'typecheck'],
        await this.dependencyMounts(baseline.root),
        ['adaptive', 'conflict-resolution'],
        signal,
      );
      const passed = result.status === 'passed';
      await this.recordEvaluationMemory(result, selection.action.description);
      this.state = {
        ...this.state,
        evaluationsCompleted: this.state.evaluationsCompleted + 1,
        verifiedCandidates:
          this.state.verifiedCandidates +
          (passed && selection.action.hardGate === true ? 1 : 0),
      };
      this.runtime.update({
        evaluationsCompleted: this.state.evaluationsCompleted,
        verifiedCandidates: this.state.verifiedCandidates,
      });
      await this.signals.enqueue('evaluation', {
        kind: 'evaluation-result',
        evaluationId: result.evaluationId,
        evaluatorId: result.evaluatorId,
        status: result.status,
      });
      if (passed && payload.conflictId !== undefined) {
        await this.signals.resolve(payload.conflictId);
      }
      this.runtime.transition('planning', 'Evaluation evidence committed.');
      return this.search.observe(
        selection,
        passed ? 'passed' : result.status,
        passed ? 0.4 : -0.5,
        this.searchState(),
      );
    } finally {
      await this.workspaces.cleanup(candidateId);
    }
  }

  private async verifyCurrentWorkspace(signal: AbortSignal): Promise<void> {
    if (!this.evaluators.list().some((definition) => definition.evaluatorId === 'sandbox.command')) {
      return;
    }
    const baseline =
      this.workspaces.baseline() ?? (await this.workspaces.captureBaseline(signal));
    const candidateId = hashText(`verify:${baseline.hash}`) as CandidateId;
    const workspace = await this.workspaces.materialize(candidateId, '', signal);
    this.runtime.transition('evaluating', 'Running the current workspace hard gates.');
    try {
      const result = await this.runSandboxEvaluation(
        'sandbox.command',
        workspace.path,
        ['pnpm', 'typecheck'],
        await this.dependencyMounts(baseline.root),
        ['adaptive', 'hard-gate', 'current-workspace'],
        signal,
      );
      await this.recordEvaluationMemory(
        result,
        'Verify the current workspace with the repository typecheck.',
      );
      const passed = result.status === 'passed';
      this.state = {
        ...this.state,
        evaluationsCompleted: this.state.evaluationsCompleted + 1,
        verifiedCandidates: passed ? Math.max(1, this.state.verifiedCandidates) : 0,
      };
      this.runtime.update({
        evaluationsCompleted: this.state.evaluationsCompleted,
        verifiedCandidates: this.state.verifiedCandidates,
      });
    } finally {
      await this.workspaces.cleanup(candidateId);
      this.runtime.transition('planning', 'Current workspace verification completed.');
    }
  }

  private runSandboxEvaluation(
    evaluatorId: string,
    workspacePath: string,
    command: readonly string[],
    mounts: readonly SandboxMount[],
    tags: readonly string[],
    signal: AbortSignal,
  ): Promise<EvaluationResult> {
    return this.evaluation.evaluate(
      {
        protocol: EVALUATION_SPEC_PROTOCOL,
        evaluationId: createEvaluationId(),
        adaptiveRunId: this.runtime.runId(),
        evaluatorId,
        input: {
          workspacePath,
          args: command,
          capabilities: [
            'workspace-read',
            'workspace-write',
            'temporary-write',
            'package-cache-read',
            'process-spawn',
            'additional-read-mount',
          ],
          mounts,
          limits: DEFAULT_SANDBOX_LIMITS,
          expectedExitCodes: [0],
        },
        budget: { timeoutMs: DEFAULT_SANDBOX_LIMITS.wallMs },
        tags,
      },
      signal,
    );
  }

  private async recordEvaluationMemory(
    result: EvaluationResult,
    purpose: string,
  ): Promise<void> {
    const evidenceId = createEvidenceId();
    await this.ledger.append({
      recordType: 'evaluation.completed',
      adaptiveRunId: this.runtime.runId(),
      evidenceId,
      payload: {
        evaluationId: result.evaluationId,
        evaluatorId: result.evaluatorId,
        status: result.status,
        resultHash: result.resultHash,
        purpose,
        memoryIndex: true,
      },
    });
    await this.memory.saveSummary({
      kind: result.status === 'passed' ? 'verified-progress' : 'failure',
      goalVersion: this.state.goalVersion,
      structureHash: this.structure.snapshot()?.hash ?? 'unindexed',
      claims: [
        {
          text: `${purpose} Result: ${result.status}.`,
          evidenceRefs: [evidenceId],
        },
      ],
      exactDiagnostics: result.assertions
        .flatMap((assertion) => (assertion.message === undefined ? [] : [assertion.message])),
      decisiveCounterexampleRefs:
        result.status === 'failed' ? ([evidenceId] as readonly EvidenceId[]) : [],
      artifactRefs: result.artifactRefs.map((artifact) => artifact.artifactId),
    });
  }

  private observeInternal(
    selection: SearchSelection,
    outcomeKey: string,
    value: number,
  ) {
    return this.search.observe(selection, outcomeKey, value, this.searchState());
  }

  private searchState(): SearchState {
    return {
      workspaceSnapshotHash: this.workspaces.baseline()?.hash ?? 'uncaptured',
      beliefStateHash: hashValue(this.worldModels.beliefState()),
      causalRuleGraphHash: this.rules.snapshot().hash,
      structureIndexHash: this.structure.snapshot()?.hash ?? 'unindexed',
      unresolvedConflictHash: hashValue(this.signals.conflicts('open')),
      trajectorySummaryHash: hashValue(this.memorySummary()),
      verifiedCandidateIds:
        this.state.verifiedCandidates > 0 ? ['current-workspace'] : [],
      remainingBudget: DEFAULT_ADAPTIVE_BUDGET,
      goalVersion: this.state.goalVersion,
    };
  }

  private currentObjective(): string {
    const combined = [this.memorySummary(), this.contextSummary()]
      .filter((value) => value.length > 0)
      .join('\n');
    return combined.length === 0
      ? 'Complete the current coding task with verified repository-wide correctness.'
      : combined.slice(-16_000);
  }

  private contextSummary(): string {
    return canonicalJson(this.context.get().slice(-24)).slice(-32_000);
  }

  private memorySummary(): string {
    return canonicalJson(
      this.memory.summaries().slice(0, 24).map((summary) => ({
        kind: summary.kind,
        claims: summary.claims,
        trajectory: summary.trajectory,
        exactDiagnostics: summary.exactDiagnostics,
        decisiveCounterexampleRefs: summary.decisiveCounterexampleRefs,
      })),
    ).slice(-32_000);
  }

  private structureSummary(): unknown {
    const snapshot = this.structure.snapshot();
    return snapshot === undefined
      ? undefined
      : {
          hash: snapshot.hash,
          nodeCount: snapshot.nodes.length,
          edgeCount: snapshot.edges.length,
          parseErrors: snapshot.parseErrors,
          importantNodes: snapshot.nodes
            .filter((node) =>
              [
                'package',
                'interface',
                'service-registration',
                'wire-model',
                'wire-operation',
                'event-type',
                'generated-artifact',
              ].includes(node.kind),
            )
            .slice(0, 512),
        };
  }

  private async dependencyMounts(root: string): Promise<readonly SandboxMount[]> {
    const nodeModules = `${root}/node_modules`;
    try {
      if (!(await lstat(nodeModules)).isDirectory()) return [];
      return [{ source: nodeModules, target: '/workspace/node_modules', writable: false }];
    } catch {
      return [];
    }
  }
}

function baseAction(
  input: Pick<
    SearchAction,
    | 'actionId'
    | 'kind'
    | 'description'
    | 'payload'
    | 'prior'
    | 'expectedTaskValue'
    | 'expectedProgress'
    | 'generalizationLeverage'
    | 'decisionSensitivity'
  > &
    Partial<SearchAction>,
): SearchAction {
  return {
    wallCost: 0.1,
    tokenCost: 0.1,
    toolCost: 0.1,
    executionRisk: 0.05,
    redundancyPenalty: 0,
    calibrationFactor: 1,
    ...input,
  };
}

function commandForConflict(conflict: StructuralConflict): readonly string[] {
  switch (conflict.kind) {
    case 'manifest-conflict':
      return [
        'sh',
        '-lc',
        'pnpm --filter @moonshot-ai/agent-core-v2 gen:config-manifest && pnpm --filter @moonshot-ai/agent-core-v2 gen:wire-manifest && pnpm --filter @moonshot-ai/agent-core-v2 gen:state-manifest && git diff --exit-code',
      ];
    case 'persistence-conflict':
    case 'event-order-conflict':
    case 'coverage-conflict':
      return ['pnpm', 'test'];
    case 'public-contract-conflict':
    case 'scope-conflict':
    case 'candidate-conflict':
    case 'prediction-conflict':
    case 'evidence-conflict':
    case 'stale-evidence-conflict':
    case 'signal-overflow':
      return ['pnpm', 'typecheck'];
  }
}

function isTerminalPhase(
  phase: ReturnType<IAgentAdaptiveRuntimeService['phase']>,
): boolean {
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

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function hashValue(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, current: unknown) => {
    if (current !== null && typeof current === 'object' && !Array.isArray(current)) {
      const source = current as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(source)
          .sort()
          .filter((key) => source[key] !== undefined)
          .map((key) => [key, source[key]]),
      );
    }
    return current;
  });
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentAdaptiveCoordinatorService,
  AgentAdaptiveCoordinatorService,
  ScopeActivation.OnScopeCreated,
  'adaptiveCoordinator',
);
