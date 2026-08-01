import { randomUUID } from 'node:crypto';

export const ADAPTIVE_ARCHITECTURE_VERSION = 'evolve-architecture/1' as const;
export const ADAPTIVE_LEDGER_PROTOCOL = 'adaptive-ledger/1' as const;
export const ADAPTIVE_EVIDENCE_GRAPH_PROTOCOL = 'adaptive-evidence-graph/1' as const;
export const EVALUATION_SPEC_PROTOCOL = 'evaluation-spec/1' as const;
export const EVALUATION_RESULT_PROTOCOL = 'evaluation-result/1' as const;
export const CODE_STRUCTURE_GRAPH_PROTOCOL = 'code-structure-graph/1' as const;
export const STRUCTURAL_SIGNALS_PROTOCOL = 'structural-signals/1' as const;
export const CAUSAL_RULE_PROTOCOL = 'causal-rule/1' as const;
export const WORLD_MODEL_PROTOCOL = 'world-model-module/1' as const;
export const WORLD_MODEL_STORE_PROTOCOL = 'world-model-store/1' as const;
export const SEARCH_CHECKPOINT_PROTOCOL = 'adaptive-search-checkpoint/1' as const;
export const ADAPTIVE_PROMPT_PROTOCOL = 'adaptive-prompt/1' as const;
export const CANDIDATE_WORKSPACE_PROTOCOL = 'candidate-workspace/1' as const;
export const EVALUATION_SANDBOX_PROTOCOL = 'evaluation-sandbox/1' as const;
export const PROGRAM_ARCHIVE_PROTOCOL = 'program-archive/1' as const;
export const BENCHMARK_MANIFEST_PROTOCOL = 'evolve-benchmark-manifest/1' as const;

/** @deprecated Use EVALUATION_SPEC_PROTOCOL or EVALUATION_RESULT_PROTOCOL. */
export const EVALUATION_PROTOCOL = EVALUATION_SPEC_PROTOCOL;

export const ADAPTIVE_PROTOCOL_REGISTRY = Object.freeze({
  architecture: ADAPTIVE_ARCHITECTURE_VERSION,
  evidenceLedger: ADAPTIVE_LEDGER_PROTOCOL,
  evidenceGraph: ADAPTIVE_EVIDENCE_GRAPH_PROTOCOL,
  evaluationSpec: EVALUATION_SPEC_PROTOCOL,
  evaluationResult: EVALUATION_RESULT_PROTOCOL,
  codeStructureGraph: CODE_STRUCTURE_GRAPH_PROTOCOL,
  structuralSignals: STRUCTURAL_SIGNALS_PROTOCOL,
  causalRule: CAUSAL_RULE_PROTOCOL,
  worldModelModule: WORLD_MODEL_PROTOCOL,
  worldModelStore: WORLD_MODEL_STORE_PROTOCOL,
  searchCheckpoint: SEARCH_CHECKPOINT_PROTOCOL,
  adaptivePrompt: ADAPTIVE_PROMPT_PROTOCOL,
  candidateWorkspace: CANDIDATE_WORKSPACE_PROTOCOL,
  evaluationSandbox: EVALUATION_SANDBOX_PROTOCOL,
  programArchive: PROGRAM_ARCHIVE_PROTOCOL,
  benchmarkManifest: BENCHMARK_MANIFEST_PROTOCOL,
} as const);

export type Brand<T, Name extends string> = T & { readonly __brand: Name };

export type AdaptiveRunId = Brand<string, 'AdaptiveRunId'>;
export type SearchEpisodeId = Brand<string, 'SearchEpisodeId'>;
export type SearchNodeId = Brand<string, 'SearchNodeId'>;
export type SearchDecisionId = Brand<string, 'SearchDecisionId'>;
export type EvaluationId = Brand<string, 'EvaluationId'>;
export type EvaluationReplicateId = Brand<string, 'EvaluationReplicateId'>;
export type EvidenceId = Brand<string, 'EvidenceId'>;
export type ArtifactId = Brand<string, 'ArtifactId'>;
export type CandidateId = Brand<string, 'CandidateId'>;
export type WorldModelSetId = Brand<string, 'WorldModelSetId'>;
export type CausalRuleId = Brand<string, 'CausalRuleId'>;
export type ConflictId = Brand<string, 'ConflictId'>;
export type WorkspaceSnapshotId = Brand<string, 'WorkspaceSnapshotId'>;

export type AdaptivePhase =
  | 'inactive'
  | 'initializing'
  | 'indexing'
  | 'discovering'
  | 'modeling'
  | 'evaluating'
  | 'planning'
  | 'acting'
  | 'reconciling'
  | 'committing'
  | 'completed'
  | 'blocked'
  | 'cancelled'
  | 'budget-exhausted'
  | 'infrastructure-failed'
  | 'evidence-corrupted'
  | 'no-viable-model'
  | 'commit-rejected';

export interface AdaptiveBudget {
  readonly maxInternalRequests: number;
  readonly maxEvaluations: number;
  readonly maxStochasticReplicates: number;
  readonly maxToolCalls: number;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly maxWallMs: number;
  readonly maxCpuMs: number;
  readonly maxDiskBytes: number;
  readonly maxCandidates: number;
}

export interface AdaptiveCost {
  readonly internalRequests: number;
  readonly evaluations: number;
  readonly stochasticReplicates: number;
  readonly toolCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly wallMs: number;
  readonly cpuMs: number;
  readonly diskBytes: number;
}

export interface AdaptiveRunIdentity {
  readonly adaptiveRunId: AdaptiveRunId;
  readonly searchEpisodeId: SearchEpisodeId;
  readonly worldModelSetId: WorldModelSetId;
}

export interface AdaptiveArtifactReference {
  readonly artifactId: ArtifactId;
  readonly sha256: string;
  readonly mediaType: string;
  readonly byteLength: number;
}

export interface AdaptiveStatusSnapshot {
  readonly runId: AdaptiveRunId;
  readonly phase: AdaptivePhase;
  readonly evaluationsCompleted: number;
  readonly evaluationsActive: number;
  readonly viableModels: number;
  readonly openConflicts: number;
  readonly normalizedPosteriorEntropy: number;
  readonly decisionWeightedUncertainty: number;
  readonly remainingBudgetFraction: number;
  readonly verifiedCandidates: number;
}

export const DEFAULT_ADAPTIVE_BUDGET: AdaptiveBudget = Object.freeze({
  maxInternalRequests: 128,
  maxEvaluations: 128,
  maxStochasticReplicates: 32,
  maxToolCalls: 256,
  maxInputTokens: 2_000_000,
  maxOutputTokens: 500_000,
  maxWallMs: 60 * 60 * 1000,
  maxCpuMs: 4 * 60 * 60 * 1000,
  maxDiskBytes: 20 * 1024 * 1024 * 1024,
  maxCandidates: 256,
});

export function createAdaptiveRunId(): AdaptiveRunId {
  return randomUUID() as AdaptiveRunId;
}

export function createSearchEpisodeId(): SearchEpisodeId {
  return randomUUID() as SearchEpisodeId;
}

export function createSearchDecisionId(): SearchDecisionId {
  return randomUUID() as SearchDecisionId;
}

export function createEvaluationId(): EvaluationId {
  return randomUUID() as EvaluationId;
}

export function createEvidenceId(): EvidenceId {
  return randomUUID() as EvidenceId;
}

export function emptyAdaptiveCost(): AdaptiveCost {
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

export function remainingBudgetFraction(
  budget: AdaptiveBudget,
  cost: AdaptiveCost,
): number {
  const fractions = [
    ratio(cost.internalRequests, budget.maxInternalRequests),
    ratio(cost.evaluations, budget.maxEvaluations),
    ratio(cost.stochasticReplicates, budget.maxStochasticReplicates),
    ratio(cost.toolCalls, budget.maxToolCalls),
    ratio(cost.inputTokens, budget.maxInputTokens),
    ratio(cost.outputTokens, budget.maxOutputTokens),
    ratio(cost.wallMs, budget.maxWallMs),
    ratio(cost.cpuMs, budget.maxCpuMs),
    ratio(cost.diskBytes, budget.maxDiskBytes),
  ];
  return Math.max(0, 1 - Math.max(...fractions));
}

function ratio(used: number, maximum: number): number {
  if (maximum <= 0) return used > 0 ? 1 : 0;
  return Math.max(0, used / maximum);
}
