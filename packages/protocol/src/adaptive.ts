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

export interface AdaptiveStatus {
  readonly runId: string;
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

declare module './events' {
  interface AgentStatusUpdatedEvent {
    readonly adaptive?: AdaptiveStatus;
  }
}

export {};
