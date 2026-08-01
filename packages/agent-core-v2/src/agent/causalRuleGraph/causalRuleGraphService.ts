import { createHash } from 'node:crypto';

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import type { CausalRuleId } from '#/agent/adaptiveRuntime/adaptiveProtocol';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { ISessionEvaluationLedgerService } from '#/session/evaluationLedger/evaluationLedger';
import {
  IAgentCausalRuleGraphService,
  type CausalRule,
  type CausalRuleEvidenceUpdate,
  type CausalRuleGraphSnapshot,
  type CausalRuleScope,
  type ProposeCausalRuleInput,
} from './causalRuleGraph';

const GRAPH_KEY = 'causal-rules.json';

interface PersistedCausalRuleGraph {
  readonly protocol: 'causal-rule-graph/1';
  readonly rules: readonly CausalRule[];
}

export class AgentCausalRuleGraphService
  extends Disposable
  implements IAgentCausalRuleGraphService
{
  declare readonly _serviceBrand: undefined;

  private readonly scope: string;
  private readonly readyPromise: Promise<void>;
  private rules = new Map<CausalRuleId, CausalRule>();
  private writeTail: Promise<void> = Promise.resolve();

  constructor(
    @IAgentScopeContext agent: IAgentScopeContext,
    @IAtomicDocumentStore private readonly documents: IAtomicDocumentStore,
    @ISessionEvaluationLedgerService private readonly ledger: ISessionEvaluationLedgerService,
  ) {
    super();
    this.scope = agent.scope('adaptive');
    this._register(this.documents.acquire(this.scope, GRAPH_KEY));
    this.readyPromise = this.restore();
  }

  ready(): Promise<void> {
    return this.readyPromise;
  }

  propose(input: ProposeCausalRuleInput): Promise<CausalRule> {
    return this.mutate(async () => {
      validateRuleInput(input);
      for (const parentRuleId of input.parentRuleIds ?? []) this.require(parentRuleId);
      for (const supersededRuleId of input.supersedesRuleIds ?? []) this.require(supersededRuleId);
      const semanticHash = hashSemanticRule(input);
      const existing = [...this.rules.values()].find(
        (rule) => rule.semanticHash === semanticHash && rule.status !== 'rejected',
      );
      if (existing !== undefined) {
        const updated = mergeEvidence(existing, {
          supportingEvidenceRefs: input.supportingEvidenceRefs,
          contradictingEvidenceRefs: input.contradictingEvidenceRefs,
          withheldEvidenceRefs: input.withheldEvidenceRefs,
        });
        this.rules.set(updated.ruleId, updated);
        await this.persist();
        return updated;
      }

      const parentRuleIds = unique(input.parentRuleIds ?? []);
      const version = 1 + Math.max(0, ...parentRuleIds.map((id) => this.require(id).version));
      const ruleId = `${semanticHash}:${String(version)}` as CausalRuleId;
      const supportingEvidenceRefs = unique(input.supportingEvidenceRefs ?? []);
      const contradictingEvidenceRefs = unique(input.contradictingEvidenceRefs ?? []);
      const withheldEvidenceRefs = unique(input.withheldEvidenceRefs ?? []);
      const rule: CausalRule = {
        protocol: 'causal-rule/1',
        ruleId,
        semanticHash,
        version,
        scope: input.scope,
        condition: input.condition,
        intervention: input.intervention,
        predictedEffects: canonicalEffects(input.predictedEffects),
        subjectRefs: unique(input.subjectRefs),
        parentRuleIds,
        childRuleIds: [],
        supersedesRuleIds: unique(input.supersedesRuleIds ?? []),
        supportingEvidenceRefs,
        contradictingEvidenceRefs,
        withheldEvidenceRefs,
        posteriorSupport: 0,
        generalizationScore: generalizationScore(input.scope, input.subjectRefs, withheldEvidenceRefs),
        complexityScore: complexityScore(input),
        status: initialStatus(supportingEvidenceRefs, contradictingEvidenceRefs),
      };
      this.rules.set(ruleId, rule);
      for (const parentId of parentRuleIds) {
        const parent = this.require(parentId);
        this.rules.set(parentId, {
          ...parent,
          childRuleIds: unique([...parent.childRuleIds, ruleId]),
        });
      }
      for (const supersededId of rule.supersedesRuleIds) {
        const superseded = this.require(supersededId);
        this.rules.set(supersededId, { ...superseded, status: 'superseded' });
      }
      await this.persist();
      await this.ledger.append({
        recordType: 'causal.rule.proposed',
        payload: rule,
      });
      return rule;
    });
  }

  updateEvidence(ruleId: CausalRuleId, update: CausalRuleEvidenceUpdate): Promise<CausalRule> {
    return this.mutate(async () => {
      const current = this.require(ruleId);
      const updated = mergeEvidence(current, update);
      this.rules.set(ruleId, updated);
      await this.persist();
      return updated;
    });
  }

  supersede(
    ruleIds: readonly CausalRuleId[],
    replacement: ProposeCausalRuleInput,
  ): Promise<CausalRule> {
    return this.propose({
      ...replacement,
      parentRuleIds: unique([...(replacement.parentRuleIds ?? []), ...ruleIds]),
      supersedesRuleIds: unique([...(replacement.supersedesRuleIds ?? []), ...ruleIds]),
    }).then(async (rule) => {
      await this.ledger.append({
        recordType: 'causal.rule.superseded',
        payload: { ruleIds, replacementRuleId: rule.ruleId },
      });
      return rule;
    });
  }

  reject(ruleId: CausalRuleId, evidenceRefs: readonly string[]): Promise<CausalRule> {
    return this.updateEvidence(ruleId, {
      contradictingEvidenceRefs: evidenceRefs,
      posteriorSupport: 0,
      status: 'rejected',
    });
  }

  get(ruleId: CausalRuleId): CausalRule | undefined {
    return this.rules.get(ruleId);
  }

  list(status?: CausalRule['status']): readonly CausalRule[] {
    return [...this.rules.values()]
      .filter((rule) => status === undefined || rule.status === status)
      .sort((left, right) => left.ruleId.localeCompare(right.ruleId));
  }

  roots(): readonly CausalRule[] {
    return this.list().filter((rule) => rule.parentRuleIds.length === 0);
  }

  descendants(ruleId: CausalRuleId): readonly CausalRule[] {
    this.require(ruleId);
    const visited = new Set<CausalRuleId>();
    const queue = [...this.require(ruleId).childRuleIds];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      queue.push(...this.require(current).childRuleIds);
    }
    return [...visited].map((id) => this.require(id));
  }

  eligiblePromotion(ruleId: CausalRuleId, targetScope: CausalRuleScope): boolean {
    const rule = this.require(ruleId);
    const currentIndex = SCOPE_ORDER.indexOf(rule.scope);
    const targetIndex = SCOPE_ORDER.indexOf(targetScope);
    if (targetIndex !== currentIndex + 1) return false;
    const evidenceCount = new Set(rule.withheldEvidenceRefs).size;
    const subjectCount = new Set(rule.subjectRefs).size;
    switch (targetScope) {
      case 'file':
        return evidenceCount >= 2;
      case 'module':
      case 'package':
      case 'repository':
      case 'runtime':
      case 'trajectory':
        return evidenceCount >= 2 && subjectCount >= 2;
      case 'symbol':
        return false;
    }
  }

  snapshot(): CausalRuleGraphSnapshot {
    const rules = this.list();
    return {
      protocol: 'causal-rule-graph/1',
      hash: createHash('sha256').update(canonicalJson(rules)).digest('hex'),
      rules,
    };
  }

  async flush(): Promise<void> {
    await this.readyPromise;
    await this.writeTail;
  }

  override dispose(): void {
    void this.flush();
    super.dispose();
  }

  private require(ruleId: CausalRuleId): CausalRule {
    const rule = this.rules.get(ruleId);
    if (rule === undefined) throw new Error(`Unknown causal rule: ${ruleId}`);
    return rule;
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    let resolveResult!: (value: T) => void;
    let rejectResult!: (error: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    this.writeTail = this.writeTail
      .then(async () => {
        await this.readyPromise;
        resolveResult(await operation());
      })
      .catch(rejectResult);
    return result;
  }

  private async restore(): Promise<void> {
    const persisted = await this.documents.get<PersistedCausalRuleGraph>(this.scope, GRAPH_KEY);
    if (persisted?.protocol !== 'causal-rule-graph/1') return;
    this.rules = new Map(persisted.rules.map((rule) => [rule.ruleId, rule]));
    validateGraph(this.rules);
  }

  private persist(): Promise<void> {
    const payload: PersistedCausalRuleGraph = {
      protocol: 'causal-rule-graph/1',
      rules: this.list(),
    };
    return this.documents.set(this.scope, GRAPH_KEY, payload);
  }
}

const SCOPE_ORDER: readonly CausalRuleScope[] = [
  'symbol',
  'file',
  'module',
  'package',
  'repository',
  'runtime',
  'trajectory',
];

function validateRuleInput(input: ProposeCausalRuleInput): void {
  if (input.predictedEffects.length === 0) throw new Error('A causal rule requires at least one predicted effect.');
  for (const effect of input.predictedEffects) {
    if (effect.probability !== undefined && (effect.probability < 0 || effect.probability > 1)) {
      throw new Error('Causal effect probability must be in [0, 1].');
    }
  }
}

function validateGraph(rules: ReadonlyMap<CausalRuleId, CausalRule>): void {
  for (const rule of rules.values()) {
    for (const parentId of rule.parentRuleIds) {
      if (!rules.has(parentId)) throw new Error(`Causal rule ${rule.ruleId} has missing parent ${parentId}.`);
    }
    for (const childId of rule.childRuleIds) {
      if (!rules.has(childId)) throw new Error(`Causal rule ${rule.ruleId} has missing child ${childId}.`);
    }
  }
  const visiting = new Set<CausalRuleId>();
  const visited = new Set<CausalRuleId>();
  const visit = (id: CausalRuleId): void => {
    if (visiting.has(id)) throw new Error(`Causal rule graph contains a cycle at ${id}.`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const child of rules.get(id)?.childRuleIds ?? []) visit(child);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of rules.keys()) visit(id);
}

function mergeEvidence(rule: CausalRule, update: CausalRuleEvidenceUpdate): CausalRule {
  const supportingEvidenceRefs = unique([
    ...rule.supportingEvidenceRefs,
    ...(update.supportingEvidenceRefs ?? []),
  ]);
  const contradictingEvidenceRefs = unique([
    ...rule.contradictingEvidenceRefs,
    ...(update.contradictingEvidenceRefs ?? []),
  ]);
  const withheldEvidenceRefs = unique([
    ...rule.withheldEvidenceRefs,
    ...(update.withheldEvidenceRefs ?? []),
  ]);
  const status = update.status ?? initialStatus(supportingEvidenceRefs, contradictingEvidenceRefs);
  return {
    ...rule,
    supportingEvidenceRefs,
    contradictingEvidenceRefs,
    withheldEvidenceRefs,
    posteriorSupport: clamp01(update.posteriorSupport ?? rule.posteriorSupport),
    generalizationScore: generalizationScore(rule.scope, rule.subjectRefs, withheldEvidenceRefs),
    status,
  };
}

function initialStatus(
  supportingEvidenceRefs: readonly string[],
  contradictingEvidenceRefs: readonly string[],
): CausalRule['status'] {
  if (contradictingEvidenceRefs.length > 0 && supportingEvidenceRefs.length > 0) return 'contested';
  if (contradictingEvidenceRefs.length > 0) return 'rejected';
  if (supportingEvidenceRefs.length > 0) return 'supported';
  return 'proposed';
}

function hashSemanticRule(input: ProposeCausalRuleInput): string {
  return createHash('sha256')
    .update(canonicalJson({
      scope: input.scope,
      condition: input.condition,
      intervention: input.intervention,
      predictedEffects: canonicalEffects(input.predictedEffects),
      subjectRefs: unique(input.subjectRefs),
    }))
    .digest('hex');
}

function canonicalEffects<T extends ProposeCausalRuleInput['predictedEffects']>(effects: T): T {
  return [...effects].sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right))) as T;
}

function complexityScore(input: ProposeCausalRuleInput): number {
  return canonicalJson({
    condition: input.condition,
    intervention: input.intervention,
    predictedEffects: input.predictedEffects,
  }).length;
}

function generalizationScore(
  scope: CausalRuleScope,
  subjectRefs: readonly string[],
  withheldEvidenceRefs: readonly string[],
): number {
  const scopeWeight = (SCOPE_ORDER.indexOf(scope) + 1) / SCOPE_ORDER.length;
  const breadth = Math.min(1, new Set(subjectRefs).size / 8);
  const withheld = Math.min(1, new Set(withheldEvidenceRefs).size / 4);
  return scopeWeight * 0.5 + breadth * 0.25 + withheld * 0.25;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
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
  IAgentCausalRuleGraphService,
  AgentCausalRuleGraphService,
  ScopeActivation.OnScopeCreated,
  'causalRuleGraph',
);
