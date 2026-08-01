import { createHash } from 'node:crypto';

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import {
  IAgentSearchPolicyValueService,
  SEARCH_EXPERIENCE_PROTOCOL,
  SEARCH_POLICY_CHECKPOINT_PROTOCOL,
  type SearchExperienceRecord,
  type SearchPolicyActionEstimate,
  type SearchPolicyActionFeatures,
  type SearchPolicyCheckpoint,
  type SearchPolicyStateFeatures,
  type SearchPolicyValueEstimate,
} from './searchPolicyValue';

const CHECKPOINT_KEY = 'promoted-search-policy/checkpoint.json';
const EXPERIENCE_KEY = 'search-experience.jsonl';

const FEATURE_NAMES = [
  'deterministicPrior',
  'expectedTaskProgress',
  'conflictUrgency',
  'decisionWeightedInformationGain',
  'generalizationLeverage',
  'cost',
  'risk',
  'redundancy',
  'remainingBudgetFraction',
  'normalizedPosteriorEntropy',
  'openConflicts',
  'viableModels',
  'verifiedCandidates',
] as const;

export class AgentSearchPolicyValueService
  extends Disposable
  implements IAgentSearchPolicyValueService
{
  declare readonly _serviceBrand: undefined;

  private readonly globalScope: string;
  private readonly experienceScope: string;
  private readonly readyPromise: Promise<void>;
  private checkpoint: SearchPolicyCheckpoint | undefined;
  private checkpointRejectionReason: string | undefined;
  private writeTail: Promise<void> = Promise.resolve();

  constructor(
    @IBootstrapService bootstrap: IBootstrapService,
    @IAgentScopeContext agent: IAgentScopeContext,
    @IAtomicDocumentStore private readonly documents: IAtomicDocumentStore,
    @IAppendLogStore private readonly appendLog: IAppendLogStore,
  ) {
    super();
    this.globalScope = bootstrap.scope('adaptive');
    this.experienceScope = agent.scope('adaptive');
    this._register(this.documents.acquire(this.globalScope, CHECKPOINT_KEY));
    this._register(this.appendLog.acquire(this.experienceScope, EXPERIENCE_KEY));
    this.readyPromise = this.loadCheckpoint();
  }

  ready(): Promise<void> {
    return this.readyPromise;
  }

  estimate(state: SearchPolicyStateFeatures): SearchPolicyValueEstimate {
    validateState(state);
    const checkpoint = this.checkpoint;
    if (checkpoint === undefined) {
      return coldStartEstimate(state, this.checkpointRejectionReason);
    }
    return learnedEstimate(state, checkpoint);
  }

  recordExperience(record: SearchExperienceRecord): Promise<void> {
    return this.mutate(async () => {
      validateExperience(record);
      let appendError: unknown;
      this.appendLog.append(this.experienceScope, EXPERIENCE_KEY, deepFreeze(structuredClone(record)), {
        onError: (error) => { appendError = error; },
      });
      await this.appendLog.flush();
      if (appendError !== undefined) throw appendError;
    });
  }

  activeCheckpoint(): SearchPolicyCheckpoint | undefined {
    return this.checkpoint;
  }

  reloadCheckpoint(): Promise<void> {
    return this.mutate(() => this.loadCheckpoint());
  }

  async flush(): Promise<void> {
    await this.readyPromise;
    await this.writeTail;
    await this.appendLog.flush();
  }

  private async loadCheckpoint(): Promise<void> {
    const checkpoint = await this.documents.get<SearchPolicyCheckpoint>(
      this.globalScope,
      CHECKPOINT_KEY,
    );
    if (checkpoint === undefined) {
      this.checkpoint = undefined;
      this.checkpointRejectionReason = 'No promoted policy/value checkpoint is installed.';
      return;
    }
    const reason = checkpointRejectionReason(checkpoint);
    if (reason !== undefined) {
      this.checkpoint = undefined;
      this.checkpointRejectionReason = reason;
      return;
    }
    this.checkpoint = deepFreeze(structuredClone(checkpoint));
    this.checkpointRejectionReason = undefined;
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    let resolveResult!: (value: T) => void;
    let rejectResult!: (error: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    this.writeTail = this.writeTail
      .then(async () => {
        await this.readyPromise;
        resolveResult(await operation());
      })
      .catch(rejectResult);
    return result;
  }
}

function coldStartEstimate(
  state: SearchPolicyStateFeatures,
  fallbackReason?: string,
): SearchPolicyValueEstimate {
  const scores = state.actions.map((action) =>
    action.deterministicPrior +
    0.3 * action.expectedTaskProgress +
    0.25 * action.conflictUrgency +
    0.3 * action.decisionWeightedInformationGain +
    0.15 * action.generalizationLeverage -
    0.15 * action.cost -
    0.25 * action.risk -
    0.1 * action.redundancy,
  );
  const priors = softmax(scores, 1);
  const actions = state.actions.map((action, index): SearchPolicyActionEstimate => ({
    actionId: action.actionId,
    prior: priors[index] ?? 0,
    value: clamp(
      action.expectedTaskProgress +
      0.5 * action.decisionWeightedInformationGain +
      0.25 * action.generalizationLeverage -
      action.cost -
      action.risk,
      -1,
      1,
    ),
    cost: Math.max(0, action.cost),
    risk: clamp01(action.risk),
    uncertainty: clamp01(
      state.normalizedPosteriorEntropy *
      (1 - clamp01(state.remainingBudgetFraction) * 0.25),
    ),
  }));
  return Object.freeze({
    backend: 'deterministic-cold-start',
    stateValue: actions.length === 0
      ? -1
      : Math.max(...actions.map((action) => action.value)),
    stateValueUncertainty: clamp01(state.normalizedPosteriorEntropy),
    actions,
    fallbackReason,
  });
}

function learnedEstimate(
  state: SearchPolicyStateFeatures,
  checkpoint: SearchPolicyCheckpoint,
): SearchPolicyValueEstimate {
  const rows = state.actions.map((action) => featureVector(state, action));
  const policyScores = rows.map(
    (row) => checkpoint.bias.policy + dot(row, checkpoint.policyWeights),
  );
  const priors = softmax(policyScores, checkpoint.calibration.temperature);
  const actions = state.actions.map((action, index): SearchPolicyActionEstimate => {
    const row = rows[index] as Readonly<Record<string, number>>;
    return {
      actionId: action.actionId,
      prior: priors[index] ?? 0,
      value: clamp(
        (checkpoint.bias.value + dot(row, checkpoint.valueWeights)) *
          checkpoint.calibration.valueScale,
        -1,
        1,
      ),
      cost: Math.max(0, action.cost),
      risk: clamp01(action.risk),
      uncertainty: Math.max(
        checkpoint.calibration.uncertaintyFloor,
        clamp01(sigmoid(checkpoint.bias.uncertainty + dot(row, checkpoint.uncertaintyWeights))),
      ),
    };
  });
  const weightedValue = actions.reduce(
    (sum, action) => sum + action.prior * action.value,
    0,
  );
  const weightedUncertainty = actions.reduce(
    (sum, action) => sum + action.prior * action.uncertainty,
    0,
  );
  return Object.freeze({
    backend: 'promoted-linear-checkpoint',
    checkpointHash: checkpoint.checkpointHash,
    stateValue: clamp(weightedValue, -1, 1),
    stateValueUncertainty: clamp01(weightedUncertainty),
    actions,
  });
}

function featureVector(
  state: SearchPolicyStateFeatures,
  action: SearchPolicyActionFeatures,
): Readonly<Record<string, number>> {
  return Object.freeze({
    deterministicPrior: action.deterministicPrior,
    expectedTaskProgress: action.expectedTaskProgress,
    conflictUrgency: action.conflictUrgency,
    decisionWeightedInformationGain: action.decisionWeightedInformationGain,
    generalizationLeverage: action.generalizationLeverage,
    cost: action.cost,
    risk: action.risk,
    redundancy: action.redundancy,
    remainingBudgetFraction: state.remainingBudgetFraction,
    normalizedPosteriorEntropy: state.normalizedPosteriorEntropy,
    openConflicts: state.openConflicts,
    viableModels: state.viableModels,
    verifiedCandidates: state.verifiedCandidates,
  });
}

function checkpointRejectionReason(
  checkpoint: SearchPolicyCheckpoint,
): string | undefined {
  if (checkpoint.protocol !== SEARCH_POLICY_CHECKPOINT_PROTOCOL) {
    return `Unsupported policy checkpoint protocol: ${String(checkpoint.protocol)}.`;
  }
  if (checkpoint.featureNames.join('\u0000') !== FEATURE_NAMES.join('\u0000')) {
    return 'Policy checkpoint feature schema does not match the runtime.';
  }
  const { checkpointHash: _checkpointHash, ...base } = checkpoint;
  if (hashCanonical(base) !== checkpoint.checkpointHash) {
    return 'Policy checkpoint hash verification failed.';
  }
  if (!checkpoint.promotion.promoted) return 'Policy checkpoint is not promoted.';
  if (checkpoint.promotion.independentWindowsPassed < 2) {
    return 'Policy checkpoint has not passed two independent promotion windows.';
  }
  if (checkpoint.promotion.hardGateRegressions !== 0) {
    return 'Policy checkpoint has hard-gate regressions.';
  }
  if (
    !Number.isFinite(checkpoint.promotion.confirmationScore) ||
    !Number.isFinite(checkpoint.promotion.promotionScore)
  ) {
    return 'Policy checkpoint promotion scores are invalid.';
  }
  if (
    !Number.isFinite(checkpoint.calibration.temperature) ||
    checkpoint.calibration.temperature <= 0 ||
    !Number.isFinite(checkpoint.calibration.valueScale) ||
    checkpoint.calibration.valueScale <= 0 ||
    !Number.isFinite(checkpoint.calibration.uncertaintyFloor) ||
    checkpoint.calibration.uncertaintyFloor < 0 ||
    checkpoint.calibration.uncertaintyFloor > 1
  ) {
    return 'Policy checkpoint calibration is invalid.';
  }
  for (const weights of [
    checkpoint.policyWeights,
    checkpoint.valueWeights,
    checkpoint.uncertaintyWeights,
  ]) {
    if (Object.keys(weights).some((feature) => !FEATURE_NAMES.includes(feature as typeof FEATURE_NAMES[number]))) {
      return 'Policy checkpoint contains an unknown feature weight.';
    }
    if (Object.values(weights).some((weight) => !Number.isFinite(weight))) {
      return 'Policy checkpoint contains a non-finite weight.';
    }
  }
  return undefined;
}

function validateState(state: SearchPolicyStateFeatures): void {
  if (state.stateHash.trim().length === 0) throw new Error('Search policy state hash cannot be empty.');
  if (state.remainingBudgetFraction < 0 || state.remainingBudgetFraction > 1) {
    throw new Error('Search policy remainingBudgetFraction must be in [0, 1].');
  }
  if (state.normalizedPosteriorEntropy < 0 || state.normalizedPosteriorEntropy > 1) {
    throw new Error('Search policy normalizedPosteriorEntropy must be in [0, 1].');
  }
  const actionIds = new Set<string>();
  for (const action of state.actions) {
    if (action.actionId.trim().length === 0) throw new Error('Search policy action ID cannot be empty.');
    if (actionIds.has(action.actionId)) throw new Error(`Duplicate search policy action: ${action.actionId}`);
    actionIds.add(action.actionId);
    for (const value of Object.values(action).filter((value): value is number => typeof value === 'number')) {
      if (!Number.isFinite(value)) throw new Error(`Search policy action ${action.actionId} has a non-finite feature.`);
    }
  }
}

function validateExperience(record: SearchExperienceRecord): void {
  if (record.protocol !== SEARCH_EXPERIENCE_PROTOCOL) {
    throw new Error(`Unsupported search experience protocol: ${String(record.protocol)}.`);
  }
  validateState(record.state);
  if (!Number.isInteger(record.sequence) || record.sequence < 0) {
    throw new Error('Search experience sequence must be non-negative.');
  }
  if (!record.legalActionIds.includes(record.selectedActionId)) {
    throw new Error('Selected search action is not legal in the recorded state.');
  }
  const visitTotal = Object.values(record.visitDistribution).reduce(
    (sum, value) => sum + value,
    0,
  );
  if (Math.abs(visitTotal - 1) > 1e-9) {
    throw new Error('Search experience visit distribution must sum to 1.');
  }
  if (
    Object.keys(record.visitDistribution).some(
      (actionId) => !record.legalActionIds.includes(actionId),
    )
  ) {
    throw new Error('Search experience visit distribution references an illegal action.');
  }
  if (!Number.isFinite(record.verifiedReturn) || !Number.isFinite(record.cost)) {
    throw new Error('Search experience return and cost must be finite.');
  }
  if (record.taskFamily.trim().length === 0 || record.terminalOutcome.trim().length === 0) {
    throw new Error('Search experience task family and terminal outcome are required.');
  }
}

function dot(
  features: Readonly<Record<string, number>>,
  weights: Readonly<Record<string, number>>,
): number {
  return Object.entries(weights).reduce(
    (sum, [name, weight]) => sum + (features[name] ?? 0) * weight,
    0,
  );
}

function softmax(scores: readonly number[], temperature: number): readonly number[] {
  if (scores.length === 0) return [];
  const scaled = scores.map((score) => score / temperature);
  const maximum = Math.max(...scaled);
  const exponents = scaled.map((score) => Math.exp(score - maximum));
  const total = exponents.reduce((sum, value) => sum + value, 0);
  return exponents.map((value) => value / total);
}

function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-value));
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function hashCanonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, current: unknown) => {
    if (current !== null && typeof current === 'object' && !Array.isArray(current)) {
      const object = current as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(object)
          .sort()
          .filter((key) => object[key] !== undefined)
          .map((key) => [key, object[key]]),
      );
    }
    return current;
  });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentSearchPolicyValueService,
  AgentSearchPolicyValueService,
  ScopeActivation.OnScopeCreated,
  'searchPolicyValue',
);
