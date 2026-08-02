import { createDecorator } from '#/_base/di/instantiation';
import type { EvidenceId } from '#/agent/adaptiveRuntime/adaptiveProtocol';

export const ADAPTIVE_MEMORY_PROTOCOL = 'adaptive-memory/1' as const;

export type AdaptiveSummaryKind =
  | 'trajectory'
  | 'hypothesis'
  | 'failure'
  | 'open-conflicts'
  | 'verified-progress';

export interface AdaptiveSummaryClaim {
  readonly text: string;
  readonly evidenceRefs: readonly EvidenceId[];
}

export interface AdaptiveTrajectorySummary {
  readonly attemptedCause: string;
  readonly selectedEvaluation: string;
  readonly observedOutcome: string;
  readonly rulesSupported: readonly string[];
  readonly rulesRejected: readonly string[];
  readonly unresolvedConflicts: readonly string[];
  readonly usefulArtifactRefs: readonly string[];
  readonly verifiedProgress: string;
  readonly remainingDecision: string;
}

export interface AdaptiveSummaryRecord {
  readonly protocol: typeof ADAPTIVE_MEMORY_PROTOCOL;
  readonly summaryId: string;
  readonly kind: AdaptiveSummaryKind;
  readonly goalVersion: number;
  readonly structureHash: string;
  readonly contentHash: string;
  readonly createdAtSequence: number;
  readonly claims: readonly AdaptiveSummaryClaim[];
  readonly trajectory?: AdaptiveTrajectorySummary;
  readonly exactDiagnostics: readonly string[];
  readonly decisiveCounterexampleRefs: readonly EvidenceId[];
  readonly artifactRefs: readonly string[];
  readonly stale: boolean;
  readonly staleReason?: string;
}

export interface SaveAdaptiveSummaryInput {
  readonly kind: AdaptiveSummaryKind;
  readonly goalVersion: number;
  readonly structureHash: string;
  readonly claims: readonly AdaptiveSummaryClaim[];
  readonly trajectory?: AdaptiveTrajectorySummary;
  readonly exactDiagnostics?: readonly string[];
  readonly decisiveCounterexampleRefs?: readonly EvidenceId[];
  readonly artifactRefs?: readonly string[];
}

export interface AdaptiveEvidenceCandidate {
  readonly evidenceId: EvidenceId;
  readonly text: string;
  readonly contentHash: string;
  readonly tokenEstimate: number;
  readonly structuralRelevance: number;
  readonly causalRelevance: number;
  readonly decisionRelevance: number;
  readonly recency: number;
  readonly redundancy: number;
  readonly exactDiagnostic?: boolean;
  readonly decisiveCounterexample?: boolean;
}

export interface AdaptiveEvidenceSelection {
  readonly selected: readonly AdaptiveEvidenceCandidate[];
  readonly omitted: readonly EvidenceId[];
  readonly tokenEstimate: number;
}

export interface IAgentAdaptiveMemoryService {
  readonly _serviceBrand: undefined;

  ready(): Promise<void>;
  saveSummary(input: SaveAdaptiveSummaryInput): Promise<AdaptiveSummaryRecord>;
  summaries(options?: {
    readonly includeStale?: boolean;
    readonly kind?: AdaptiveSummaryKind;
  }): readonly AdaptiveSummaryRecord[];
  selectEvidence(
    candidates: readonly AdaptiveEvidenceCandidate[],
    tokenBudget: number,
  ): AdaptiveEvidenceSelection;
  invalidateForGoal(goalVersion: number, reason: string): Promise<void>;
  invalidateForStructure(structureHash: string, reason: string): Promise<void>;
  flush(): Promise<void>;
}

export const IAgentAdaptiveMemoryService = createDecorator<IAgentAdaptiveMemoryService>(
  'agentAdaptiveMemoryService',
);
