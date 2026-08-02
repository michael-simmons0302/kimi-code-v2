import { createHash } from 'node:crypto';

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import {
  ADAPTIVE_ARCHITECTURE_VERSION,
  ADAPTIVE_PROTOCOL_REGISTRY,
  createSearchDecisionId,
  createSearchEpisodeId,
  type AdaptiveBudget,
  type AdaptiveCost,
  type SearchNodeId,
} from '#/agent/adaptiveRuntime/adaptiveProtocol';
import {
  ISessionAdaptiveConfigService,
  type AdaptiveConfigSnapshot,
} from '#/agent/adaptiveRuntime/adaptiveConfigService';
import { IAgentAdaptiveRuntimeService } from '#/agent/adaptiveRuntime/adaptiveRuntime';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IWorldModelCalibrationService } from '#/agent/worldModel/worldModelCalibration';
import { ISessionEvaluationLedgerService } from '#/session/evaluationLedger/evaluationLedger';
import { ISessionSearchCheckpointService } from '#/session/searchCheckpoint/searchCheckpoint';
import { calibratedDiscoveryInformationGain } from './calibratedDiscovery';
import {
  decisionWeightedInformationGain,
  effectivePosteriorSampleSize,
  finiteEnsembleShrinkage,
  normalizedEpistemicInformationGain,
  temperDiscoveryWeights,
  type WeightedDistribution,
} from './entropy';
import { computeFrontierScore } from './epistemicFrontier';
import {
  IAgentSearchPolicyValueService,
  SEARCH_EXPERIENCE_PROTOCOL,
  type SearchPolicyActionEstimate,
  type SearchPolicyActionFeatures,
  type SearchPolicyStateFeatures,
} from './searchPolicyValue';
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

interface ParentReference {
  readonly parentNodeId: SearchNodeId;
  readonly actionId: string;
  readonly outcomeKey: string;
}

interface PersistedSearchState {
  readonly protocol: 'adaptive-search-state/1';
  readonly episodeId: ReturnType<typeof createSearchEpisodeId>;
  readonly rootNodeId?: SearchNodeId;
  readonly nodes: readonly SearchNode[];
  readonly parents: readonly [SearchNodeId, ParentReference][];
  readonly selectionCount: number;
  readonly bestObservedValue: number;
  readonly selectionsWithoutImprovement: number;
}

interface ActionMetrics {
  readonly expectedTaskProgress: number;
  readonly decisionWeightedInformationGain: number;
  readonly executionCost: number;
  readonly calibrationPenalty: number;
  readonly promotionEligible: boolean;
}

export class AgentTestTimeSearchService
  extends Disposable
  implements IAgentTestTimeSearchService
{
  declare readonly _serviceBrand: undefined;

  private readonly config: AdaptiveConfigSnapshot;
  private readonly readyPromise: Promise<void>;
  private readonly nodeMap = new Map<SearchNodeId, SearchNode>();
  private readonly parents = new Map<SearchNodeId, ParentReference>();
  private episodeId = createSearchEpisodeId();
  private rootNodeId: SearchNodeId | undefined;
  private selectionCount = 0;
  private bestObservedValue = Number.NEGATIVE_INFINITY;
  private selectionsWithoutImprovement = 0;
  private mutation: Promise<void> = Promise.resolve();
  private lastCheckpointSignature: string | undefined;

  constructor(
    @IAgentScopeContext _agent: IAgentScopeContext,
    @IAgentAdaptiveRuntimeService private readonly runtime: IAgentAdaptiveRuntimeService,
    @ISessionAdaptiveConfigService adaptiveConfig: ISessionAdaptiveConfigService,
    @IAgentSearchPolicyValueService private readonly policyValue: IAgentSearchPolicyValueService,
    @IWorldModelCalibrationService private readonly calibration: IWorldModelCalibrationService,
    @ISessionSearchCheckpointService private readonly checkpoints: ISessionSearchCheckpointService,
    @ISessionEvaluationLedgerService private readonly ledger: ISessionEvaluationLedgerService,
  ) {
    super();
    this.config = adaptiveConfig.snapshot();
    this.readyPromise = this.initialize();
  }

  ready(): Promise<void> {
    return this.readyPromise;
  }

  begin(state: SearchState): Promise<SearchNodeId> {
    return this.mutate(async () => {
      this.runtime.ensureRun();
      this.runtime.transition('planning', 'Belief-state search initialized.');
      this.resetForWorkspaceMismatch(state.workspaceSnapshotHash);
      const nodeId = stateId(state, this.config.config.search.budgetBucketPercent);
      if (!this.nodeMap.has(nodeId)) {
        this.ensureCapacity();
        this.nodeMap.set(nodeId, decisionNode(nodeId, state, 0));
      }
      this.rootNodeId = nodeId;
      await this.persist('search-root-updated');
      return nodeId;
    });
  }

  addActions(nodeId: SearchNodeId, actions: readonly SearchAction[]): Promise<void> {
    return this.mutate(async () => {
      const node = this.requireDecisionNode(nodeId);
      const existing = new Map(node.edges.map((edge) => [edge.action.actionId, edge]));
      const temperature = this.discoveryTemperature(node);
      const discoveryWeight = this.discoveryWeight(node);
      const candidates = actions
        .filter((action) => !existing.has(action.actionId))
        .sort((left, right) =>
          compareActionPriority(
            left,
            right,
            node.state,
            temperature,
            discoveryWeight,
            this.config,
            this.calibration,
          ),
        );
      const search = this.config.config.search;
      const allowed = Math.max(
        1,
        Math.ceil(
          search.progressiveWideningK *
          Math.pow(1 + node.visits, search.progressiveWideningAlpha),
        ),
      );
      const remaining = Math.max(0, allowed - existing.size);
      const selected = categoryBalanced(
        candidates,
        remaining,
        allowed,
        search.actionCategoryMaximumFraction,
      );
      const remainingBudget = this.remainingBudgetFraction(node.state);
      const edges = [
        ...node.edges,
        ...selected.map((action): SearchEdge => ({
          action,
          visits: 0,
          totalValue: 0,
          meanValue: 0,
          discoveryValue: frontierForAction(
            action,
            temperature,
            discoveryWeight,
            remainingBudget,
            search.discoveryBonusCapFraction,
            this.calibration,
          ).total,
          childNodeIds: {},
          outcomeProbabilities: predictedOutcomeProbabilities(
            action,
            search.maximumChanceOutcomes,
          ),
        })),
      ];
      this.nodeMap.set(nodeId, { ...node, edges });
      for (const action of selected) {
        await this.ledger.append({
          recordType: 'search.action.proposed',
          payload: { episodeId: this.episodeId, nodeId, action },
        });
      }
      await this.persist('search-actions-added');
    });
  }

  select(nodeId: SearchNodeId | undefined = this.rootNodeId): Promise<SearchSelection> {
    return this.mutate(async () => {
      if (nodeId === undefined) throw new Error('Search has no root node.');
      const node = this.requireDecisionNode(nodeId);
      if (node.edges.length === 0) throw new Error(`Search node has no actions: ${nodeId}`);
      const temperature = this.discoveryTemperature(node);
      const discoveryWeight = this.discoveryWeight(node);
      const policyState = this.policyState(node, temperature);
      const policy = this.policyValue.estimate(policyState);
      const actionEstimates = new Map(
        policy.actions.map((estimate) => [estimate.actionId, estimate]),
      );
      const ranked = node.edges.map((edge) => ({
        edge,
        score: puctScore(
          node,
          edge,
          actionEstimates.get(edge.action.actionId),
          temperature,
          discoveryWeight,
          this.remainingBudgetFraction(node.state),
          this.config,
          this.calibration,
        ),
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
        policyBackend: policy.backend,
        policyCheckpointHash: policy.checkpointHash,
      };
      this.selectionCount += 1;
      await this.ledger.append({
        recordType: 'search.action.selected',
        payload: {
          ...selection,
          discoveryWeight,
          policyStateValue: policy.stateValue,
          policyStateValueUncertainty: policy.stateValueUncertainty,
        },
      });
      await this.persist('search-action-selected');
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
      if (outcomeKey.length === 0) throw new Error('Observed search outcome key cannot be empty.');
      const node = this.requireDecisionNode(selection.nodeId);
      const edgeIndex = node.edges.findIndex(
        (edge) => edge.action.actionId === selection.action.actionId,
      );
      if (edgeIndex < 0) {
        throw new Error(`Search action is not present on node: ${selection.action.actionId}`);
      }
      const previous = node.edges[edgeIndex]!;
      const visits = previous.visits + 1;
      let childNodeId: SearchNodeId | undefined;
      let childNodeIds = previous.childNodeIds;
      if (nextState !== undefined && node.depth < this.config.config.search.maximumDepth) {
        childNodeId = stateId(nextState, this.config.config.search.budgetBucketPercent);
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
      const updatedNode: DecisionSearchNode = {
        ...node,
        visits: node.visits + 1,
        edges,
      };
      this.nodeMap.set(node.nodeId, updatedNode);
      this.backup(node.nodeId, value);
      if (value > this.bestObservedValue) {
        this.bestObservedValue = value;
        this.selectionsWithoutImprovement = 0;
      } else {
        this.selectionsWithoutImprovement += 1;
      }
      await this.policyValue.recordExperience({
        protocol: SEARCH_EXPERIENCE_PROTOCOL,
        sequence: this.selectionCount,
        state: this.policyState(node, selection.discoveryTemperature),
        legalActionIds: node.edges.map((edge) => edge.action.actionId),
        visitDistribution: visitDistribution(updatedNode.edges),
        selectedActionId: selection.action.actionId,
        resultingEvidenceRefs: evidenceRefsFromPayload(selection.action.payload),
        verifiedReturn: value,
        cost: rawActionCost(selection.action),
        terminalOutcome: outcomeKey,
        taskFamily: node.state.taskFamily ?? 'unknown',
        repositorySplit: node.state.repositorySplit ?? 'development',
      });
      await this.persist('search-outcome-observed');
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
    if (input.commitBlockingConflicts > 0) {
      reasons.push('Commit-blocking structural conflicts remain open.');
    }
    if (!input.actionStableAcrossModels) {
      reasons.push('Viable world models select materially different actions.');
    }
    if (!input.liveWorkspaceReconciled) {
      reasons.push('The live workspace has not been reconciled with the adaptive baseline.');
    }
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
    return [...this.nodeMap.values()].sort((left, right) =>
      left.nodeId.localeCompare(right.nodeId),
    );
  }

  invalidate(reason: string): Promise<void> {
    return this.mutate(async () => {
      if (reason.trim().length === 0) {
        throw new Error('Search invalidation reason cannot be empty.');
      }
      const previousEpisodeId = this.episodeId;
      const previousRootNodeId = this.rootNodeId;
      const previousNodeCount = this.nodeMap.size;
      this.nodeMap.clear();
      this.parents.clear();
      this.episodeId = createSearchEpisodeId();
      this.rootNodeId = undefined;
      this.selectionCount = 0;
      this.bestObservedValue = Number.NEGATIVE_INFINITY;
      this.selectionsWithoutImprovement = 0;
      this.lastCheckpointSignature = undefined;
      await this.ledger.append({
        recordType: 'search.state.invalidated',
        adaptiveRunId: this.runtime.runId(),
        payload: {
          reason,
          previousEpisodeId,
          previousRootNodeId,
          previousNodeCount,
          nextEpisodeId: this.episodeId,
        },
      });
      await this.persist(`search-invalidated:${reason}`, true);
    });
  }

  checkpoint(): Promise<void> {
    return this.mutate(async () => {
      const checkpoint = await this.persist('explicit-search-checkpoint', true);
      await this.policyValue.flush();
      await this.ledger.append({
        recordType: 'search.checkpoint.committed',
        payload: {
          checkpointId: checkpoint?.checkpointId,
          checkpointHash: checkpoint?.checkpointHash,
          episodeId: this.episodeId,
          rootNodeId: this.rootNodeId,
          nodeCount: this.nodeMap.size,
          selectionCount: this.selectionCount,
          configHash: this.config.hash,
          policyCheckpointHash: this.policyValue.activeCheckpoint()?.checkpointHash,
          calibrationHash: this.calibration.snapshot().hash,
        },
      });
    });
  }

  async flush(): Promise<void> {
    await this.readyPromise;
    await this.mutation;
    await Promise.all([
      this.checkpoints.flush(),
      this.policyValue.flush(),
      this.calibration.flush(),
      this.ledger.flush(),
    ]);
  }

  override dispose(): void {
    void this.flush();
    super.dispose();
  }

  private async initialize(): Promise<void> {
    await Promise.all([
      this.checkpoints.ready(),
      this.policyValue.ready(),
      this.calibration.ready(),
      this.ledger.ready(),
    ]);
    await this.restore();
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
      const edgeIndex = parentNode.edges.findIndex(
        (edge) => edge.action.actionId === parent.actionId,
      );
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
    const maximumNodes = this.config.config.search.maximumNodes;
    if (this.nodeMap.size >= maximumNodes) {
      throw new Error(`Search node budget exhausted at ${String(maximumNodes)} nodes.`);
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
    const recovery = await this.checkpoints.recover<PersistedSearchState>({
      architectureVersion: ADAPTIVE_ARCHITECTURE_VERSION,
      protocolVersions: ADAPTIVE_PROTOCOL_REGISTRY,
      configHash: this.config.hash,
    });
    const checkpoint = recovery.checkpoint;
    if (checkpoint === undefined) return;
    const persisted = checkpoint.state;
    if (persisted.protocol !== 'adaptive-search-state/1') {
      throw new Error(`Unsupported persisted search state: ${String(persisted.protocol)}`);
    }
    this.episodeId = persisted.episodeId;
    this.rootNodeId = persisted.rootNodeId;
    for (const node of persisted.nodes) this.nodeMap.set(node.nodeId, node);
    for (const [nodeId, parent] of persisted.parents) this.parents.set(nodeId, parent);
    this.selectionCount = persisted.selectionCount;
    this.bestObservedValue = persisted.bestObservedValue;
    this.selectionsWithoutImprovement = persisted.selectionsWithoutImprovement;
    this.lastCheckpointSignature = checkpointSignature(
      checkpoint.ledgerHeadHash,
      checkpoint.state,
    );
  }

  private async persist(
    reason: string,
    force = false,
  ): Promise<ReturnType<ISessionSearchCheckpointService['latest']>> {
    const ledgerHead = this.ledger.head();
    if (ledgerHead.recordHash === null) {
      throw new Error('Search state cannot checkpoint before the evidence ledger has a head.');
    }
    const state: PersistedSearchState = {
      protocol: 'adaptive-search-state/1',
      episodeId: this.episodeId,
      rootNodeId: this.rootNodeId,
      nodes: this.nodes(),
      parents: [...this.parents.entries()],
      selectionCount: this.selectionCount,
      bestObservedValue: this.bestObservedValue,
      selectionsWithoutImprovement: this.selectionsWithoutImprovement,
    };
    const signature = checkpointSignature(ledgerHead.recordHash, state);
    if (!force && signature === this.lastCheckpointSignature) {
      return this.checkpoints.latest();
    }
    const root = this.root();
    const checkpoint = await this.checkpoints.commit({
      ledgerHeadHash: ledgerHead.recordHash,
      createdAtSequence: ledgerHead.sequence,
      architectureVersion: ADAPTIVE_ARCHITECTURE_VERSION,
      protocolVersions: ADAPTIVE_PROTOCOL_REGISTRY,
      configHash: this.config.hash,
      workspaceSnapshotHash: root?.state.workspaceSnapshotHash,
      state,
      budget: this.config.config.budget,
      cost: root === undefined
        ? emptyCost()
        : costFromRemaining(root.state.remainingBudget, this.config.config.budget),
      randomStates: [{
        generatorId: 'search-selection-sequence',
        state: String(this.selectionCount),
      }],
      activeEvaluators: [],
      frontierTemperature:
        root?.kind === 'decision'
          ? this.discoveryTemperature(root)
          : this.config.config.search.defaultDiscoveryTemperature,
      transpositions: {
        entries: this.nodeMap.size,
        hits: 0,
        evictions: 0,
        hash: createHash('sha256').update(canonicalJson(this.nodes())).digest('hex'),
      },
      reason,
    });
    this.lastCheckpointSignature = signature;
    return checkpoint;
  }

  private resetForWorkspaceMismatch(workspaceSnapshotHash: string): void {
    const restored = this.root();
    if (
      restored === undefined ||
      restored.state.workspaceSnapshotHash === workspaceSnapshotHash
    ) {
      return;
    }
    this.nodeMap.clear();
    this.parents.clear();
    this.episodeId = createSearchEpisodeId();
    this.rootNodeId = undefined;
    this.selectionCount = 0;
    this.bestObservedValue = Number.NEGATIVE_INFINITY;
    this.selectionsWithoutImprovement = 0;
    this.lastCheckpointSignature = undefined;
  }

  private remainingBudgetFraction(state: SearchState): number {
    return remainingBudgetFraction(state.remainingBudget, this.config.config.budget);
  }

  private discoveryTemperature(node: DecisionSearchNode): number {
    const search = this.config.config.search;
    const entropy = clamp01(node.state.normalizedPosteriorEntropy ?? 0);
    const stagnation = clamp01(this.selectionsWithoutImprovement / 6);
    const remaining = this.remainingBudgetFraction(node.state);
    let temperature =
      search.defaultDiscoveryTemperature +
      (search.maximumDiscoveryTemperature - search.defaultDiscoveryTemperature) *
        (0.55 * entropy + 0.45 * stagnation);
    if (remaining < 0.2) {
      const pressure = 1 - remaining / 0.2;
      temperature -=
        (search.defaultDiscoveryTemperature - search.minimumDiscoveryTemperature) * pressure;
    }
    return clamp(
      temperature,
      search.minimumDiscoveryTemperature,
      search.maximumDiscoveryTemperature,
    );
  }

  private discoveryWeight(node: DecisionSearchNode): number {
    const search = this.config.config.search;
    const entropy = clamp01(node.state.normalizedPosteriorEntropy ?? 0);
    const stagnation = clamp01(this.selectionsWithoutImprovement / 6);
    const remaining = this.remainingBudgetFraction(node.state);
    let weight =
      search.initialDiscoveryWeight +
      (search.maximumDiscoveryWeight - search.initialDiscoveryWeight) *
        (0.6 * entropy + 0.4 * stagnation);
    if (remaining < 0.25) {
      const pressure = 1 - remaining / 0.25;
      weight -= (weight - search.minimumDiscoveryWeight) * pressure;
    }
    return clamp(
      weight,
      search.minimumDiscoveryWeight,
      search.maximumDiscoveryWeight,
    );
  }

  private policyState(
    node: DecisionSearchNode,
    temperature: number,
  ): SearchPolicyStateFeatures {
    const remainingBudget = this.remainingBudgetFraction(node.state);
    const actions = node.edges.map((edge): SearchPolicyActionFeatures => {
      const metrics = actionMetrics(edge.action, temperature, this.calibration);
      return {
        actionId: edge.action.actionId,
        category: edge.action.kind,
        deterministicPrior: clamp01(edge.action.prior),
        expectedTaskProgress: metrics.expectedTaskProgress,
        conflictUrgency: edge.action.hardGate === true
          ? 1
          : clamp01((node.state.openConflictCount ?? 0) / 4),
        decisionWeightedInformationGain: metrics.decisionWeightedInformationGain,
        generalizationLeverage: clamp01(edge.action.generalizationLeverage),
        cost: metrics.executionCost,
        risk: clamp01(edge.action.executionRisk),
        redundancy: clamp01(edge.action.redundancyPenalty),
      };
    });
    return {
      stateHash: node.nodeId,
      remainingBudgetFraction: remainingBudget,
      normalizedPosteriorEntropy: clamp01(node.state.normalizedPosteriorEntropy ?? 0),
      openConflicts: Math.max(0, node.state.openConflictCount ?? 0),
      viableModels: Math.max(0, node.state.viableModelCount ?? 0),
      verifiedCandidates: node.state.verifiedCandidateIds.length,
      actions,
    };
  }
}

function decisionNode(
  nodeId: SearchNodeId,
  state: SearchState,
  depth: number,
): DecisionSearchNode {
  return { kind: 'decision', nodeId, state, depth, visits: 0, edges: [], terminal: false };
}

function stateId(state: SearchState, budgetBucketPercent: number): SearchNodeId {
  const budgetBucket = budgetBucketFor(state, budgetBucketPercent);
  return createHash('sha256')
    .update(canonicalJson({ ...state, remainingBudget: undefined, budgetBucket }))
    .digest('hex') as SearchNodeId;
}

function budgetBucketFor(
  state: SearchState,
  bucketPercent: number,
): Readonly<Record<string, number>> {
  const divisor = Math.max(1, bucketPercent);
  return Object.fromEntries(
    Object.entries(state.remainingBudget).map(([key, value]) => {
      const normalized = Number.isFinite(value) && value > 0
        ? Math.floor(Math.log1p(value) * 100 / divisor)
        : 0;
      return [key, normalized];
    }),
  );
}

function puctScore(
  node: DecisionSearchNode,
  edge: SearchEdge,
  estimate: SearchPolicyActionEstimate | undefined,
  temperature: number,
  discoveryWeight: number,
  remainingBudget: number,
  config: AdaptiveConfigSnapshot,
  calibration: IWorldModelCalibrationService,
): number {
  const expectedTaskProgress = edge.action.expectedTaskValue + 0.3 * edge.action.expectedProgress;
  const exploitation = edge.visits > 0
    ? edge.meanValue
    : estimate?.value ?? expectedTaskProgress;
  const prior = estimate?.prior ?? clamp01(edge.action.prior);
  const exploration =
    config.config.search.cPuct * prior * Math.sqrt(1 + node.visits) / (1 + edge.visits);
  const frontier = frontierForAction(
    edge.action,
    temperature,
    discoveryWeight,
    remainingBudget,
    config.config.search.discoveryBonusCapFraction,
    calibration,
  );
  return exploitation + exploration + frontier.total - expectedTaskProgress;
}

function frontierForAction(
  action: SearchAction,
  temperature: number,
  discoveryWeight: number,
  remainingBudgetFractionValue: number,
  discoveryBonusCapFraction: number,
  calibration: IWorldModelCalibrationService,
) {
  const metrics = actionMetrics(action, temperature, calibration);
  return computeFrontierScore({
    expectedTaskProgress: metrics.expectedTaskProgress,
    decisionWeightedInformationGain: metrics.decisionWeightedInformationGain,
    generalizationLeverage: action.generalizationLeverage,
    executionCost: metrics.executionCost,
    executionRisk: action.executionRisk,
    redundancyPenalty: action.redundancyPenalty,
    calibrationPenalty: metrics.calibrationPenalty,
    remainingBudgetFraction: remainingBudgetFractionValue,
    discoveryWeight,
    discoveryBonusCapFraction,
  });
}

function actionMetrics(
  action: SearchAction,
  temperature: number,
  calibration: IWorldModelCalibrationService,
): ActionMetrics {
  const expectedTaskProgress = finite(action.expectedTaskValue + 0.3 * action.expectedProgress);
  const predictions = action.predictions;
  let information = 0;
  let calibrationPenalty = 1 - clamp01(action.calibrationFactor);
  let promotionEligible = true;
  if (predictions !== undefined && predictions.length >= 2) {
    const tempered = temperDiscoveryWeights(
      predictions.map((prediction) => prediction.modelWeight),
      temperature,
    );
    const distributions: WeightedDistribution<string>[] = predictions.map(
      (prediction, index) => ({
        weight: tempered[index] ?? 0,
        distribution: new Map(Object.entries(prediction.distribution)),
      }),
    );
    const effectiveSampleSize = effectivePosteriorSampleSize(tempered);
    const rawInformation = finiteEnsembleShrinkage(
      normalizedEpistemicInformationGain(distributions),
      effectiveSampleSize,
    );
    const decisionWeighted = decisionWeightedInformationGain(
      rawInformation,
      action.decisionSensitivity,
    );
    const calibratable = predictions.every(
      (prediction) =>
        prediction.evaluatorFamily !== undefined &&
        prediction.modelLineage !== undefined,
    );
    if (calibratable) {
      const calibrated = calibratedDiscoveryInformationGain(
        predictions.map((prediction) => ({
          evaluatorFamily: prediction.evaluatorFamily as string,
          modelLineage: prediction.modelLineage as string,
          posteriorWeight: prediction.modelWeight,
          informationGain: decisionWeighted,
          effectiveSampleSize: prediction.effectiveSampleSize ?? effectiveSampleSize,
        })),
        calibration,
      );
      information = calibrated.informationGain;
      promotionEligible = calibrated.promotionEligible;
      calibrationPenalty = decisionWeighted <= 0
        ? 0
        : clamp01(1 - information / decisionWeighted);
    } else {
      information = decisionWeighted * clamp01(action.calibrationFactor);
    }
  }
  return {
    expectedTaskProgress,
    decisionWeightedInformationGain: Math.max(0, information),
    executionCost: normalizedActionCost(action),
    calibrationPenalty,
    promotionEligible,
  };
}

function predictedOutcomeProbabilities(
  action: SearchAction,
  maximumOutcomes: number,
): Readonly<Record<string, number>> {
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
      result[outcome] =
        (result[outcome] ?? 0) + weight * Math.max(0, probability) / distributionTotal;
    }
  });
  const ranked = Object.entries(result).sort(
    ([leftKey, left], [rightKey, right]) => right - left || leftKey.localeCompare(rightKey),
  );
  if (ranked.length <= maximumOutcomes) return Object.fromEntries(ranked);
  const retained = ranked.slice(0, Math.max(1, maximumOutcomes - 1));
  const other = ranked.slice(retained.length).reduce((sum, [, value]) => sum + value, 0);
  return Object.fromEntries([...retained, ['__other__', other]]);
}

function compareActionPriority(
  left: SearchAction,
  right: SearchAction,
  state: SearchState,
  temperature: number,
  discoveryWeight: number,
  config: AdaptiveConfigSnapshot,
  calibration: IWorldModelCalibrationService,
): number {
  const remaining = remainingBudgetFraction(state.remainingBudget, config.config.budget);
  return (
    Number(right.hardGate === true) - Number(left.hardGate === true) ||
    frontierForAction(
      right,
      temperature,
      discoveryWeight,
      remaining,
      config.config.search.discoveryBonusCapFraction,
      calibration,
    ).total -
      frontierForAction(
        left,
        temperature,
        discoveryWeight,
        remaining,
        config.config.search.discoveryBonusCapFraction,
        calibration,
      ).total ||
    left.actionId.localeCompare(right.actionId)
  );
}

function categoryBalanced(
  actions: readonly SearchAction[],
  count: number,
  totalLimit: number,
  maximumFraction: number,
): readonly SearchAction[] {
  if (count <= 0) return [];
  const selected: SearchAction[] = [];
  const categoryCounts = new Map<string, number>();
  const maximumPerCategory = Math.max(1, Math.ceil(totalLimit * maximumFraction));
  for (const action of actions.filter((candidate) => candidate.hardGate === true)) {
    if (selected.length >= count) break;
    selected.push(action);
    categoryCounts.set(action.kind, (categoryCounts.get(action.kind) ?? 0) + 1);
  }
  for (const action of actions) {
    if (selected.length >= count) break;
    if (selected.includes(action)) continue;
    const current = categoryCounts.get(action.kind) ?? 0;
    if (current >= maximumPerCategory) continue;
    selected.push(action);
    categoryCounts.set(action.kind, current + 1);
  }
  return selected;
}

function remainingBudgetFraction(
  remaining: AdaptiveBudget,
  configured: AdaptiveBudget,
): number {
  const keys = Object.keys(configured) as (keyof AdaptiveBudget)[];
  const fractions = keys.map((key) => {
    const maximum = configured[key];
    const value = remaining[key];
    if (!Number.isFinite(maximum) || maximum <= 0) return 0;
    return clamp01(value / maximum);
  });
  return fractions.length === 0 ? 0 : Math.min(...fractions);
}

function costFromRemaining(
  remaining: AdaptiveBudget,
  configured: AdaptiveBudget,
): AdaptiveCost {
  return {
    internalRequests: spent(configured.maxInternalRequests, remaining.maxInternalRequests),
    evaluations: spent(configured.maxEvaluations, remaining.maxEvaluations),
    stochasticReplicates: spent(
      configured.maxStochasticReplicates,
      remaining.maxStochasticReplicates,
    ),
    toolCalls: spent(configured.maxToolCalls, remaining.maxToolCalls),
    inputTokens: spent(configured.maxInputTokens, remaining.maxInputTokens),
    outputTokens: spent(configured.maxOutputTokens, remaining.maxOutputTokens),
    wallMs: spent(configured.maxWallMs, remaining.maxWallMs),
    cpuMs: spent(configured.maxCpuMs, remaining.maxCpuMs),
    diskBytes: spent(configured.maxDiskBytes, remaining.maxDiskBytes),
  };
}

function spent(configured: number, remaining: number): number {
  return Math.max(0, configured - remaining);
}

function emptyCost(): AdaptiveCost {
  return {
    internalRequests: 0,
    evaluations: 0,
    stochasticReplicates: 0,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    wallMs: 0,
    cpuMs: 0,
    diskBytes: 0,
  };
}

function checkpointSignature(ledgerHeadHash: string, state: PersistedSearchState): string {
  return createHash('sha256')
    .update(ledgerHeadHash)
    .update('\u0000')
    .update(canonicalJson(state))
    .digest('hex');
}

function visitDistribution(edges: readonly SearchEdge[]): Readonly<Record<string, number>> {
  const total = edges.reduce((sum, edge) => sum + edge.visits, 0);
  if (total <= 0) {
    const uniform = edges.length === 0 ? 0 : 1 / edges.length;
    return Object.fromEntries(edges.map((edge) => [edge.action.actionId, uniform]));
  }
  return Object.fromEntries(
    edges.map((edge) => [edge.action.actionId, edge.visits / total]),
  );
}

function evidenceRefsFromPayload(payload: unknown): readonly string[] {
  if (payload === null || typeof payload !== 'object') return [];
  const value = (payload as { readonly evidenceRefs?: unknown }).evidenceRefs;
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === 'string'))];
}

function rawActionCost(action: SearchAction): number {
  return Math.max(0, finite(action.wallCost)) +
    Math.max(0, finite(action.tokenCost)) +
    Math.max(0, finite(action.toolCost));
}

function normalizedActionCost(action: SearchAction): number {
  return (
    normalizedCost(action.wallCost) +
    normalizedCost(action.tokenCost) +
    normalizedCost(action.toolCost)
  ) / 3;
}

function normalizedCost(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value / (1 + value);
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.max(minimum, Math.min(maximum, value));
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
