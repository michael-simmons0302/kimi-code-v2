import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';

import { createDecorator } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/_base/state/stateRegistry';
import { IAgentAdaptiveDirectiveService } from '#/agent/adaptivePrompt/adaptiveDirectiveService';
import { IAgentCausalRuleGraphService } from '#/agent/causalRuleGraph/causalRuleGraph';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import {
  IAgentLoopService,
  type AfterStepContext,
  type BeforeStepContext,
} from '#/agent/loop/loop';
import { StepRequest } from '#/agent/loop/stepRequest';
import { IAgentStateService } from '#/agent/state/agentState';
import {
  IAgentTestTimeSearchService,
  type SearchAction,
  type SearchOutcomePrediction,
  type SearchSelection,
  type SearchState,
} from '#/agent/testTimeSearch/testTimeSearch';
import { IAgentWorldModelService, type WorldModelCandidate } from '#/agent/worldModel/worldModel';
import { DEFAULT_ADAPTIVE_BUDGET, createEvaluationId, type CandidateId } from './adaptiveProtocol';
import { IAgentAdaptiveRuntimeService } from './adaptiveRuntime';
import { ISessionCandidateWorkspaceService } from '#/session/candidateWorkspace/candidateWorkspace';
import { ISessionCodeStructureService } from '#/session/codeStructure/codeStructure';
import { ISessionEvaluationRegistry, ISessionEvaluationService } from '#/session/evaluation/evaluation';
import { DEFAULT_SANDBOX_LIMITS, ISessionEvaluationSandbox, type SandboxMount } from '#/session/evaluationSandbox/evaluationSandbox';
import { ISessionEvaluationLedgerService } from '#/session/evaluationLedger/evaluationLedger';
import { ISessionStructuralSignalsService, type StructuralConflict } from '#/session/structuralSignals/structuralSignals';
import { IAgentWorldModelEvolutionService } from '#/session/worldModelEvolution/worldModelEvolution';

const MAX_INTERNAL_ACTIONS_PER_STEP = 8;
const MAX_ADAPTIVE_CONTINUATIONS = 64;

interface AdaptiveCoordinatorState {
  readonly initialized: boolean;
  readonly runRecorded: boolean;
  readonly continuationCount: number;
  readonly evaluationsCompleted: number;
  readonly verifiedCandidates: number;
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
  }),
);

export interface IAgentAdaptiveCoordinatorService {
  readonly _serviceBrand: undefined;
}

export const IAgentAdaptiveCoordinatorService =
  createDecorator<IAgentAdaptiveCoordinatorService>('agentAdaptiveCoordinatorService');

export class AgentAdaptiveCoordinatorService
  extends Disposable
  implements IAgentAdaptiveCoordinatorService
{
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentAdaptiveRuntimeService private readonly runtime: IAgentAdaptiveRuntimeService,
    @IAgentAdaptiveDirectiveService private readonly directive: IAgentAdaptiveDirectiveService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentLoopService private readonly loop: IAgentLoopService,
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
    this._register(
      loop.hooks.onWillBeginStep.register(
        'adaptive-coordinator-before-step',
        async (step, next) => {
          if (runtime.enabled()) await this.prepareStep(step);
          await next();
        },
        { priority: 100 },
      ),
    );
    this._register(
      loop.hooks.onDidFinishStep.register(
        'adaptive-coordinator-after-step',
        async (step, next) => {
          if (runtime.enabled()) {
            try {
              await this.observeStep(step);
            } catch (error) {
              runtime.fail(
                'infrastructure-failed',
                error instanceof Error ? error.message : String(error),
              );
              directive.set(undefined);
              step.stopTurn = true;
            }
          }
          await next();
        },
        { priority: 100 },
      ),
    );
  }

  private get state(): AdaptiveCoordinatorState {
    return this.states.get(adaptiveCoordinatorStateKey);
  }

  private set state(value: AdaptiveCoordinatorState) {
    this.states.set(adaptiveCoordinatorStateKey, value);
  }

  private async prepareStep(step: BeforeStepContext): Promise<void> {
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
    ]);

    if (!this.state.runRecorded) {
      await this.ledger.append({
        recordType: 'adaptive.run.started',
        adaptiveRunId: runId,
        payload: {
          architecture: 'evolve-architecture/1',
          turnId: step.turnId,
          step: step.step,
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

  private async initialize(signal: AbortSignal): Promise<void> {
    this.runtime.transition('indexing', 'Capturing the workspace and building the structural graph.');
    const baseline = this.workspaces.baseline() ?? await this.workspaces.captureBaseline(signal);
    await this.ledger.append({ recordType: 'baseline.captured', payload: baseline });
    const structure = this.structure.snapshot() ?? await this.structure.rebuild(signal);
    this.runtime.transition('discovering', 'Deriving repository-scale causal invariants.');
    await this.seedRepositoryRules(structure.hash);
    this.runtime.transition('modeling', 'Constructing executable causal models.');
    await this.ensureWorldModelPopulation(signal);
  }

  private async seedRepositoryRules(structureHash: string): Promise<void> {
    if (this.rules.list().length > 0) return;
    const snapshot = this.structure.snapshot();
    const nodes = snapshot?.nodes ?? [];
    const evidence = [`structure:${structureHash}`];
    const publicSubjects = nodes
      .filter((node) => ['interface', 'type', 'service-registration', 'tool-registration'].includes(node.kind))
      .map((node) => node.id);
    const persistenceSubjects = nodes
      .filter((node) => ['wire-model', 'wire-operation', 'persistence-schema'].includes(node.kind))
      .map((node) => node.id);
    const eventSubjects = nodes
      .filter((node) => ['event-type', 'event-publisher', 'event-subscriber'].includes(node.kind))
      .map((node) => node.id);
    const generatedSubjects = nodes
      .filter((node) => node.kind === 'generated-artifact')
      .map((node) => node.id);

    await this.rules.propose({
      scope: 'repository',
      condition: { expression: { changedStructures: publicSubjects } },
      intervention: { action: { type: 'change-public-contract' } },
      predictedEffects: [
        { target: 'implementations', operation: 'invalidate' },
        { target: 'callers', operation: 'invalidate' },
        { target: 'tests', operation: 'invalidate' },
      ],
      subjectRefs: publicSubjects,
      supportingEvidenceRefs: evidence,
    });
    if (persistenceSubjects.length > 0) {
      await this.rules.propose({
        scope: 'repository',
        condition: { expression: { changedStructures: persistenceSubjects } },
        intervention: { action: { type: 'change-persisted-contract' } },
        predictedEffects: [
          { target: 'restore', operation: 'invalidate' },
          { target: 'replay', operation: 'invalidate' },
          { target: 'export', operation: 'invalidate' },
        ],
        subjectRefs: persistenceSubjects,
        supportingEvidenceRefs: evidence,
      });
    }
    if (eventSubjects.length > 0) {
      await this.rules.propose({
        scope: 'runtime',
        condition: { expression: { changedStructures: eventSubjects } },
        intervention: { action: { type: 'change-event-contract' } },
        predictedEffects: [
          { target: 'publishers', operation: 'invalidate' },
          { target: 'subscribers', operation: 'invalidate' },
          { target: 'event-order', operation: 'invalidate' },
        ],
        subjectRefs: eventSubjects,
        supportingEvidenceRefs: evidence,
      });
    }
    if (generatedSubjects.length > 0) {
      await this.rules.propose({
        scope: 'repository',
        condition: { expression: { changedStructures: generatedSubjects } },
        intervention: { action: { type: 'change-generated-source' } },
        predictedEffects: [
          { target: 'generated-artifacts', operation: 'invalidate' },
        ],
        subjectRefs: generatedSubjects,
        supportingEvidenceRefs: evidence,
      });
    }
  }

  private async ensureWorldModelPopulation(signal: AbortSignal): Promise<void> {
    if (this.worldModels.activeCandidates().length > 0) return;
    const objective = this.currentObjective();
    const proposed = await this.evolution.evolve({
      kind: this.worldModels.list().length === 0 ? 'propose' : 'repair',
      objective,
      observations: [this.structureSummary(), this.contextSummary()],
      counterexamples: this.worldModels.list('rejected').map((candidate) => ({
        candidateId: candidate.manifest.candidateId,
        reason: candidate.rejectionReason,
        evaluationRefs: candidate.evaluationRefs,
      })),
      conflicts: this.signals.conflicts('open'),
      ruleIds: this.rules.list().map((rule) => rule.ruleId),
      parentCandidateIds: this.worldModels.list().map((candidate) => candidate.manifest.candidateId),
      parentCandidates: this.worldModels.list(),
      ruleGraphHash: this.rules.snapshot().hash,
      stateSchemaHash: hashText('adaptive-state-schema/1'),
      actionSchemaHash: hashText('adaptive-action-schema/1'),
      observationSchemaHash: hashText('adaptive-observation-schema/1'),
      evidenceHead: this.ledger.head().recordHash ?? '',
      maximumCandidates: Math.max(3, Math.min(8, DEFAULT_ADAPTIVE_BUDGET.maxCandidates)),
    }, signal);

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
      this.runtime.fail('no-viable-model', 'No generated causal model passed sandbox validation.');
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
      const actions = await this.generateActions(signal);
      await this.search.addActions(nodeId, actions);
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
        case 'inspect-structure': {
          const result = this.structure.query({ depth: 2 });
          nodeId = await this.observeInternal(selection, 'inspected', 0.1, result) ?? nodeId;
          continue;
        }
        case 'run-evaluation':
        case 'run-replicate':
        case 'evaluate-task-patch': {
          nodeId = await this.executeEvaluation(selection, signal) ?? nodeId;
          continue;
        }
        case 'revise-world-model':
        case 'expand-world-model-population': {
          this.runtime.transition('modeling', selection.action.description);
          await this.ensureWorldModelPopulation(signal);
          nodeId = await this.observeInternal(selection, 'population-expanded', 0.15) ?? nodeId;
          this.runtime.transition('planning', 'World-model population updated.');
          continue;
        }
        case 'construct-intervention':
        case 'simulate-task-action': {
          nodeId = await this.observeInternal(selection, 'simulated', 0.05) ?? nodeId;
          continue;
        }
        case 'propose-task-patch':
        case 'execute-task-action': {
          this.runtime.transition('acting', selection.action.description);
          this.directive.set(selection.action.description);
          return;
        }
        case 'commit-solution': {
          this.runtime.transition('committing', 'Preparing the verified final response.');
          this.directive.set(selection.action.description);
          return;
        }
      }
    }
    this.runtime.transition('acting', 'Internal search budget reached; perform the highest-value reversible task action and report its direct result.');
    this.directive.set('Perform the highest-value reversible task action selected by the current evidence. Do not claim completion without verification.');
  }

  private async generateActions(signal: AbortSignal): Promise<readonly SearchAction[]> {
    const actions: SearchAction[] = [];
    const conflicts = this.signals.conflicts('open');
    for (const conflict of conflicts.slice(0, 8)) {
      actions.push(await this.evaluationActionForConflict(conflict, signal));
    }
    if (this.worldModels.activeCandidates().length < 3) {
      actions.push(baseAction({
        actionId: 'expand-world-model-population',
        kind: 'expand-world-model-population',
        description: 'Generate additional executable causal models because the active epistemic ensemble is too small.',
        payload: { reason: 'minimum-ensemble-size' },
        prior: 0.5,
        expectedTaskValue: 0.1,
        expectedProgress: 0.15,
        decisionSensitivity: 0.8,
        generalizationLeverage: 0.7,
      }));
    }
    actions.push(await this.withPredictions(baseAction({
      actionId: 'execute-best-task-action',
      kind: 'execute-task-action',
      description: 'Advance the user task with the highest-value code action supported by the current causal rules. Trace cross-file effects and use ordinary KC permissions.',
      payload: { objective: this.currentObjective() },
      prior: 0.8,
      expectedTaskValue: 0.5,
      expectedProgress: 0.6,
      decisionSensitivity: 0.9,
      generalizationLeverage: 0.7,
    }), signal));
    actions.push(await this.withPredictions(baseAction({
      actionId: 'commit-verified-solution',
      kind: 'commit-solution',
      description: 'Return only the completed change, decisive verification, and unresolved material risk. Do not include investigation history.',
      payload: { verifiedCandidates: this.state.verifiedCandidates },
      prior: this.state.verifiedCandidates > 0 ? 0.7 : 0.05,
      expectedTaskValue: this.state.verifiedCandidates > 0 ? 0.8 : -0.5,
      expectedProgress: 0,
      decisionSensitivity: 1,
      generalizationLeverage: 0,
    }), signal));
    return actions;
  }

  private async evaluationActionForConflict(
    conflict: StructuralConflict,
    signal: AbortSignal,
  ): Promise<SearchAction> {
    const command = commandForConflict(conflict);
    return this.withPredictions(baseAction({
      actionId: `evaluate-conflict:${conflict.conflictId}`,
      kind: 'run-evaluation',
      description: `Resolve ${conflict.kind}: ${conflict.message}`,
      payload: {
        evaluatorId: 'sandbox.command',
        command,
        conflictId: conflict.conflictId,
      },
      prior: conflict.severity === 'commit-blocking' ? 1 : 0.7,
      expectedTaskValue: conflict.severity === 'commit-blocking' ? 0.5 : 0.25,
      expectedProgress: 0.2,
      decisionSensitivity: conflict.severity === 'commit-blocking' ? 1 : 0.7,
      generalizationLeverage: conflict.kind === 'persistence-conflict' || conflict.kind === 'event-order-conflict' ? 1 : 0.7,
      hardGate: conflict.severity === 'commit-blocking',
    }), signal);
  }

  private async withPredictions(
    action: SearchAction,
    signal: AbortSignal,
  ): Promise<SearchAction> {
    const beliefState = this.worldModels.beliefState();
    const weights = new Map(
      beliefState.beliefs.map((belief) => [belief.candidateId, belief.normalizedWeight]),
    );
    const predictions: SearchOutcomePrediction[] = [];
    for (const candidate of this.worldModels.activeCandidates()) {
      try {
        const observation = {
          objective: this.currentObjective(),
          structureHash: this.structure.snapshot()?.hash,
          conflicts: this.signals.conflicts('open'),
        };
        const state = await this.worldModels.invoke(
          candidate.manifest.candidateId,
          'encodeObservation',
          [observation, { seed: action.actionId }],
          { signal, timeoutMs: 5_000, seed: action.actionId },
        );
        const predicted = await this.worldModels.invoke<{
          readonly outcomes?: readonly { readonly probability?: number; readonly value?: unknown; readonly nextState?: unknown }[];
        }>(
          candidate.manifest.candidateId,
          'predictTransition',
          [state, { type: action.kind, payload: action.payload }, { seed: action.actionId }],
          { signal, timeoutMs: 5_000, seed: action.actionId },
        );
        const distribution: Record<string, number> = {};
        for (const outcome of predicted?.outcomes ?? []) {
          const key = hashValue(outcome.value ?? outcome.nextState ?? outcome);
          distribution[key] = (distribution[key] ?? 0) + Math.max(0, outcome.probability ?? 0);
        }
        if (Object.keys(distribution).length === 0) distribution['unknown'] = 1;
        predictions.push({
          candidateId: candidate.manifest.candidateId,
          modelWeight: weights.get(candidate.manifest.candidateId) ?? 0,
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
      readonly conflictId?: string;
    };
    const evaluatorId = payload.evaluatorId ?? 'sandbox.command';
    if (!this.evaluators.list().some((definition) => definition.evaluatorId === evaluatorId)) {
      return this.observeInternal(selection, 'evaluator-unavailable', -0.25);
    }
    this.runtime.transition('evaluating', selection.action.description);
    const baseline = this.workspaces.baseline() ?? await this.workspaces.captureBaseline(signal);
    const candidateId = hashText(`${selection.decisionId}:${baseline.hash}`) as CandidateId;
    const workspace = await this.workspaces.materialize(candidateId, '', signal);
    const mounts = await this.dependencyMounts(baseline.root);
    try {
      const result = await this.evaluation.evaluate({
        protocol: 'evaluation/1',
        evaluationId: createEvaluationId(),
        adaptiveRunId: this.runtime.runId(),
        evaluatorId,
        input: {
          workspacePath: workspace.path,
          args: payload.command ?? ['pnpm', 'typecheck'],
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
        tags: ['adaptive', 'conflict-resolution'],
      }, signal);
      const passed = result.status === 'passed';
      this.state = {
        ...this.state,
        evaluationsCompleted: this.state.evaluationsCompleted + 1,
        verifiedCandidates: this.state.verifiedCandidates + (passed ? 1 : 0),
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
        await this.signals.resolve(payload.conflictId as never);
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

  private observeInternal(
    selection: SearchSelection,
    outcomeKey: string,
    value: number,
    _result?: unknown,
  ) {
    return this.search.observe(selection, outcomeKey, value, this.searchState());
  }

  private async observeStep(step: AfterStepContext): Promise<void> {
    if (isTerminalPhase(this.runtime.phase())) {
      step.stopTurn = true;
      return;
    }
    this.runtime.transition('reconciling', 'Reconciling the real step outcome with the causal models.');
    const baseline = await this.workspaces.captureBaseline(step.signal);
    await this.structure.rebuild(step.signal);
    await this.ledger.append({
      recordType: 'task.action.executed',
      adaptiveRunId: this.runtime.runId(),
      payload: {
        turnId: step.turnId,
        step: step.step,
        finishReason: step.finishReason,
        baselineHash: baseline.hash,
        ledgerHead: this.ledger.head().recordHash,
      },
    });
    const blocking = this.signals
      .conflicts('open')
      .filter((conflict) => conflict.severity === 'commit-blocking').length;
    const entropy = this.runtime.status()?.normalizedPosteriorEntropy ?? 1;
    const assessment = this.search.assessCommit({
      hardGatesPass: this.state.verifiedCandidates > 0,
      commitBlockingConflicts: blocking,
      actionStableAcrossModels: entropy <= 0.25 || this.worldModels.activeCandidates().length <= 1,
      expectedAdditionalInformationValue:
        this.runtime.status()?.decisionWeightedUncertainty ?? entropy,
      expectedAdditionalCost: 0.1,
      liveWorkspaceReconciled: true,
      claimsSupported: this.state.verifiedCandidates > 0,
    });
    if (step.finishReason !== 'tool_calls' && assessment.eligible) {
      this.runtime.transition('committing', 'All commit gates passed.');
      await this.ledger.append({
        recordType: 'solution.commit.selected',
        adaptiveRunId: this.runtime.runId(),
        payload: {
          assessment,
          selection: this.state.lastSelection,
          baselineHash: baseline.hash,
        },
      });
      this.runtime.complete('Verified solution committed.');
      this.directive.set(undefined);
      step.stopTurn = true;
      return;
    }
    if (this.state.continuationCount >= MAX_ADAPTIVE_CONTINUATIONS) {
      this.runtime.fail('budget-exhausted', 'Adaptive continuation budget exhausted.');
      this.directive.set(undefined);
      step.stopTurn = true;
      return;
    }
    this.runtime.transition('planning', 'Further evidence or task progress is required.');
    this.state = {
      ...this.state,
      continuationCount: this.state.continuationCount + 1,
    };
    this.loop.enqueue(new StepRequest({
      kind: 'adaptive.continue',
      admission: 'activeTurnOnly',
      merge: 'none',
      contextMessages: [],
    }));
  }

  private searchState(): SearchState {
    const baseline = this.workspaces.baseline();
    const structure = this.structure.snapshot();
    const beliefs = this.worldModels.beliefState();
    const conflicts = this.signals.conflicts('open');
    return {
      workspaceSnapshotHash: baseline?.hash ?? 'uncaptured',
      beliefStateHash: hashValue(beliefs),
      causalRuleGraphHash: this.rules.snapshot().hash,
      structureIndexHash: structure?.hash ?? 'unindexed',
      unresolvedConflictHash: hashValue(conflicts),
      trajectorySummaryHash: hashValue(this.contextSummary()),
      verifiedCandidateIds: this.state.verifiedCandidates > 0
        ? ['current-workspace']
        : [],
      remainingBudget: DEFAULT_ADAPTIVE_BUDGET,
      goalVersion: 1,
    };
  }

  private currentObjective(): string {
    const summary = this.contextSummary();
    return summary.length === 0
      ? 'Complete the current coding task with verified repository-wide correctness.'
      : summary.slice(-8_000);
  }

  private contextSummary(): string {
    const history = this.context.history().slice(-24);
    return JSON.stringify(history).slice(-32_000);
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
            .filter((node) => [
              'package',
              'interface',
              'service-registration',
              'wire-model',
              'wire-operation',
              'event-type',
              'generated-artifact',
            ].includes(node.kind))
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
  > & Partial<SearchAction>,
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
      return ['sh', '-lc', 'pnpm --filter @moonshot-ai/agent-core-v2 gen:config-manifest && pnpm --filter @moonshot-ai/agent-core-v2 gen:wire-manifest && pnpm --filter @moonshot-ai/agent-core-v2 gen:state-manifest && git diff --exit-code'];
    case 'persistence-conflict':
    case 'event-order-conflict':
      return ['pnpm', 'test'];
    case 'public-contract-conflict':
    case 'scope-conflict':
    case 'candidate-conflict':
      return ['pnpm', 'typecheck'];
    case 'coverage-conflict':
      return ['pnpm', 'test'];
    case 'prediction-conflict':
    case 'evidence-conflict':
    case 'stale-evidence-conflict':
    case 'signal-overflow':
      return ['pnpm', 'typecheck'];
  }
}

function isTerminalPhase(phase: ReturnType<IAgentAdaptiveRuntimeService['phase']>): boolean {
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
