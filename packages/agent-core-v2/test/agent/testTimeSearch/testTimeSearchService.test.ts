import { describe, expect, it } from 'vitest';

import type { IDisposable } from '#/_base/di/lifecycle';
import type { Event } from '#/_base/event';
import {
  DEFAULT_ADAPTIVE_CONFIG,
  type AdaptiveConfig,
} from '#/agent/adaptiveRuntime/configSection';
import type {
  AdaptiveConfigSnapshot,
  ISessionAdaptiveConfigService,
} from '#/agent/adaptiveRuntime/adaptiveConfigService';
import type {
  AdaptiveBudget,
  AdaptiveRunId,
  CandidateId,
} from '#/agent/adaptiveRuntime/adaptiveProtocol';
import type { IAgentAdaptiveRuntimeService } from '#/agent/adaptiveRuntime/adaptiveRuntime';
import type { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import type {
  IAgentSearchPolicyValueService,
  SearchExperienceRecord,
  SearchPolicyStateFeatures,
  SearchPolicyValueEstimate,
} from '#/agent/testTimeSearch/searchPolicyValue';
import type {
  SearchAction,
  SearchState,
} from '#/agent/testTimeSearch/testTimeSearch';
import { AgentTestTimeSearchService } from '#/agent/testTimeSearch/testTimeSearchService';
import type {
  CalibrationMetrics,
  CalibrationSnapshot,
  IWorldModelCalibrationService,
} from '#/agent/worldModel/worldModelCalibration';
import type { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import type {
  AppendEvaluationLedgerInput,
  EvaluationLedgerHead,
  EvaluationLedgerRecord,
  ISessionEvaluationLedgerService,
} from '#/session/evaluationLedger/evaluationLedger';

class Documents implements IAtomicDocumentStore {
  declare readonly _serviceBrand: undefined;
  readonly values = new Map<string, unknown>();
  async get<T>(scope: string, key: string): Promise<T | undefined> {
    return structuredClone(this.values.get(`${scope}/${key}`)) as T | undefined;
  }
  async set<T>(scope: string, key: string, value: T): Promise<void> {
    this.values.set(`${scope}/${key}`, structuredClone(value));
  }
  async delete(scope: string, key: string): Promise<void> {
    this.values.delete(`${scope}/${key}`);
  }
  async list(scope: string, prefix = ''): Promise<readonly string[]> {
    const start = `${scope}/`;
    return [...this.values.keys()]
      .filter((key) => key.startsWith(start))
      .map((key) => key.slice(start.length))
      .filter((key) => key.startsWith(prefix));
  }
  watch(): Event<void> { return () => ({ dispose() {} }); }
  acquire(): IDisposable { return { dispose() {} }; }
}

class Ledger implements ISessionEvaluationLedgerService {
  declare readonly _serviceBrand: undefined;
  readonly values: EvaluationLedgerRecord[] = [];
  async ready(): Promise<void> {}
  async append<TPayload>(
    input: AppendEvaluationLedgerInput<TPayload>,
  ): Promise<EvaluationLedgerRecord<TPayload>> {
    const record: EvaluationLedgerRecord<TPayload> = {
      protocol: 'adaptive-ledger/1',
      sequence: this.values.length + 1,
      previousRecordHash: this.values.at(-1)?.recordHash ?? null,
      recordHash: `record-${String(this.values.length + 1)}`,
      recordType: input.recordType,
      adaptiveRunId: input.adaptiveRunId,
      evidenceId: input.evidenceId,
      payload: input.payload,
    };
    this.values.push(record as EvaluationLedgerRecord);
    return record;
  }
  async *records(): AsyncIterable<EvaluationLedgerRecord> { yield* this.values; }
  head(): EvaluationLedgerHead {
    return {
      protocol: 'adaptive-ledger/1',
      sequence: this.values.length,
      recordHash: this.values.at(-1)?.recordHash ?? null,
    };
  }
  async verify() { return { valid: true, records: this.values.length, head: this.head() }; }
  async flush(): Promise<void> {}
}

class Runtime {
  phaseValue = 'inactive';
  ensureRun(): AdaptiveRunId { return 'run' as AdaptiveRunId; }
  transition(phase: string): void { this.phaseValue = phase; }
}

class Policy implements IAgentSearchPolicyValueService {
  declare readonly _serviceBrand: undefined;
  readonly experiences: SearchExperienceRecord[] = [];
  priors: Readonly<Record<string, number>> = {};
  async ready(): Promise<void> {}
  estimate(state: SearchPolicyStateFeatures): SearchPolicyValueEstimate {
    const total = state.actions.reduce(
      (sum, action) => sum + Math.max(0, this.priors[action.actionId] ?? 0),
      0,
    );
    return {
      backend: 'promoted-linear-checkpoint',
      checkpointHash: 'checkpoint',
      stateValue: 0,
      stateValueUncertainty: 0.1,
      actions: state.actions.map((action) => ({
        actionId: action.actionId,
        prior: total > 0
          ? Math.max(0, this.priors[action.actionId] ?? 0) / total
          : 1 / state.actions.length,
        value: 0,
        cost: action.cost,
        risk: action.risk,
        uncertainty: 0.1,
      })),
    };
  }
  async recordExperience(record: SearchExperienceRecord): Promise<void> {
    this.experiences.push(record);
  }
  activeCheckpoint() {
    return { checkpointHash: 'checkpoint' } as ReturnType<IAgentSearchPolicyValueService['activeCheckpoint']>;
  }
  async reloadCheckpoint(): Promise<void> {}
  async flush(): Promise<void> {}
}

class Calibration implements IWorldModelCalibrationService {
  declare readonly _serviceBrand: undefined;
  multipliers: Readonly<Record<string, number>> = {};
  async ready(): Promise<void> {}
  async record(): Promise<CalibrationMetrics> { return this.metrics('', ''); }
  async recordMany(): Promise<readonly CalibrationMetrics[]> { return []; }
  async recalibrateHeldOut(): Promise<CalibrationMetrics> { return this.metrics('', ''); }
  metrics(evaluatorFamily: string, modelLineage: string): CalibrationMetrics {
    const multiplier = this.informationGainMultiplier(evaluatorFamily, modelLineage);
    return {
      protocol: 'adaptive-calibration/1',
      evaluatorFamily,
      modelLineage,
      observations: 20,
      booleanAndCategoricalObservations: 20,
      intervalObservations: 0,
      brierScore: multiplier === 0 ? 1 : 0,
      logLoss: multiplier === 0 ? 10 : 0,
      expectedCalibrationError: 1 - multiplier,
      reliabilityBins: [],
      status: multiplier === 0 ? 'severely-miscalibrated' : 'calibrated',
      informationGainMultiplier: multiplier,
      promotionEligible: multiplier > 0,
      regimeShift: false,
      updatedAtSequence: 20,
    };
  }
  informationGainMultiplier(_family: string, lineage: string): number {
    return this.multipliers[lineage] ?? 1;
  }
  promotionEligible(family: string, lineage: string): boolean {
    return this.informationGainMultiplier(family, lineage) > 0;
  }
  snapshot(): CalibrationSnapshot {
    return { protocol: 'adaptive-calibration/1', metrics: [], observations: [], hash: 'calibration' };
  }
  async flush(): Promise<void> {}
}

function config(overrides: (value: AdaptiveConfig) => void = () => {}): ISessionAdaptiveConfigService {
  const value = structuredClone(DEFAULT_ADAPTIVE_CONFIG);
  overrides(value);
  const snapshot: AdaptiveConfigSnapshot = {
    config: value,
    hash: JSON.stringify(value),
  };
  return {
    _serviceBrand: undefined,
    snapshot: () => snapshot,
    modelRoles: () => ({
      proposal: 'model',
      repair: 'model',
      evaluationDesign: 'model',
      actionProposal: 'model',
      trajectoryCompression: 'model',
      policyValue: 'model',
      finalResponsePlanning: 'model',
      finalClaimVerification: 'model',
    }),
  };
}

const agent = {
  _serviceBrand: undefined,
  agentId: 'main',
  scope: (key = '') => key.length === 0 ? 'agents/main' : `agents/main/${key}`,
} as IAgentScopeContext;

const BUDGET: AdaptiveBudget = {
  maxInternalRequests: 128,
  maxEvaluations: 128,
  maxStochasticReplicates: 32,
  maxToolCalls: 256,
  maxInputTokens: 2_000_000,
  maxOutputTokens: 500_000,
  maxWallMs: 3_600_000,
  maxCpuMs: 14_400_000,
  maxDiskBytes: 20 * 1024 * 1024 * 1024,
  maxCandidates: 256,
};

function state(overrides: Partial<SearchState> = {}): SearchState {
  return {
    workspaceSnapshotHash: 'workspace',
    beliefStateHash: 'belief',
    causalRuleGraphHash: 'rules',
    structureIndexHash: 'structure',
    unresolvedConflictHash: 'conflicts',
    trajectorySummaryHash: 'trajectory',
    verifiedCandidateIds: [],
    remainingBudget: BUDGET,
    goalVersion: 1,
    normalizedPosteriorEntropy: 0.8,
    openConflictCount: 1,
    viableModelCount: 3,
    taskFamily: 'typescript-repair',
    repositorySplit: 'development',
    ...overrides,
  };
}

function action(
  actionId: string,
  overrides: Partial<SearchAction> = {},
): SearchAction {
  return {
    actionId,
    kind: 'run-evaluation',
    description: actionId,
    payload: { evidenceRefs: [`evidence-${actionId}`] },
    prior: 0.5,
    expectedTaskValue: 0,
    expectedProgress: 0,
    generalizationLeverage: 0,
    decisionSensitivity: 1,
    calibrationFactor: 1,
    wallCost: 0,
    tokenCost: 0,
    toolCost: 0,
    executionRisk: 0,
    redundancyPenalty: 0,
    ...overrides,
  };
}

function fixture(
  adaptiveConfig: ISessionAdaptiveConfigService = config(),
  documents = new Documents(),
) {
  const runtime = new Runtime();
  const policy = new Policy();
  const calibration = new Calibration();
  const ledger = new Ledger();
  const service = new AgentTestTimeSearchService(
    agent,
    runtime as unknown as IAgentAdaptiveRuntimeService,
    adaptiveConfig,
    policy,
    calibration,
    documents,
    ledger,
  );
  return { service, runtime, policy, calibration, ledger, documents };
}

function disagreeingPredictions(lineage: string) {
  return [
    {
      candidateId: 'candidate-a' as CandidateId,
      modelWeight: 0.5,
      distribution: { pass: 1, fail: 0 },
      evaluatorFamily: 'tests',
      modelLineage: lineage,
      effectiveSampleSize: 4,
    },
    {
      candidateId: 'candidate-b' as CandidateId,
      modelWeight: 0.5,
      distribution: { pass: 0, fail: 1 },
      evaluatorFamily: 'tests',
      modelLineage: lineage,
      effectiveSampleSize: 4,
    },
  ] as const;
}

describe('AgentTestTimeSearchService integration', () => {
  it('uses promoted policy priors when frontier values are equal', async () => {
    const run = fixture();
    run.policy.priors = { a: 0.1, b: 0.9 };
    const root = await run.service.begin(state());
    await run.service.addActions(root, [action('a'), action('b')]);
    const selection = await run.service.select(root);
    expect(selection.action.actionId).toBe('b');
    expect(selection.policyBackend).toBe('promoted-linear-checkpoint');
    expect(selection.policyCheckpointHash).toBe('checkpoint');
  });

  it('applies configured progressive widening and preserves a hard gate', async () => {
    const run = fixture(config((value) => {
      value.search.progressiveWideningK = 1;
      value.search.progressiveWideningAlpha = 0.5;
    }));
    const root = await run.service.begin(state());
    await run.service.addActions(root, [
      action('ordinary-high', { expectedTaskValue: 1 }),
      action('hard-gate', { hardGate: true, expectedTaskValue: -1 }),
      action('ordinary-low'),
    ]);
    const node = run.service.node(root);
    expect(node?.kind).toBe('decision');
    expect(node?.kind === 'decision' ? node.edges.map((edge) => edge.action.actionId) : []).toEqual([
      'hard-gate',
    ]);
  });

  it('penalizes epistemic gain from a severely miscalibrated lineage', async () => {
    const run = fixture();
    run.calibration.multipliers = { good: 1, bad: 0 };
    const root = await run.service.begin(state());
    await run.service.addActions(root, [
      action('bad', { predictions: disagreeingPredictions('bad') }),
      action('good', { predictions: disagreeingPredictions('good') }),
    ]);
    const selection = await run.service.select(root);
    expect(selection.action.actionId).toBe('good');
  });

  it('bounds chance outcomes and aggregates the tail', async () => {
    const run = fixture(config((value) => {
      value.search.maximumChanceOutcomes = 3;
    }));
    const root = await run.service.begin(state());
    await run.service.addActions(root, [action('many', {
      predictions: [
        {
          candidateId: 'candidate-a' as CandidateId,
          modelWeight: 1,
          distribution: { a: 0.4, b: 0.25, c: 0.2, d: 0.1, e: 0.05 },
        },
      ],
    })]);
    const node = run.service.node(root);
    const probabilities = node?.kind === 'decision'
      ? node.edges[0]?.outcomeProbabilities
      : undefined;
    expect(Object.keys(probabilities ?? {})).toHaveLength(3);
    expect(probabilities).toHaveProperty('__other__');
  });

  it('records policy experience with visit distribution and evidence references', async () => {
    const run = fixture();
    const root = await run.service.begin(state());
    await run.service.addActions(root, [action('a'), action('b')]);
    const selection = await run.service.select(root);
    await run.service.observe(selection, 'passed', 0.75, state({ beliefStateHash: 'next' }));
    expect(run.policy.experiences).toHaveLength(1);
    expect(run.policy.experiences[0]).toMatchObject({
      selectedActionId: selection.action.actionId,
      verifiedReturn: 0.75,
      terminalOutcome: 'passed',
      taskFamily: 'typescript-repair',
      repositorySplit: 'development',
    });
    expect(run.policy.experiences[0]?.resultingEvidenceRefs).toEqual([
      `evidence-${selection.action.actionId}`,
    ]);
  });

  it('refuses to restore search state produced by a different config snapshot', async () => {
    const documents = new Documents();
    const first = fixture(config(), documents);
    const root = await first.service.begin(state());
    await first.service.addActions(root, [action('a')]);
    await first.service.flush();

    const second = fixture(config((value) => {
      value.search.cPuct = 9;
    }), documents);
    await second.service.ready();
    expect(second.service.root()).toBeUndefined();
    expect(second.service.nodes()).toHaveLength(0);
  });
});
