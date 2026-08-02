import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'pathe';

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
import {
  IWorldModelCalibrationService,
  type CalibrationObservationEnvelope,
} from '#/agent/worldModel/worldModelCalibration';
import { IAgentWorldModelService, type WorldModelCandidate } from '#/agent/worldModel/worldModel';
import {
  EVALUATION_SPEC_PROTOCOL,
  createEvaluationId,
  createEvidenceId,
  type AdaptiveBudget,
  type ConflictId,
  type EvidenceId,
} from './adaptiveProtocol';
import {
  ISessionAdaptiveConfigService,
  type AdaptiveConfigSnapshot,
} from './adaptiveConfigService';
import {
  IAgentAdaptiveCoordinatorImplementation,
  type IAgentAdaptiveCoordinatorService,
  type AdaptiveObserveStepContext,
  type AdaptiveObserveStepDecision,
  type AdaptivePrepareStepContext,
} from './adaptiveCoordinator';
import { IAgentAdaptiveRuntimeService } from './adaptiveRuntime';
import {
  ISessionCandidateWorkspaceService,
  type BaselineSnapshot,
} from '#/session/candidateWorkspace/candidateWorkspace';
import {
  ISessionCodeStructureService,
  type CodeStructureSnapshot,
} from '#/session/codeStructure/codeStructure';
import {
  ISessionEvaluationRegistry,
  ISessionEvaluationService,
  type EvaluationResult,
  type EvaluationSpec,
} from '#/session/evaluation/evaluation';
import type { EvaluationCacheIdentity } from '#/session/evaluation/evaluationCache';
import { createEvaluationSpecHash } from '#/session/evaluation/evaluationIdentity';
import { createEvaluationEnvironmentManifest } from '#/session/evaluation/environmentManifest';
import type { SandboxCommandEvaluationInput } from '#/session/evaluation/sandboxCommandEvaluatorService';
import { ISessionEvaluationSandbox, type SandboxLimits } from '#/session/evaluationSandbox/evaluationSandbox';
import { ISessionEvaluationLedgerService } from '#/session/evaluationLedger/evaluationLedger';
import {
  ISessionStructuralSignalsService,
  type StructuralConflict,
} from '#/session/structuralSignals/structuralSignals';
import { IAgentWorldModelEvolutionService } from '#/session/worldModelEvolution/worldModelEvolution';

const VERIFY_EVALUATOR_ID = 'sandbox.command';
const PACKAGE_SCRIPT_PRIORITY = ['typecheck', 'check', 'lint', 'test', 'build'] as const;

interface VerificationPlan {
  readonly id: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly hardGate: boolean;
  readonly description: string;
}

interface EvaluationActionPayload {
  readonly evaluatorId: string;
  readonly verificationPlan?: VerificationPlan;
  readonly conflictId?: ConflictId;
  readonly inputEvidenceRefs?: readonly EvidenceId[];
}

interface AdaptiveCoordinatorState {
  readonly initialized: boolean;
  readonly runRecorded: boolean;
  readonly continuationCount: number;
  readonly evaluationsCompleted: number;
  readonly verifiedEvaluations: number;
  readonly goalVersion: number;
  readonly requiredHardGates: readonly string[];
  readonly passedHardGates: readonly string[];
  readonly failedHardGates: readonly string[];
  readonly lastActionEvidenceId?: EvidenceId;
  readonly wallMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
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
    verifiedEvaluations: 0,
    goalVersion: 1,
    requiredHardGates: [],
    passedHardGates: [],
    failedHardGates: [],
    wallMs: 0,
    inputTokens: 0,
    outputTokens: 0,
  }),
);

export class AgentAdaptiveCoordinatorService
  extends Disposable
  implements IAgentAdaptiveCoordinatorService
{
  declare readonly _serviceBrand: undefined;
  private readonly config: AdaptiveConfigSnapshot;

  constructor(
    @IAgentAdaptiveRuntimeService private readonly runtime: IAgentAdaptiveRuntimeService,
    @ISessionAdaptiveConfigService adaptiveConfig: ISessionAdaptiveConfigService,
    @IAgentAdaptiveDirectiveService private readonly directive: IAgentAdaptiveDirectiveService,
    @IAgentAdaptiveMemoryService private readonly memory: IAgentAdaptiveMemoryService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentStateService private readonly states: IAgentStateService,
    @IAgentCausalRuleGraphService private readonly rules: IAgentCausalRuleGraphService,
    @IAgentWorldModelService private readonly worldModels: IAgentWorldModelService,
    @IWorldModelCalibrationService private readonly calibration: IWorldModelCalibrationService,
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
    this.config = adaptiveConfig.snapshot();
    states.register(adaptiveCoordinatorStateKey);
  }

  async prepareStep(step: AdaptivePrepareStepContext): Promise<void> {
    if (!this.runtime.enabled()) return;
    step.signal.throwIfAborted();
    const runId = this.runtime.ensureRun();
    if (runId === undefined) return;
    await this.ready();
    if (!this.state.runRecorded) {
      await this.ledger.append({
        recordType: 'adaptive.run.started',
        adaptiveRunId: runId,
        payload: {
          architecture: 'evolve-architecture/1',
          configHash: this.config.hash,
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

  async observeStep(step: AdaptiveObserveStepContext): Promise<AdaptiveObserveStepDecision> {
    if (!this.runtime.enabled()) return { stopTurn: false, continueTurn: false };
    if (isTerminalPhase(this.runtime.phase())) return { stopTurn: true, continueTurn: false };
    await this.ready();

    const finalResponseStep = this.runtime.phase() === 'committing';
    if (!finalResponseStep) {
      this.runtime.transition('reconciling', 'Reconciling the observed task action with causal models.');
    }
    const previous = this.workspaces.baseline();
    const reconciliation = previous === undefined
      ? undefined
      : await this.workspaces.reconcileLive('', step.signal);
    const baseline = await this.workspaces.captureBaseline(step.signal);
    const structure = await this.structure.rebuild(step.signal);
    await this.memory.invalidateForStructure(structure.hash, 'Repository structure changed after a real task action.');

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
        previousBaselineHash: previous?.hash,
        baselineHash: baseline.hash,
        reconciliation,
        finalResponseStep,
      },
    });
    this.state = { ...this.state, lastActionEvidenceId: actionEvidenceId };
    if (!finalResponseStep && reconciliation?.unchanged === false) {
      this.state = { ...this.state, passedHardGates: [], failedHardGates: [] };
    }
    await this.memory.saveSummary({
      kind: 'trajectory',
      goalVersion: this.state.goalVersion,
      structureHash: structure.hash,
      claims: [{
        text: `The real step ended with finish reason ${step.finishReason}.`,
        evidenceRefs: [actionEvidenceId],
      }],
      trajectory: {
        attemptedCause: this.state.lastSelection?.description ?? 'Advance the current task using the highest-value supported action.',
        selectedEvaluation: 'Observe the real KC step and reconcile its direct result.',
        observedOutcome: `Finish reason: ${step.finishReason}.`,
        rulesSupported: [],
        rulesRejected: [],
        unresolvedConflicts: this.signals.conflicts('open').map((conflict) => conflict.conflictId),
        usefulArtifactRefs: [],
        verifiedProgress: this.gateProgress(),
        remainingDecision: finalResponseStep
          ? 'Verify the final response against committed evidence.'
          : 'Run every affected repository hard gate.',
      },
    });
    if (!finalResponseStep && step.finishReason !== 'tool_calls') {
      await this.verifyCurrentWorkspace(step.signal, actionEvidenceId);
    }

    const assessment = this.search.assessCommit({
      hardGatesPass: this.hardGatesPass(),
      commitBlockingConflicts: this.signals.conflicts('open').filter((conflict) => conflict.severity === 'commit-blocking').length,
      actionStableAcrossModels:
        this.worldModels.activeCandidates().length <= 1 ||
        (this.runtime.status()?.normalizedPosteriorEntropy ?? 1) <= 0.25,
      expectedAdditionalInformationValue: this.runtime.status()?.decisionWeightedUncertainty ?? 0,
      expectedAdditionalCost: this.nextEvaluationCostEstimate(),
      liveWorkspaceReconciled: reconciliation === undefined || reconciliation.conflictedPaths.length === 0,
      claimsSupported: this.hardGatesPass(),
    });

    if (finalResponseStep) {
      if (!assessment.eligible) {
        this.runtime.fail('commit-rejected', assessment.reasons.join('; ') || 'Final commit gates did not pass.');
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
          passedHardGates: this.state.passedHardGates,
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
      this.directive.set('Return only the completed change, decisive verification, and unresolved material risk. Omit investigation history and unsupported claims.');
      return { stopTurn: false, continueTurn: true };
    }
    if (this.state.continuationCount >= this.maximumContinuations()) {
      this.runtime.fail('budget-exhausted', 'Adaptive continuation budget exhausted.');
      this.directive.set(undefined);
      await this.flush();
      return { stopTurn: true, continueTurn: false };
    }
    this.runtime.transition('planning', 'Further evidence or task progress is required.');
    this.state = { ...this.state, continuationCount: this.state.continuationCount + 1 };
    return { stopTurn: false, continueTurn: true };
  }

  async flush(): Promise<void> {
    await Promise.all([
      this.memory.flush(),
      this.search.flush(),
      this.worldModels.flush(),
      this.calibration.flush(),
      this.rules.flush(),
      this.signals.flush(),
      this.workspaces.flush(),
      this.evaluation.flush(),
      this.ledger.flush(),
    ]);
  }

  private async ready(): Promise<void> {
    await Promise.all([
      this.ledger.ready(), this.sandbox.ready(), this.workspaces.ready(),
      this.structure.ready(), this.signals.ready(), this.rules.ready(),
      this.worldModels.ready(), this.calibration.ready(), this.search.ready(),
      this.memory.ready(),
    ]);
  }

  private get state(): AdaptiveCoordinatorState { return this.states.get(adaptiveCoordinatorStateKey); }
  private set state(value: AdaptiveCoordinatorState) { this.states.set(adaptiveCoordinatorStateKey, value); }

  private async initialize(signal: AbortSignal): Promise<void> {
    this.runtime.transition('indexing', 'Capturing workspace and building structural graph.');
    const baseline = this.workspaces.baseline() ?? await this.workspaces.captureBaseline(signal);
    await this.ledger.append({
      recordType: 'baseline.captured',
      adaptiveRunId: this.runtime.runId(),
      evidenceId: createEvidenceId(),
      payload: baseline,
    });
    const structure = this.structure.snapshot() ?? await this.structure.rebuild(signal);
    await this.refreshVerificationPlans(baseline);
    this.runtime.transition('discovering', 'Deriving repository-scale causal invariants.');
    await this.seedRepositoryRules(structure);
    this.runtime.transition('modeling', 'Constructing executable causal models.');
    await this.ensureWorldModelPopulation(signal, false);
  }

  private async seedRepositoryRules(structure: CodeStructureSnapshot): Promise<void> {
    if (this.rules.list().length > 0) return;
    const evidence = [`structure:${structure.hash}`];
    const propose = async (
      kinds: readonly string[],
      action: string,
      targets: readonly string[],
      scope: 'repository' | 'runtime' = 'repository',
    ) => {
      const subjectRefs = structure.nodes.filter((node) => kinds.includes(node.kind)).map((node) => node.id);
      if (subjectRefs.length === 0) return;
      await this.rules.propose({
        scope,
        condition: { expression: { anySubjectChanges: subjectRefs } },
        intervention: { action: { type: action } },
        predictedEffects: targets.map((target) => ({ target, operation: 'invalidate' as const })),
        subjectRefs,
        supportingEvidenceRefs: evidence,
      });
    };
    await propose(['interface', 'type', 'service-registration', 'tool-registration'], 'change-public-contract', ['implementations', 'callers', 'tests']);
    await propose(['configuration-section', 'persistence-schema', 'wire-model', 'wire-operation'], 'change-persisted-contract', ['restore', 'replay', 'export']);
    await propose(['event-type', 'event-publisher', 'event-subscriber'], 'change-event-contract', ['publishers', 'subscribers', 'event-order'], 'runtime');
    await propose(['generated-artifact'], 'change-generated-source', ['generated-artifacts']);
  }

  private async ensureWorldModelPopulation(signal: AbortSignal, forceAlternative: boolean): Promise<void> {
    const target = this.config.config.worldModel.minimumPopulation;
    let attempts = 0;
    while (
      this.worldModels.activeCandidates().length < target &&
      this.worldModels.list().length < this.config.config.worldModel.maximumPopulation &&
      attempts < 4
    ) {
      attempts += 1;
      const active = this.worldModels.activeCandidates();
      const rules = this.rules.snapshot();
      const result = await this.evolution.evolve({
        kind: active.length === 0 && !forceAlternative ? 'propose' : 'adversarial-alternative',
        objective: this.currentObjective(),
        observations: await this.compactObservations(),
        counterexamples: this.worldModels.list('rejected').map((candidate) => ({
          candidateId: candidate.manifest.candidateId,
          reason: candidate.rejectionReason,
        })),
        conflicts: this.signals.conflicts('open'),
        ruleIds: rules.rules.map((rule) => rule.ruleId),
        parentCandidateIds: active.map((candidate) => candidate.manifest.candidateId),
        parentCandidates: active,
        ruleGraphHash: rules.hash,
        stateSchemaHash: hashValue('adaptive-state/1'),
        actionSchemaHash: hashValue('adaptive-action/1'),
        observationSchemaHash: hashValue('adaptive-observation/1'),
        evidenceHead: this.ledger.head().recordHash ?? 'genesis',
        maximumCandidates: Math.min(
          this.config.config.evolution.maximumCandidatesPerRequest,
          this.config.config.worldModel.maximumPopulation - this.worldModels.list().length,
        ),
      }, signal);
      if (result.candidates.length === 0) break;
      for (const bundle of result.candidates) {
        try {
          const candidate = await this.worldModels.propose({
            source: bundle.source,
            ruleIds: bundle.ruleIds,
            parentCandidateIds: bundle.parentCandidateIds,
            ruleGraphHash: rules.hash,
            stateSchemaHash: hashValue('adaptive-state/1'),
            actionSchemaHash: hashValue('adaptive-action/1'),
            observationSchemaHash: hashValue('adaptive-observation/1'),
            deterministic: bundle.deterministic,
            supportedEvaluatorIds: bundle.supportedEvaluatorIds,
            evidenceHead: this.ledger.head().recordHash ?? 'genesis',
          });
          await this.validateWorldModelCandidate(candidate, signal);
        } catch (error) {
          await this.ledger.append({
            recordType: 'world_model.evaluated',
            adaptiveRunId: this.runtime.runId(),
            payload: {
              sourceHash: hashValue(bundle.source),
              status: 'rejected',
              error: error instanceof Error ? error.message : String(error),
            },
          });
        }
      }
      forceAlternative = true;
    }
    const active = this.worldModels.activeCandidates();
    this.runtime.update({ viableModels: active.length });
    if (active.length === 0) {
      this.runtime.fail('no-viable-model', 'No generated causal model passed executable validation.');
      throw new Error('No generated causal model passed executable validation.');
    }
  }

  private async validateWorldModelCandidate(candidate: WorldModelCandidate, signal: AbortSignal): Promise<void> {
    try {
      const encoded = await this.worldModels.invoke(
        candidate.manifest.candidateId,
        'encodeObservation',
        [{
          objective: this.currentObjective(),
          structureHash: this.structure.snapshot()?.hash,
          evidenceHead: this.ledger.head().recordHash,
          conflicts: this.signals.conflicts('open'),
        }, { seed: candidate.manifest.sourceHash }],
        { signal, timeoutMs: this.config.config.worldModel.wallMs, seed: candidate.manifest.sourceHash },
      );
      const actions = await this.worldModels.invoke<unknown[]>(
        candidate.manifest.candidateId,
        'enumerateActions',
        [encoded, { seed: candidate.manifest.sourceHash }],
        { signal, timeoutMs: this.config.config.worldModel.wallMs, seed: candidate.manifest.sourceHash },
      );
      if (!Array.isArray(actions)) throw new Error('enumerateActions did not return an array.');
      await this.worldModels.setStatus(candidate.manifest.candidateId, 'history-consistent');
      await this.worldModels.setStatus(candidate.manifest.candidateId, 'planning-eligible');
      await this.worldModels.setStatus(candidate.manifest.candidateId, 'active');
      await this.ledger.append({
        recordType: 'world_model.evaluated',
        adaptiveRunId: this.runtime.runId(),
        payload: { candidateId: candidate.manifest.candidateId, status: 'active', enumeratedActions: actions.length },
      });
    } catch (error) {
      await this.worldModels.setStatus(
        candidate.manifest.candidateId,
        'rejected',
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  private async planUntilExternalAction(signal: AbortSignal): Promise<void> {
    const maximum = Math.max(1, Math.min(32, this.remainingBudget().maxInternalRequests));
    for (let iteration = 0; iteration < maximum; iteration += 1) {
      signal.throwIfAborted();
      const root = await this.search.begin(this.buildSearchState());
      await this.search.addActions(root, await this.generateActions());
      const selection = await this.search.select(root);
      this.state = {
        ...this.state,
        lastSelection: {
          actionId: selection.action.actionId,
          kind: selection.action.kind,
          description: selection.action.description,
          nodeId: selection.nodeId,
        },
      };
      if (!await this.executeInternalAction(selection, signal)) {
        this.runtime.transition('acting', selection.action.description);
        this.directive.set(selection.action.description);
        return;
      }
    }
    this.runtime.fail('budget-exhausted', 'Internal adaptive action budget exhausted.');
    throw new Error('Adaptive internal action budget exhausted.');
  }

  private async generateActions(): Promise<readonly SearchAction[]> {
    const plans = (await this.verificationPlans()).filter(
      (plan) => !this.state.passedHardGates.includes(plan.id),
    );
    const actions: SearchAction[] = plans.map((plan) => this.verificationAction(plan));
    for (const conflict of this.signals.conflicts('open').slice(0, 4)) {
      const evaluatorId = firstRegisteredEvaluator(conflict.suggestedEvaluatorIds, this.evaluators);
      if (evaluatorId !== undefined) {
        actions.push(this.conflictEvaluationAction(conflict, evaluatorId, plans[0]));
      }
    }
    if (this.worldModels.activeCandidates().length < this.config.config.worldModel.minimumPopulation) {
      actions.push({
        actionId: 'expand-world-model-population',
        kind: 'expand-world-model-population',
        description: 'Generate an independent executable causal model before committing.',
        payload: {},
        prior: 0.9,
        expectedTaskValue: 0.25,
        expectedProgress: 0.4,
        generalizationLeverage: 1,
        decisionSensitivity: 0.9,
        calibrationFactor: 0.7,
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
      description: this.actionDirective(this.signals.conflicts('open')),
      payload: { evidenceRefs: this.state.lastActionEvidenceId === undefined ? [] : [this.state.lastActionEvidenceId] },
      prior: 0.85,
      expectedTaskValue: 0.9,
      expectedProgress: 0.9,
      generalizationLeverage: 0.6,
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

  private verificationAction(plan: VerificationPlan): SearchAction {
    return {
      actionId: `verify:${plan.id}`,
      kind: 'run-evaluation',
      description: plan.description,
      payload: {
        evaluatorId: VERIFY_EVALUATOR_ID,
        verificationPlan: plan,
        inputEvidenceRefs: this.state.lastActionEvidenceId === undefined ? [] : [this.state.lastActionEvidenceId],
      } satisfies EvaluationActionPayload,
      prior: plan.hardGate ? 1 : 0.65,
      expectedTaskValue: plan.hardGate ? 0.85 : 0.45,
      expectedProgress: 0.7,
      generalizationLeverage: 0.9,
      decisionSensitivity: plan.hardGate ? 1 : 0.7,
      calibrationFactor: 1,
      wallCost: this.config.config.sandbox.wallMs / 1_000,
      tokenCost: 0,
      toolCost: 1,
      executionRisk: 0.05,
      redundancyPenalty: 0,
      hardGate: plan.hardGate,
      predictions: this.predictionsForEvaluator(VERIFY_EVALUATOR_ID),
    };
  }

  private conflictEvaluationAction(
    conflict: StructuralConflict,
    evaluatorId: string,
    fallbackPlan: VerificationPlan | undefined,
  ): SearchAction {
    return {
      actionId: `conflict:${conflict.conflictId}:${evaluatorId}`,
      kind: 'run-evaluation',
      description: `Resolve ${conflict.kind} with evaluator ${evaluatorId}.`,
      payload: {
        evaluatorId,
        verificationPlan: evaluatorId === VERIFY_EVALUATOR_ID ? fallbackPlan : undefined,
        conflictId: conflict.conflictId,
        inputEvidenceRefs: this.state.lastActionEvidenceId === undefined ? [] : [this.state.lastActionEvidenceId],
      } satisfies EvaluationActionPayload,
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

  private predictionsForEvaluator(evaluatorId: string): readonly SearchOutcomePrediction[] | undefined {
    const candidates = this.worldModels.activeCandidates();
    if (candidates.length < 2) return undefined;
    const beliefs = this.worldModels.beliefState();
    return candidates.map((candidate, index) => ({
      candidateId: candidate.manifest.candidateId,
      modelWeight: beliefs.beliefs.find((belief) => belief.candidateId === candidate.manifest.candidateId)?.normalizedWeight ?? 1 / candidates.length,
      distribution: predictedEvaluationDistribution(candidate, evaluatorId, index),
      evaluatorFamily: evaluatorId,
      modelLineage: candidate.manifest.sourceHash,
      effectiveSampleSize: Math.max(1, beliefs.beliefs.length),
    }));
  }

  private predictionsForTaskAction(): readonly SearchOutcomePrediction[] | undefined {
    const candidates = this.worldModels.activeCandidates();
    if (candidates.length < 2) return undefined;
    const beliefs = this.worldModels.beliefState();
    return candidates.map((candidate, index) => ({
      candidateId: candidate.manifest.candidateId,
      modelWeight: beliefs.beliefs.find((belief) => belief.candidateId === candidate.manifest.candidateId)?.normalizedWeight ?? 1 / candidates.length,
      distribution: index % 2 === 0
        ? { progress: 0.7, no_progress: 0.2, regression: 0.1 }
        : { progress: 0.4, no_progress: 0.4, regression: 0.2 },
      evaluatorFamily: 'task-action',
      modelLineage: candidate.manifest.sourceHash,
      effectiveSampleSize: Math.max(1, beliefs.beliefs.length),
    }));
  }

  private async executeInternalAction(selection: SearchSelection, signal: AbortSignal): Promise<boolean> {
    switch (selection.action.kind) {
      case 'run-evaluation':
      case 'run-replicate':
      case 'evaluate-task-patch': {
        const payload = selection.action.payload as EvaluationActionPayload;
        const result = await this.evaluatePayload(payload, signal);
        await this.search.observe(
          selection,
          result.status,
          result.status === 'passed' ? 1 : result.status === 'inconclusive' ? -0.1 : -0.8,
          this.buildSearchState(),
        );
        this.runtime.transition('planning', `Evaluator ${payload.evaluatorId} completed with ${result.status}.`);
        return true;
      }
      case 'expand-world-model-population':
      case 'revise-world-model':
        this.runtime.transition('modeling', selection.action.description);
        await this.ensureWorldModelPopulation(signal, true);
        await this.search.observe(selection, 'population-expanded', 0.3, this.buildSearchState());
        this.runtime.transition('planning', 'World-model population updated.');
        return true;
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

  private async evaluatePayload(payload: EvaluationActionPayload, signal: AbortSignal): Promise<EvaluationResult> {
    const definition = this.evaluators.get(payload.evaluatorId);
    const baseline = this.workspaces.baseline() ?? await this.workspaces.captureBaseline(signal);
    const structure = this.structure.snapshot() ?? await this.structure.rebuild(signal);
    const input = this.evaluationInput(payload, baseline, structure);
    const seed = definition.mode === 'stochastic'
      ? `${payload.evaluatorId}:${String(this.state.evaluationsCompleted + 1)}`
      : undefined;
    const baseSpec: EvaluationSpec = {
      protocol: EVALUATION_SPEC_PROTOCOL,
      evaluationId: createEvaluationId(),
      adaptiveRunId: this.runtime.runId(),
      evaluatorId: payload.evaluatorId,
      evaluatorVersion: definition.version,
      input,
      inputEvidenceRefs: payload.inputEvidenceRefs ?? [],
      budget: {
        timeoutMs: this.config.config.evaluation.timeoutOverridesMs[payload.evaluatorId]
          ?? Math.min(definition.defaultTimeoutMs, this.config.config.sandbox.wallMs),
        maximumReplicates: definition.mode === 'stochastic'
          ? this.config.config.evaluation.maximumReplicates
          : 1,
        maximumOutputBytes: this.config.config.sandbox.outputBytes,
      },
      seed,
      tags: ['adaptive', payload.verificationPlan?.id ?? payload.conflictId ?? payload.evaluatorId],
    };
    const environment = createEvaluationEnvironmentManifest({
      baselineSnapshotHash: baseline.hash,
      candidatePatchHash: baseline.dirtyPatchHash ?? hashValue('clean-working-tree'),
      candidateWorkspaceHash: baseline.hash,
      operatingSystem: process.platform,
      architecture: process.arch,
      sandboxBackendId: this.sandbox.backend().id,
      nodeVersion: process.version,
      dependencyStateHash: await dependencyStateHash(baseline.root),
      evaluatorId: definition.evaluatorId,
      evaluatorVersion: definition.version,
      configurationHash: this.config.hash,
      permittedEnvironment: { CI: '1', NO_COLOR: '1' },
    });
    const identity: EvaluationCacheIdentity = {
      evaluatorId: definition.evaluatorId,
      evaluatorVersion: definition.version,
      evaluationSpecHash: createEvaluationSpecHash(baseSpec, definition.version),
      baselineSnapshotHash: environment.baselineSnapshotHash,
      candidatePatchHash: environment.candidatePatchHash,
      environmentManifestHash: environment.environmentHash,
      dependencyStateHash: environment.dependencyStateHash,
    };
    const spec: EvaluationSpec = { ...baseSpec, cache: { identity, environment } };

    this.runtime.transition('evaluating', `Running ${payload.evaluatorId}.`);
    this.runtime.update({ evaluationsActive: 1 });
    const result = await this.evaluation.evaluate(spec, signal);
    if (result.evidenceId === undefined) {
      throw new Error(`Evaluator ${payload.evaluatorId} returned no evidence identity.`);
    }
    await this.recordCalibration(payload.evaluatorId, result);
    await this.updateWorldModelBeliefs(payload.evaluatorId, result, result.evidenceId);
    if (result.status === 'passed' && payload.conflictId !== undefined) {
      await this.signals.resolve(payload.conflictId);
    }
    this.updateGateState(payload.verificationPlan, result.status);
    const success = result.status === 'passed';
    this.state = {
      ...this.state,
      evaluationsCompleted: this.state.evaluationsCompleted + 1,
      verifiedEvaluations: this.state.verifiedEvaluations + (success ? 1 : 0),
      wallMs: this.state.wallMs + result.cost.wallMs,
      inputTokens: this.state.inputTokens + (result.cost.inputTokens ?? 0),
      outputTokens: this.state.outputTokens + (result.cost.outputTokens ?? 0),
    };
    this.runtime.update({
      evaluationsActive: 0,
      evaluationsCompleted: this.state.evaluationsCompleted,
      verifiedCandidates: this.state.verifiedEvaluations,
      openConflicts: this.signals.conflicts('open').length,
      viableModels: this.worldModels.activeCandidates().length,
      cost: {
        evaluations: this.state.evaluationsCompleted,
        wallMs: this.state.wallMs,
        inputTokens: this.state.inputTokens,
        outputTokens: this.state.outputTokens,
      },
    });
    await this.memory.saveSummary({
      kind: success ? 'verified-progress' : 'failure',
      goalVersion: this.state.goalVersion,
      structureHash: structure.hash,
      claims: [{
        text: success
          ? `Evaluator ${payload.evaluatorId} passed${payload.verificationPlan === undefined ? '' : ` gate ${payload.verificationPlan.id}`}.`
          : `Evaluator ${payload.evaluatorId} did not pass: ${result.status}.`,
        evidenceRefs: [result.evidenceId],
      }],
      exactDiagnostics: diagnosticsFrom(result),
      decisiveCounterexampleRefs: success ? [] : [result.evidenceId],
      artifactRefs: result.artifactRefs.map((artifact) => artifact.artifactId),
    });
    return result;
  }

  private evaluationInput(
    payload: EvaluationActionPayload,
    baseline: BaselineSnapshot,
    structure: CodeStructureSnapshot,
  ): unknown {
    if (payload.evaluatorId === VERIFY_EVALUATOR_ID) {
      const plan = payload.verificationPlan ?? {
        id: 'runtime-probe',
        args: ['node', '--version'],
        cwd: '.',
        hardGate: false,
        description: 'Verify the isolated runtime.',
      };
      return {
        workspacePath: baseline.root,
        args: plan.args,
        cwd: plan.cwd,
        env: { CI: '1', NO_COLOR: '1', ADAPTIVE_STRUCTURE_HASH: structure.hash },
        capabilities: ['workspace-read', 'workspace-write', 'temporary-write', 'package-cache-read', 'process-spawn'],
        limits: this.sandboxLimits(),
        expectedExitCodes: [0],
      } satisfies SandboxCommandEvaluationInput;
    }
    return { baselineHash: baseline.hash, structureHash: structure.hash, conflictId: payload.conflictId };
  }

  private async verifyCurrentWorkspace(signal: AbortSignal, evidenceId: EvidenceId): Promise<void> {
    for (const plan of await this.verificationPlans()) {
      if (!plan.hardGate || this.state.passedHardGates.includes(plan.id)) continue;
      if (this.state.evaluationsCompleted >= this.config.config.budget.maxEvaluations) break;
      await this.evaluatePayload({
        evaluatorId: VERIFY_EVALUATOR_ID,
        verificationPlan: plan,
        inputEvidenceRefs: [evidenceId],
      }, signal);
    }
  }

  private async recordCalibration(evaluatorId: string, result: EvaluationResult): Promise<void> {
    const predictions = this.predictionsForEvaluator(evaluatorId) ?? [];
    const observations: CalibrationObservationEnvelope[] = predictions.map((prediction, index) => ({
      evaluatorFamily: evaluatorId,
      modelLineage: prediction.modelLineage ?? String(prediction.candidateId),
      split: 'adaptation',
      sequence: this.ledger.head().sequence + index + 1,
      observation: {
        kind: 'categorical',
        probabilities: prediction.distribution,
        observedCategory: result.status,
      },
    }));
    if (observations.length > 0) await this.calibration.recordMany(observations);
  }

  private async updateWorldModelBeliefs(
    evaluatorId: string,
    result: EvaluationResult,
    evidenceId: EvidenceId,
  ): Promise<void> {
    const predictions = new Map(
      (this.predictionsForEvaluator(evaluatorId) ?? []).map((prediction) => [prediction.candidateId, prediction.distribution]),
    );
    for (const candidate of this.worldModels.activeCandidates()) {
      const distribution = predictions.get(candidate.manifest.candidateId)
        ?? { passed: 1 / 3, failed: 1 / 3, inconclusive: 1 / 3 };
      const probability = Math.max(1e-9, distribution[result.status] ?? 1e-9);
      await this.worldModels.updateLikelihood({
        candidateId: candidate.manifest.candidateId,
        evidenceRef: evidenceId,
        logLikelihood: Math.log(probability),
        deterministicContradiction: candidate.manifest.deterministic && probability <= 1e-9,
        supports: result.status === 'passed',
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
    const status = this.runtime.status();
    return {
      workspaceSnapshotHash: baseline?.hash ?? 'uncaptured',
      beliefStateHash: hashValue(beliefs),
      causalRuleGraphHash: this.rules.snapshot().hash,
      structureIndexHash: structure?.hash ?? 'unindexed',
      unresolvedConflictHash: hashValue(conflicts),
      trajectorySummaryHash: hashValue(this.memory.summaries({ goalVersion: this.state.goalVersion })),
      verifiedCandidateIds: this.worldModels.activeCandidates().map((candidate) => candidate.manifest.candidateId),
      remainingBudget: this.remainingBudget(),
      goalVersion: this.state.goalVersion,
      normalizedPosteriorEntropy: status?.normalizedPosteriorEntropy ?? 1,
      openConflictCount: conflicts.length,
      viableModelCount: this.worldModels.activeCandidates().length,
      taskFamily: 'repository-software-engineering',
      repositorySplit: 'development',
    };
  }

  private remainingBudget(): AdaptiveBudget {
    const budget = this.config.config.budget;
    return {
      maxInternalRequests: Math.max(0, budget.maxInternalRequests - this.state.continuationCount - this.state.evaluationsCompleted),
      maxEvaluations: Math.max(0, budget.maxEvaluations - this.state.evaluationsCompleted),
      maxStochasticReplicates: budget.maxStochasticReplicates,
      maxToolCalls: budget.maxToolCalls,
      maxInputTokens: Math.max(0, budget.maxInputTokens - this.state.inputTokens),
      maxOutputTokens: Math.max(0, budget.maxOutputTokens - this.state.outputTokens),
      maxWallMs: Math.max(0, budget.maxWallMs - this.state.wallMs),
      maxCpuMs: budget.maxCpuMs,
      maxDiskBytes: budget.maxDiskBytes,
      maxCandidates: Math.max(0, budget.maxCandidates - this.worldModels.list().length),
    };
  }

  private sandboxLimits(): SandboxLimits {
    const sandbox = this.config.config.sandbox;
    return {
      wallMs: sandbox.wallMs,
      cpuSeconds: sandbox.cpuSeconds,
      memoryBytes: sandbox.memoryBytes,
      processCount: sandbox.processCount,
      outputBytes: sandbox.outputBytes,
      writtenBytes: sandbox.writtenBytes,
    };
  }

  private maximumContinuations(): number {
    return Math.max(1, this.config.config.budget.maxInternalRequests);
  }

  private hardGatesPass(): boolean {
    if (this.state.requiredHardGates.length === 0) return this.state.verifiedEvaluations > 0;
    return this.state.failedHardGates.length === 0
      && this.state.requiredHardGates.every((gate) => this.state.passedHardGates.includes(gate));
  }

  private gateProgress(): string {
    if (this.state.requiredHardGates.length === 0) {
      return `${String(this.state.verifiedEvaluations)} verification result(s) pass.`;
    }
    return `${String(this.state.passedHardGates.length)} of ${String(this.state.requiredHardGates.length)} hard gates pass.`;
  }

  private updateGateState(plan: VerificationPlan | undefined, status: EvaluationResult['status']): void {
    if (plan === undefined || !plan.hardGate) return;
    const passed = new Set(this.state.passedHardGates);
    const failed = new Set(this.state.failedHardGates);
    if (status === 'passed') {
      passed.add(plan.id);
      failed.delete(plan.id);
    } else {
      passed.delete(plan.id);
      failed.add(plan.id);
    }
    this.state = { ...this.state, passedHardGates: [...passed].sort(), failedHardGates: [...failed].sort() };
  }

  private async refreshVerificationPlans(baseline: BaselineSnapshot): Promise<void> {
    const plans = await discoverVerificationPlans(baseline.root);
    this.state = {
      ...this.state,
      requiredHardGates: plans.filter((plan) => plan.hardGate).map((plan) => plan.id),
    };
  }

  private async verificationPlans(): Promise<readonly VerificationPlan[]> {
    const baseline = this.workspaces.baseline();
    if (baseline === undefined) return [];
    const plans = await discoverVerificationPlans(baseline.root);
    const required = plans.filter((plan) => plan.hardGate).map((plan) => plan.id);
    if (canonicalJson(required) !== canonicalJson(this.state.requiredHardGates)) {
      this.state = { ...this.state, requiredHardGates: required };
    }
    return plans;
  }

  private actionDirective(conflicts: readonly StructuralConflict[]): string {
    const open = conflicts.filter((conflict) => conflict.severity !== 'information').map((conflict) => conflict.message);
    return [
      this.currentObjective(),
      open.length > 0
        ? `Resolve these repository constraints while acting: ${open.join('; ')}`
        : 'Execute the next task action while preserving verified repository invariants.',
      'Trace affected definitions, callers, persistence, generated artifacts, events, tests, and runtime consumers.',
      'Use direct tool evidence. Do not claim verification before its evaluator result exists.',
    ].join('\n');
  }

  private currentObjective(): string {
    for (const message of [...this.context.get()].reverse()) {
      if (message.role !== 'user') continue;
      const text = message.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('').trim();
      if (text.length > 0) return text;
    }
    return 'Complete the current repository task with verified evidence.';
  }

  private async compactObservations(): Promise<readonly unknown[]> {
    const candidates: Array<{ evidenceId?: EvidenceId; recordType: string; payload: unknown }> = [];
    for await (const record of this.ledger.records()) {
      if (['evaluation.completed', 'counterexample.recorded', 'tool.result.recorded', 'task.action.executed'].includes(record.recordType)) {
        candidates.push({ evidenceId: record.evidenceId, recordType: record.recordType, payload: record.payload });
      }
    }
    const selection = this.memory.selectEvidence(
      candidates.map((candidate, index) => ({
        evidenceId: candidate.evidenceId ?? (`ledger:${String(index)}` as EvidenceId),
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
      this.config.config.memory.activeContextTokens,
    );
    return selection.selected.map((candidate) => ({ evidenceId: candidate.evidenceId, text: candidate.text }));
  }

  private nextEvaluationCostEstimate(): number {
    const wall = this.config.config.sandbox.wallMs / 1_000;
    return wall / (1 + wall);
  }
}

function predictedEvaluationDistribution(
  candidate: WorldModelCandidate,
  evaluatorId: string,
  index: number,
): Readonly<Record<string, number>> {
  if (candidate.manifest.supportedEvaluatorIds.includes(evaluatorId)) {
    return index % 2 === 0
      ? { passed: 0.8, failed: 0.15, inconclusive: 0.05 }
      : { passed: 0.55, failed: 0.35, inconclusive: 0.1 };
  }
  return index % 2 === 0
    ? { passed: 0.4, failed: 0.45, inconclusive: 0.15 }
    : { passed: 0.25, failed: 0.55, inconclusive: 0.2 };
}

function firstRegisteredEvaluator(
  suggested: readonly string[],
  registry: ISessionEvaluationRegistry,
): string | undefined {
  const available = new Set(registry.list().map((definition) => definition.evaluatorId));
  return suggested.find((candidate) => available.has(candidate));
}

function diagnosticsFrom(result: EvaluationResult): readonly string[] {
  return result.assertions.filter((assertion) => !assertion.passed).map((assertion) => assertion.message ?? assertion.assertionId);
}

function normalizedBeliefEntropy(weights: readonly number[]): number {
  const positive = weights.filter((weight) => Number.isFinite(weight) && weight > 0);
  if (positive.length <= 1) return 0;
  const total = positive.reduce((sum, weight) => sum + weight, 0);
  const entropy = -positive.reduce((sum, weight) => {
    const probability = weight / total;
    return sum + probability * Math.log(probability);
  }, 0);
  return entropy / Math.log(positive.length);
}

async function discoverVerificationPlans(root: string): Promise<readonly VerificationPlan[]> {
  let packageJson: { scripts?: Readonly<Record<string, string>>; packageManager?: string };
  try {
    packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as typeof packageJson;
  } catch {
    return [{
      id: 'runtime-probe',
      args: ['node', '--version'],
      cwd: '.',
      hardGate: false,
      description: 'Verify that the isolated runtime can execute Node.js.',
    }];
  }
  const scripts = packageJson.scripts ?? {};
  const manager = resolvePackageManager(packageJson.packageManager);
  const plans = PACKAGE_SCRIPT_PRIORITY
    .filter((script) => scripts[script] !== undefined)
    .map((script): VerificationPlan => ({
      id: script,
      args: packageScriptArgs(manager, script),
      cwd: '.',
      hardGate: true,
      description: `Run repository ${script} as an isolated hard gate.`,
    }));
  return plans.length > 0
    ? plans
    : [{
        id: 'runtime-probe',
        args: ['node', '--version'],
        cwd: '.',
        hardGate: false,
        description: 'Verify that the isolated runtime can execute Node.js.',
      }];
}

function resolvePackageManager(declared: string | undefined): 'pnpm' | 'npm' | 'yarn' {
  const name = declared?.split('@')[0];
  return name === 'npm' || name === 'yarn' || name === 'pnpm' ? name : 'pnpm';
}

function packageScriptArgs(manager: 'pnpm' | 'npm' | 'yarn', script: string): readonly string[] {
  return manager === 'yarn' ? ['yarn', script] : [manager, 'run', script];
}

async function dependencyStateHash(root: string): Promise<string> {
  const files = ['package.json', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock', 'bun.lockb'];
  const entries: Array<readonly [string, string]> = [];
  for (const file of files) {
    try {
      entries.push([file, createHash('sha256').update(await readFile(join(root, file))).digest('hex')]);
    } catch {
    }
  }
  return hashValue(entries);
}

function hashValue(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, current: unknown) => {
    if (current !== null && typeof current === 'object' && !Array.isArray(current) && !(current instanceof Uint8Array)) {
      const source = current as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(source).sort().filter((key) => source[key] !== undefined).map((key) => [key, source[key]]),
      );
    }
    return current;
  });
}

function isTerminalPhase(phase: string): boolean {
  return [
    'completed', 'blocked', 'cancelled', 'budget-exhausted',
    'infrastructure-failed', 'evidence-corrupted', 'no-viable-model', 'commit-rejected',
  ].includes(phase);
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentAdaptiveCoordinatorImplementation,
  AgentAdaptiveCoordinatorService,
  ScopeActivation.OnDemand,
  'adaptiveCoordinatorImplementation',
);
