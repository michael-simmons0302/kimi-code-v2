import { createDecorator } from '#/_base/di/instantiation';
import type { CandidateId, CausalRuleId } from '#/agent/adaptiveRuntime/adaptiveProtocol';
import type { WorldModelCandidate } from '#/agent/worldModel/worldModel';

export type WorldModelEvolutionKind =
  | 'propose'
  | 'repair'
  | 'recombine'
  | 'expand-state-abstraction'
  | 'adversarial-alternative'
  | 'simplify';

export interface WorldModelEvolutionInput {
  readonly kind: WorldModelEvolutionKind;
  readonly objective: string;
  readonly observations: readonly unknown[];
  readonly counterexamples: readonly unknown[];
  readonly conflicts: readonly unknown[];
  readonly ruleIds: readonly CausalRuleId[];
  readonly parentCandidateIds: readonly CandidateId[];
  readonly parentCandidates?: readonly WorldModelCandidate[];
  readonly ruleGraphHash: string;
  readonly stateSchemaHash: string;
  readonly actionSchemaHash: string;
  readonly observationSchemaHash: string;
  readonly evidenceHead: string;
  readonly maximumCandidates: number;
}

export interface WorldModelCandidateBundle {
  readonly source: string;
  readonly ruleIds: readonly CausalRuleId[];
  readonly parentCandidateIds: readonly CandidateId[];
  readonly deterministic: boolean;
  readonly supportedEvaluatorIds: readonly string[];
  readonly rationaleSummary: string;
}

export interface WorldModelEvolutionResult {
  readonly kind: WorldModelEvolutionKind;
  readonly candidates: readonly WorldModelCandidateBundle[];
  readonly requestId: string;
  readonly providerTraceId?: string;
}

export interface IAgentWorldModelEvolutionService {
  readonly _serviceBrand: undefined;
  evolve(
    input: WorldModelEvolutionInput,
    signal?: AbortSignal,
  ): Promise<WorldModelEvolutionResult>;
}

export const IAgentWorldModelEvolutionService =
  createDecorator<IAgentWorldModelEvolutionService>('agentWorldModelEvolutionService');
