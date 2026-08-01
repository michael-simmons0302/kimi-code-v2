import { createHash } from 'node:crypto';

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import {
  createSearchDecisionId,
  createSearchEpisodeId,
  type SearchNodeId,
} from '#/agent/adaptiveRuntime/adaptiveProtocol';
import { IAgentAdaptiveRuntimeService } from '#/agent/adaptiveRuntime/adaptiveRuntime';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { ISessionEvaluationLedgerService } from '#/session/evaluationLedger/evaluationLedger';
import {
  decisionWeightedInformationGain,
  effectivePosteriorSampleSize,
  finiteEnsembleShrinkage,
  normalizedEpistemicInformationGain,
  temperDiscoveryWeights,
  type WeightedDistribution,
} from './entropy';
import {
  IAgentTestTimeSearchService,
  type DecisionSearchNode,
  type SearchAction,
  type SearchCommitAssessment,
  type SearchEdge,
  type SearchNode,
  type SearchSelection,
  type SearchState,
} from './testTimeSearch';

const CHECKPOINT_KEY = 'search-checkpoint.json';
const MAX_NODES = 512;
const MAX_DEPTH = 16;
const C_PUCT = 1.5;

interface ParentReference {
  readonly parentNodeId: SearchNodeId;
  readonly actionId: string;
  readonly outcomeKey: string;
}

interface PersistedSearchState {
  readonly protocol: 'adaptive-search-checkpoint/1';
  readonly episodeId?: ReturnType<typeof createSearchEpisodeId>;
  readonly rootNodeId?: SearchNodeId;
  readonly nodes: readonly SearchNode[];
  readonly parents: readonly [SearchNodeId, ParentReference][];
  readonly selectionCount: number;
  readonly bestObservedValue: number;
  readonly selectionsWithoutImprovement: number;
}

export class AgentTestTimeSearchService
  extends Disposable
  implements IAgentTestTimeSearchService
{
  declare readonly _serviceBrand: undefined;

  private readonly scope: string;
  private readonly readyPromise: Promise<void>;
  private readonly nodeMap = new Map<SearchNodeId, SearchNode>();
  private readonly parents = new Map<SearchNodeId, ParentReference>();
  private episodeId = createSearchEpisodeId();
  private rootNodeId: SearchNodeId | undefined;
  private selectionCount = 0;
  private bestObservedValue = Number.NEGATIVE_INFINITY;
  private selectionsWithoutImprovement = 0;
  private mutation: Promise<void> = Promise.resolve();

  constructor(
    @IAgentScopeContext agent: IAgentScopeContext,
    @IAgentAdaptiveRuntimeService private readonly runtime: IAgentAdaptiveRuntimeService,
    @IAtomicDocumentStore private readonly documents: IAtomicDocumentStore,
    @ISessionEvaluationLedgerService private readonly ledger: ISessionEvaluationLedgerService,
  ) {
    super();
    this.scope = agent.scope('adaptive');
    this._register(this.documents.acquire(this.scope, CHECKPOINT_KEY));
    this.readyPromise = this.restore();
  }

  ready(): Promise<void> {
    return this.readyPromise;
  }

  begin(state: SearchState): Promise<SearchNodeId> {
    return this.mutate(async () => {
      this.runtime.ensureRun();
      this.runtime.transition('planning', 'Belief-state search initialized.');
      const nodeId = stateId(state);
      if (!this.nodeMap.has(nodeId)) {
        this.ensureCapacity();
        this.nodeMap.set(nodeId, decisionNode(nodeId, state, 0));
      }
      this.rootNodeId = nodeId;
      await this.persist();
      return nodeId;
    });
  }

  addActions(nodeId: SearchNodeId, actions: readonly SearchAction[]): Promise<void> {
    return this.mutate(async () => {
      const node = this.requireDecisionNode(nodeId);
      const existing = new Map(node.edges.map((edge) => [edge.action.actionId, edge]));
      const candidates = actions
        .filter((action) => !existing.has(action.actionId))
        .sort(compareActionPriority);
      const allowed = Math.max(6, Math.ceil(2 * Math.sqrt(1 + node.visits)));
      const remaining = Math.max(0, allowed - existing.size);
      const selected = categoryBalanced(candidates, remaining, allowed);
      const edges = [
        ...node.edges,
        ...selected.map((action): SearchEdge => ({
          action,
          visits: 0,
          totalValue: 0,
          meanValue: 0,
          discoveryValue: discoveryValue(action, 0.75),
          childNodeIds: {},
          outcomeProbabilities: predictedOutcomeProbabilities(action),
        })),
      ];
      this.nodeMap.set(nodeId, { ...node, edges });
      await this.persist();
      for (const action of selected) {
        await this.ledger.append({
          recordType: 'search.action.proposed',
          payload: { episodeId: this.episodeId, nodeId, action },
        });
      }
    });
  }

  select(nodeId: SearchNodeId | undefined = this.rootNodeId): Promise<SearchSelection> {
    return this.mutate(async () => {
      if (nodeId === undefined) throw new Error('Search has no root node.');
      const node = this.requireDecisionNode(nodeId);
      if (node.edges.length === 0) throw new Error(`Search node has no actions: ${nodeId}`);
      const disagreement = node.edges.some((edge) => (edge.action.predictions?.length ?? 0) >= 2);
      const temperature = disagreement
        ? this.selectionsWithoutImprovement >= 4
          ? 0.5
          : 0.75
        : 1;
      const ranked = node.edges.map((edge) => ({
        edge,
        score: puctScore(node, edge, temperature),
      })).sort((left, right) =>
        right.score - left.score || left.edge.action.actionId.localeCompare(right.edge.action.actionId),
      );
      const winner = ranked[0]!;
      const selection: SearchSelection = {
        decisionId: createSearchDecisionId(),
        episodeId: this.episodeId,
        nodeId,
        action: winner.edge.action,
        score: winner.score,
        discoveryTemperature: temperature,
      };
      this.selectionCount += 1;
      await this.ledger.append({ recordType: 'search.action.selected', payload: selection });
      await this.persist();
      return selection;
    });
  }

  observe(
    selection: SearchSelection,
    outcomeKey: string,
    value: number,
    nextState?: SearchState,
  ): Promise<SearchNodeId | undefined> {
    return this.mutate(async () => {
      if (!Number.isFinite(value)) throw new Error('Observed search value must be finite.');
      const node = this.requireDecisionNode(selection.nodeId);
      const edgeIndex = node.edges.findIndex((edge) => edge.action.actionId === selection.action.actionId);
      if (edgeIndex < 0) throw new Error(`Search action is not present on node: ${selection.action.actionId}`);
      const previous = node.edges[edgeIndex]!;
      const visits = previous.visits + 1;
      let childNodeId: SearchNodeId | undefined;
      let childNodeIds = previous.childNodeIds;
      if (nextState !== undefined && node.depth < MAX_DEPTH) {
        childNodeId = stateId(nextState);
        if (!this.nodeMap.has(childNodeId)) {
          this.ensureCapacity();
          this.nodeMap.set(childNodeId, decisionNode(childNodeId, nextState, node.depth + 1));
        }
        childNodeIds = { ...childNodeIds, [outcomeKey]: childNodeId };
        this.parents.set(childNodeId, {
          parentNodeId: node.nodeId,
          actionId: selection.action.actionId,
          outcomeKey,
        });
      }
      const updatedEdge: SearchEdge = {
        ...previous,
        visits,
        totalValue: previous.totalValue + value,
        meanValue: (previous.totalValue + value) / visits,
        childNodeIds,
      };
      const edges = [...node.edges];
      edges[edgeIndex] = updatedEdge;
      this.nodeMap.set(node.nodeId, { ...node, visits: node.visits + 1, edges });
      this.backup(node.nodeId, value);
      if (value > this.bestObservedValue) {
        this.bestObservedValue = value;
        this.selectionsWithoutImprovement = 0;
      } else {
        this.selectionsWithoutImprovement += 1;
      }
      await this.persist();
      return childNodeId;
    });
  }

  assessCommit(input: {
    readonly hardGatesPass: boolean;
    readonly commitBlockingConflicts: number;
    readonly actionStableAcrossModels: boolean;
    readonly expectedAdditionalInformationValue: number;
    readonly expectedAdditionalCost: number;
    readonly liveWorkspaceReconciled: boolean;
    readonly claimsSupported: boolean;
  }): SearchCommitAssessment {
    const reasons: string[] = [];
    if (!input.hardGatesPass) reasons.push('Required hard gates have not passed.');
    if (input.commitBlockingConflicts > 0) reasons.push('Commit-blocking structural conflicts remain open.');
    if (!input.actionStableAcrossModels) reasons.push('Viable world models select materially different actions.');
    if (!input.liveWorkspaceReconciled) reasons.push('The live workspace has not been reconciled with the adaptive baseline.');
    if (!input.claimsSupported) reasons.push('The final response contains unsupported claims.');
    if (input.expectedAdditionalInformationValue > input.expectedAdditionalCost) {
      reasons.push('Another evaluation has positive expected net information value.');
    }
    return {
      eligible: reasons.length === 0,
      reasons,
      expectedAdditionalInformationValue: input.expectedAdditionalInformationValue,
      expectedAdditionalCost: input.expectedAdditionalCost,
    };
  }

  root(): SearchNode | undefined {
    return this.rootNodeId === undefined ? undefined : this.nodeMap.get(this.rootNodeId);
  }

  node(nodeId: SearchNodeId): SearchNode | undefined {
    return this.nodeMap.get(nodeId);
  }

  nodes(): readonly SearchNode[] {
    return [...this.nodeMap.values()].sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  }

  checkpoint(): Promise<void> {
    return this.mutate(async () => {
      await this.persist();
      await this.ledger.append({
        recordType: 'search.checkpoint.committed',
        payload: {
          episodeId: this.episodeId,
          rootNodeId: this.rootNodeId,
          nodeCount: this.nodeMap.size,
          selectionCount: this.selectionCount,
        },
      });
    });
  }

  async flush(): Promise<void> {
    await this.readyPromise;
    await this.mutation;
  }

  override dispose(): void {
    void this.flush();
    super.dispose();
  }

  private requireDecisionNode(nodeId: SearchNodeId): DecisionSearchNode {
    const node = this.nodeMap.get(nodeId);
    if (node === undefined) throw new Error(`Unknown search node: ${nodeId}`);
    if (node.kind !== 'decision') throw new Error(`Search node is terminal: ${nodeId}`);
    return node;
  }

  private backup(startNodeId: SearchNodeId, value: number): void {
    let currentId: SearchNodeId | undefined = startNodeId;
    const visited = new Set<SearchNodeId>();
    while (currentId !== undefined && !visited.has(currentId)) {
      visited.add(currentId);
      const parent = this.parents.get(currentId);
      if (parent === undefined) break;
      const parentNode = this.requireDecisionNode(parent.parentNodeId);
      const edgeIndex = parentNode.edges.findIndex((edge) => edge.action.actionId === parent.actionId);
      if (edgeIndex < 0) break;
      const edge = parentNode.edges[edgeIndex]!;
      const visits = edge.visits + 1;
      const edges = [...parentNode.edges];
      edges[edgeIndex] = {
        ...edge,
        visits,
        totalValue: edge.totalValue + value,
        meanValue: (edge.totalValue + value) / visits,
      };
      this.nodeMap.set(parentNode.nodeId, {
        ...parentNode,
        visits: parentNode.visits + 1,
        edges,
      });
      currentId = parentNode.nodeId;
    }
  }

  private ensureCapacity(): void {
    if (this.nodeMap.size >= MAX_NODES) {
      throw new Error(`Search node budget exhausted at ${MAX_NODES} nodes.`);
    }
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    let resolveResult!: (value: T) => void;
    let rejectResult!: (error: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    this.mutation = this.mutation
      .then(async () => {
        await this.readyPromise;
        resolveResult(await operation());
      })
      .catch(rejectResult);
    return result;
  }

  private async restore(): Promise<void> {
    const persisted = await this.documents.get<PersistedSearchState>(this.scope, CHECKPOINT_KEY);
    if (persisted?.protocol !== 'adaptive-search-checkpoint/1') return;
    this.episodeId = persisted.episodeId ?? createSearchEpisodeId();
    this.rootNodeId = persisted.rootNodeId;
    for (const node of persisted.nodes) this.nodeMap.set(node.nodeId, node);
    for (const [nodeId, parent] of persisted.parents) this.parents.set(nodeId, parent);
    this.selectionCount = persisted.selectionCount;
    this.bestObservedValue = persisted.bestObservedValue;
    this.selectionsWithoutImprovement = persisted.selectionsWithoutImprovement;
  }

  private persist(): Promise<void> {
    const payload: PersistedSearchState = {
      protocol: 'adaptive-search-checkpoint/1',
      episodeId: this.episodeId,
      rootNodeId: this.rootNodeId,
      nodes: this.nodes(),
      parents: [...this.parents.entries()],
      selectionCount: this.selectionCount,
      bestObservedValue: this.bestObservedValue,
      selectionsWithoutImprovement: this.selectionsWithoutImprovement,
    };
    return this.documents.set(this.scope, CHECKPOINT_KEY, payload);
  }
}

function decisionNode(nodeId: SearchNodeId, state: SearchState, depth: number): DecisionSearchNode {
  return { kind: 'decision', nodeId, state, depth, visits: 0, edges: [], terminal: false };
}

function stateId(state: SearchState): SearchNodeId {
  const budgetBucket = budgetBucketFor(state);
  return createHash('sha256')
    .update(canonicalJson({ ...state, remainingBudget: undefined, budgetBucket }))
    .digest('hex') as SearchNodeId;
}

function budgetBucketFor(state: SearchState): number {
  const values = Object.values(state.remainingBudget).filter(
    (value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0,
  );
  if (values.length === 0) return 0;
  const magnitude = Math.log10(Math.max(...values));
  return Math.max(0, Math.min(50, Math.floor(magnitude * 5)));
}

function puctScore(node: DecisionSearchNode, edge: SearchEdge, temperature: number): number {
  const exploitation = edge.visits > 0
    ? edge.meanValue
    : edge.action.expectedTaskValue + 0.3 * edge.action.expectedProgress;
  const exploration = C_PUCT * Math.max(0, edge.action.prior) * Math.sqrt(1 + node.visits) / (1 + edge.visits);
  const discovery = discoveryValue(edge.action, temperature);
  return exploitation + exploration + discovery;
}

function discoveryValue(action: SearchAction, temperature: number): number {
  const predictions = action.predictions;
  let information = 0;
  if (predictions !== undefined && predictions.length >= 2) {
    const tempered = temperDiscoveryWeights(
      predictions.map((prediction) => prediction.modelWeight),
      temperature,
    );
    const distributions: WeightedDistribution<string>[] = predictions.map((prediction, index) => ({
      weight: tempered[index] ?? 0,
      distribution: new Map(Object.entries(prediction.distribution)),
    }));
    const raw = normalizedEpistemicInformationGain(distributions);
    information = finiteEnsembleShrinkage(
      raw,
      effectivePosteriorSampleSize(tempered),
    );
  }
  const decisionWeighted = decisionWeightedInformationGain(
    information,
    action.decisionSensitivity,
  );
  const discoveryBonus = Math.min(
    0.3,
    0.3 * decisionWeighted * clamp01(action.generalizationLeverage) * clamp01(action.calibrationFactor),
  );
  return (
    discoveryBonus -
    0.1 * normalizedCost(action.wallCost) -
    0.1 * normalizedCost(action.tokenCost) -
    0.05 * normalizedCost(action.toolCost) -
    0.25 * clamp01(action.executionRisk) -
    0.05 * clamp01(action.redundancyPenalty)
  );
}

function predictedOutcomeProbabilities(action: SearchAction): Readonly<Record<string, number>> {
  if (action.predictions === undefined || action.predictions.length === 0) return {};
  const result: Record<string, number> = {};
  const weights = action.predictions.map((prediction) => Math.max(0, prediction.modelWeight));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0) || 1;
  action.predictions.forEach((prediction, index) => {
    const weight = (weights[index] ?? 0) / totalWeight;
    const distributionTotal = Object.values(prediction.distribution).reduce(
      (sum, probability) => sum + Math.max(0, probability),
      0,
    ) || 1;
    for (const [outcome, probability] of Object.entries(prediction.distribution)) {
      result[outcome] = (result[outcome] ?? 0) + weight * Math.max(0, probability) / distributionTotal;
    }
  });
  return result;
}

function compareActionPriority(left: SearchAction, right: SearchAction): number {
  return (
    Number(right.hardGate === true) - Number(left.hardGate === true) ||
    preliminaryValue(right) - preliminaryValue(left) ||
    left.actionId.localeCompare(right.actionId)
  );
}

function preliminaryValue(action: SearchAction): number {
  return action.expectedTaskValue + 0.3 * action.expectedProgress + discoveryValue(action, 0.75);
}

function categoryBalanced(
  actions: readonly SearchAction[],
  count: number,
  totalLimit: number,
): readonly SearchAction[] {
  if (count <= 0) return [];
  const selected: SearchAction[] = [];
  const categoryCounts = new Map<string, number>();
  for (const action of actions) {
    if (selected.length >= count) break;
    const current = categoryCounts.get(action.kind) ?? 0;
    if (current + 1 > Math.ceil(totalLimit / 2)) continue;
    selected.push(action);
    categoryCounts.set(action.kind, current + 1);
  }
  return selected;
}

function normalizedCost(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value / (1 + value);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
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
  IAgentTestTimeSearchService,
  AgentTestTimeSearchService,
  ScopeActivation.OnScopeCreated,
  'testTimeSearch',
);
