import { createDecorator } from '#/_base/di/instantiation';
import type {
  AdaptiveBudget,
  SearchDecisionId,
  SearchEpisodeId,
  SearchNodeId,
} from '#/agent/adaptiveRuntime/adaptiveProtocol';
import type { CandidateId } from '#/agent/adaptiveRuntime/adaptiveProtocol';

export type SearchActionKind =
  | 'inspect-structure'
  | 'run-evaluation'
  | 'run-replicate'
  | 'construct-intervention'
  | 'propose-task-patch'
  | 'evaluate-task-patch'
  | 'revise-world-model'
  | 'expand-world-model-population'
  | 'simulate-task-action'
  | 'execute-task-action'
  | 'commit-solution';

export interface SearchOutcomePrediction {
  readonly candidateId: CandidateId;
  readonly modelWeight: number;
  readonly distribution: Readonly<Record<string, number>>;
  readonly evaluatorFamily?: string;
  readonly modelLineage?: string;
  readonly effectiveSampleSize?: number;
}

export interface SearchAction {
  readonly actionId: string;
  readonly kind: SearchActionKind;
  readonly description: string;
  readonly payload: unknown;
  readonly prior: number;
  readonly expectedTaskValue: number;
  readonly expectedProgress: number;
  readonly generalizationLeverage: number;
  readonly decisionSensitivity: number;
  readonly calibrationFactor: number;
  readonly wallCost: number;
  readonly tokenCost: number;
  readonly toolCost: number;
  readonly executionRisk: number;
  readonly redundancyPenalty: number;
  readonly hardGate?: boolean;
  readonly predictions?: readonly SearchOutcomePrediction[];
}

export interface SearchState {
  readonly workspaceSnapshotHash: string;
  readonly beliefStateHash: string;
  readonly causalRuleGraphHash: string;
  readonly structureIndexHash: string;
  readonly unresolvedConflictHash: string;
  readonly trajectorySummaryHash: string;
  readonly verifiedCandidateIds: readonly string[];
  readonly remainingBudget: AdaptiveBudget;
  readonly goalVersion: number;
  readonly normalizedPosteriorEntropy?: number;
  readonly openConflictCount?: number;
  readonly viableModelCount?: number;
  readonly taskFamily?: string;
  readonly repositorySplit?: 'development' | 'confirmation' | 'promotion';
}

export interface SearchEdge {
  readonly action: SearchAction;
  readonly visits: number;
  readonly totalValue: number;
  readonly meanValue: number;
  readonly discoveryValue: number;
  readonly childNodeIds: Readonly<Record<string, SearchNodeId>>;
  readonly outcomeProbabilities: Readonly<Record<string, number>>;
}

export interface DecisionSearchNode {
  readonly kind: 'decision';
  readonly nodeId: SearchNodeId;
  readonly state: SearchState;
  readonly depth: number;
  readonly visits: number;
  readonly edges: readonly SearchEdge[];
  readonly terminal: false;
}

export interface TerminalSearchNode {
  readonly kind: 'terminal';
  readonly nodeId: SearchNodeId;
  readonly state: SearchState;
  readonly depth: number;
  readonly visits: number;
  readonly terminal: true;
  readonly value: number;
  readonly reason: string;
}

export type SearchNode = DecisionSearchNode | TerminalSearchNode;

export interface SearchSelection {
  readonly decisionId: SearchDecisionId;
  readonly episodeId: SearchEpisodeId;
  readonly nodeId: SearchNodeId;
  readonly action: SearchAction;
  readonly score: number;
  readonly discoveryTemperature: number;
  readonly policyBackend?: 'deterministic-cold-start' | 'promoted-linear-checkpoint';
  readonly policyCheckpointHash?: string;
}

export interface SearchCommitAssessment {
  readonly eligible: boolean;
  readonly reasons: readonly string[];
  readonly expectedAdditionalInformationValue: number;
  readonly expectedAdditionalCost: number;
}

export interface IAgentTestTimeSearchService {
  readonly _serviceBrand: undefined;
  ready(): Promise<void>;
  begin(state: SearchState): Promise<SearchNodeId>;
  addActions(nodeId: SearchNodeId, actions: readonly SearchAction[]): Promise<void>;
  select(nodeId?: SearchNodeId): Promise<SearchSelection>;
  observe(
    selection: SearchSelection,
    outcomeKey: string,
    value: number,
    nextState?: SearchState,
  ): Promise<SearchNodeId | undefined>;
  assessCommit(input: {
    readonly hardGatesPass: boolean;
    readonly commitBlockingConflicts: number;
    readonly actionStableAcrossModels: boolean;
    readonly expectedAdditionalInformationValue: number;
    readonly expectedAdditionalCost: number;
    readonly liveWorkspaceReconciled: boolean;
    readonly claimsSupported: boolean;
  }): SearchCommitAssessment;
  root(): SearchNode | undefined;
  node(nodeId: SearchNodeId): SearchNode | undefined;
  nodes(): readonly SearchNode[];
  checkpoint(): Promise<void>;
  flush(): Promise<void>;
}

export const IAgentTestTimeSearchService = createDecorator<IAgentTestTimeSearchService>(
  'agentTestTimeSearchService',
);