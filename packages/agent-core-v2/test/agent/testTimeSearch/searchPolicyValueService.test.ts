import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { IDisposable } from '#/_base/di/lifecycle';
import type { Event } from '#/_base/event';
import type { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import {
  SEARCH_EXPERIENCE_PROTOCOL,
  SEARCH_POLICY_CHECKPOINT_PROTOCOL,
  type SearchPolicyCheckpoint,
  type SearchPolicyStateFeatures,
} from '#/agent/testTimeSearch/searchPolicyValue';
import { AgentSearchPolicyValueService } from '#/agent/testTimeSearch/searchPolicyValueService';
import type { IBootstrapService } from '#/app/bootstrap/bootstrap';
import type { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import type { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';

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

class AppendLog {
  readonly entries: unknown[] = [];
  append(_scope: string, _key: string, value: unknown, options?: { onError?: (error: unknown) => void }) {
    try { this.entries.push(structuredClone(value)); }
    catch (error) { options?.onError?.(error); }
  }
  async *read<T>(): AsyncIterable<T> {
    for (const value of this.entries) yield structuredClone(value) as T;
  }
  async flush(): Promise<void> {}
  acquire(): IDisposable { return { dispose() {} }; }
}

const bootstrap = {
  _serviceBrand: undefined,
  scope: (name: string) => name,
} as unknown as IBootstrapService;

const agent = {
  _serviceBrand: undefined,
  agentId: 'agent-a',
  scope: (subKey?: string) => subKey === undefined ? 'agents/agent-a' : `agents/agent-a/${subKey}`,
} as unknown as IAgentScopeContext;

function fixture(documents = new Documents(), append = new AppendLog()) {
  return {
    service: new AgentSearchPolicyValueService(
      bootstrap,
      agent,
      documents,
      append as unknown as IAppendLogStore,
    ),
    documents,
    append,
  };
}

function state(): SearchPolicyStateFeatures {
  return {
    stateHash: 'state-hash',
    remainingBudgetFraction: 0.75,
    normalizedPosteriorEntropy: 0.5,
    openConflicts: 1,
    viableModels: 3,
    verifiedCandidates: 0,
    actions: [
      {
        actionId: 'evaluate',
        category: 'evaluation',
        deterministicPrior: 0.5,
        expectedTaskProgress: 0.2,
        conflictUrgency: 1,
        decisionWeightedInformationGain: 0.8,
        generalizationLeverage: 0.5,
        cost: 0.1,
        risk: 0.05,
        redundancy: 0,
      },
      {
        actionId: 'commit',
        category: 'commit',
        deterministicPrior: 0.3,
        expectedTaskProgress: 0.5,
        conflictUrgency: 0,
        decisionWeightedInformationGain: 0,
        generalizationLeverage: 0,
        cost: 0.05,
        risk: 0.2,
        redundancy: 0,
      },
    ],
  };
}

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

function checkpoint(
  overrides: Partial<SearchPolicyCheckpoint> = {},
): SearchPolicyCheckpoint {
  const base = {
    protocol: SEARCH_POLICY_CHECKPOINT_PROTOCOL,
    checkpointId: 'checkpoint-1',
    featureNames: FEATURE_NAMES,
    policyWeights: { decisionWeightedInformationGain: 2, risk: -1 },
    valueWeights: { expectedTaskProgress: 1, risk: -1 },
    uncertaintyWeights: { normalizedPosteriorEntropy: 1 },
    bias: { policy: 0, value: 0, uncertainty: 0 },
    calibration: { temperature: 1, valueScale: 1, uncertaintyFloor: 0.05 },
    promotion: {
      promoted: true,
      independentWindowsPassed: 2,
      confirmationScore: 0.1,
      promotionScore: 0.1,
      hardGateRegressions: 0,
    },
    trainingManifestHash: 'a'.repeat(64),
    modelCardHash: 'b'.repeat(64),
    ...overrides,
  };
  const withoutHash = { ...base };
  return {
    ...withoutHash,
    checkpointHash: hashCanonical(withoutHash),
  };
}

function install(documents: Documents, value: SearchPolicyCheckpoint): void {
  documents.values.set('adaptive/promoted-search-policy/checkpoint.json', value);
}

describe('AgentSearchPolicyValueService', () => {
  it('always provides deterministic normalized cold-start guidance', async () => {
    const { service } = fixture();
    await service.ready();
    const estimate = service.estimate(state());
    expect(estimate.backend).toBe('deterministic-cold-start');
    expect(estimate.fallbackReason).toContain('No promoted');
    expect(estimate.actions.reduce((sum, action) => sum + action.prior, 0)).toBeCloseTo(1);
    expect(estimate.actions.map((action) => action.actionId)).toEqual(['evaluate', 'commit']);
    expect(estimate.actions[0]!.prior).toBeGreaterThan(estimate.actions[1]!.prior);
  });

  it('loads a valid promoted checkpoint and uses learned priors and values', async () => {
    const documents = new Documents();
    const promoted = checkpoint();
    install(documents, promoted);
    const { service } = fixture(documents);
    await service.ready();
    const estimate = service.estimate(state());
    expect(estimate.backend).toBe('promoted-linear-checkpoint');
    expect(estimate.checkpointHash).toBe(promoted.checkpointHash);
    expect(service.activeCheckpoint()?.checkpointId).toBe('checkpoint-1');
    expect(estimate.actions.reduce((sum, action) => sum + action.prior, 0)).toBeCloseTo(1);
  });

  it.each([
    [{ promotion: { ...checkpoint().promotion, promoted: false } }, 'not promoted'],
    [{ promotion: { ...checkpoint().promotion, independentWindowsPassed: 1 } }, 'two independent'],
    [{ promotion: { ...checkpoint().promotion, hardGateRegressions: 1 } }, 'hard-gate'],
    [{ featureNames: ['invented'] }, 'feature schema'],
    [{ calibration: { ...checkpoint().calibration, temperature: 0 } }, 'calibration'],
  ])('falls back when checkpoint validation fails %#', async (override, reason) => {
    const documents = new Documents();
    install(documents, checkpoint(override as Partial<SearchPolicyCheckpoint>));
    const { service } = fixture(documents);
    await service.ready();
    const estimate = service.estimate(state());
    expect(estimate.backend).toBe('deterministic-cold-start');
    expect(estimate.fallbackReason?.toLowerCase()).toContain(String(reason).toLowerCase());
    expect(service.activeCheckpoint()).toBeUndefined();
  });

  it('rejects a checkpoint with a corrupted hash', async () => {
    const documents = new Documents();
    install(documents, { ...checkpoint(), checkpointHash: '0'.repeat(64) });
    const { service } = fixture(documents);
    await service.ready();
    expect(service.estimate(state()).fallbackReason).toContain('hash verification');
  });

  it('reloads a newly promoted checkpoint without reconstructing the service', async () => {
    const { service, documents } = fixture();
    await service.ready();
    expect(service.activeCheckpoint()).toBeUndefined();
    install(documents, checkpoint());
    await service.reloadCheckpoint();
    expect(service.activeCheckpoint()?.checkpointId).toBe('checkpoint-1');
  });

  it('records complete search experience targets', async () => {
    const { service, append } = fixture();
    await service.recordExperience({
      protocol: SEARCH_EXPERIENCE_PROTOCOL,
      sequence: 1,
      state: state(),
      legalActionIds: ['evaluate', 'commit'],
      visitDistribution: { evaluate: 0.75, commit: 0.25 },
      selectedActionId: 'evaluate',
      resultingEvidenceRefs: ['evidence-1'],
      verifiedReturn: 1,
      cost: 0.2,
      terminalOutcome: 'verified-success',
      taskFamily: 'multi-file',
      repositorySplit: 'development',
    });
    expect(append.entries).toHaveLength(1);
    expect(append.entries[0]).toMatchObject({
      selectedActionId: 'evaluate',
      verifiedReturn: 1,
      taskFamily: 'multi-file',
    });
  });

  it('rejects invalid experience distributions and illegal selections', async () => {
    const { service } = fixture();
    const base = {
      protocol: SEARCH_EXPERIENCE_PROTOCOL,
      sequence: 1,
      state: state(),
      legalActionIds: ['evaluate', 'commit'],
      visitDistribution: { evaluate: 0.5, commit: 0.25 },
      selectedActionId: 'evaluate',
      resultingEvidenceRefs: [],
      verifiedReturn: 0,
      cost: 0,
      terminalOutcome: 'incomplete',
      taskFamily: 'multi-file',
      repositorySplit: 'development' as const,
    };
    await expect(service.recordExperience(base)).rejects.toThrow('sum to 1');
    await expect(
      service.recordExperience({
        ...base,
        visitDistribution: { evaluate: 0.5, commit: 0.5 },
        selectedActionId: 'illegal',
      }),
    ).rejects.toThrow('not legal');
  });

  it('rejects duplicate action identities and non-finite features', async () => {
    const { service } = fixture();
    expect(() => service.estimate({
      ...state(),
      actions: [state().actions[0]!, state().actions[0]!],
    })).toThrow('Duplicate');
    expect(() => service.estimate({
      ...state(),
      actions: [{ ...state().actions[0]!, risk: Number.NaN }],
    })).toThrow('non-finite');
  });
});

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
