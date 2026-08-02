import { createDecorator } from '#/_base/di/instantiation';
import type { CausalRuleId } from '#/agent/adaptiveRuntime/adaptiveProtocol';

export type CausalRuleScope =
  | 'symbol'
  | 'file'
  | 'module'
  | 'package'
  | 'repository'
  | 'runtime'
  | 'trajectory';

export type CausalValue =
  | null
  | boolean
  | number
  | string
  | readonly CausalValue[]
  | { readonly [key: string]: CausalValue };

export interface CausalCondition {
  readonly expression: CausalValue;
}

export interface CausalInterventionPattern {
  readonly action: CausalValue;
  readonly controlledVariables?: readonly string[];
}

export interface CausalEffect {
  readonly target: string;
  readonly operation: 'set' | 'delete' | 'increment' | 'append' | 'emit' | 'invalidate';
  readonly value?: CausalValue;
  readonly probability?: number;
}

export interface CausalRule {
  readonly protocol: 'causal-rule/1';
  readonly ruleId: CausalRuleId;
  readonly semanticHash: string;
  readonly version: number;
  readonly scope: CausalRuleScope;
  readonly condition: CausalCondition;
  readonly intervention: CausalInterventionPattern;
  readonly predictedEffects: readonly CausalEffect[];
  readonly subjectRefs: readonly string[];
  readonly parentRuleIds: readonly CausalRuleId[];
  readonly childRuleIds: readonly CausalRuleId[];
  readonly supersedesRuleIds: readonly CausalRuleId[];
  readonly supportingEvidenceRefs: readonly string[];
  readonly contradictingEvidenceRefs: readonly string[];
  readonly withheldEvidenceRefs: readonly string[];
  readonly posteriorSupport: number;
  readonly generalizationScore: number;
  readonly complexityScore: number;
  readonly status: 'proposed' | 'supported' | 'contested' | 'rejected' | 'superseded';
}

export interface ProposeCausalRuleInput {
  readonly scope: CausalRuleScope;
  readonly condition: CausalCondition;
  readonly intervention: CausalInterventionPattern;
  readonly predictedEffects: readonly CausalEffect[];
  readonly subjectRefs: readonly string[];
  readonly parentRuleIds?: readonly CausalRuleId[];
  readonly supersedesRuleIds?: readonly CausalRuleId[];
  readonly supportingEvidenceRefs?: readonly string[];
  readonly contradictingEvidenceRefs?: readonly string[];
  readonly withheldEvidenceRefs?: readonly string[];
}

export interface CausalRuleEvidenceUpdate {
  readonly supportingEvidenceRefs?: readonly string[];
  readonly contradictingEvidenceRefs?: readonly string[];
  readonly withheldEvidenceRefs?: readonly string[];
  readonly posteriorSupport?: number;
  readonly status?: CausalRule['status'];
}

export interface CausalRuleGraphSnapshot {
  readonly protocol: 'causal-rule-graph/1';
  readonly hash: string;
  readonly rules: readonly CausalRule[];
}

export interface IAgentCausalRuleGraphService {
  readonly _serviceBrand: undefined;
  ready(): Promise<void>;
  propose(input: ProposeCausalRuleInput): Promise<CausalRule>;
  updateEvidence(ruleId: CausalRuleId, update: CausalRuleEvidenceUpdate): Promise<CausalRule>;
  supersede(ruleIds: readonly CausalRuleId[], replacement: ProposeCausalRuleInput): Promise<CausalRule>;
  reject(ruleId: CausalRuleId, evidenceRefs: readonly string[]): Promise<CausalRule>;
  get(ruleId: CausalRuleId): CausalRule | undefined;
  list(status?: CausalRule['status']): readonly CausalRule[];
  roots(): readonly CausalRule[];
  descendants(ruleId: CausalRuleId): readonly CausalRule[];
  eligiblePromotion(ruleId: CausalRuleId, targetScope: CausalRuleScope): boolean;
  snapshot(): CausalRuleGraphSnapshot;
  flush(): Promise<void>;
}

export const IAgentCausalRuleGraphService = createDecorator<IAgentCausalRuleGraphService>(
  'agentCausalRuleGraphService',
);
