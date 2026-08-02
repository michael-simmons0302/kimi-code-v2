import { createHash } from 'node:crypto';

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import type { CandidateId, WorldModelSetId } from '#/agent/adaptiveRuntime/adaptiveProtocol';
import { IAgentAdaptiveRuntimeService } from '#/agent/adaptiveRuntime/adaptiveRuntime';
import { IAgentCausalRuleGraphService } from '#/agent/causalRuleGraph/causalRuleGraph';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { ISessionEvaluationLedgerService } from '#/session/evaluationLedger/evaluationLedger';
import ts from 'typescript';
import {
  IAgentWorldModelService,
  type ProposeWorldModelInput,
  type WorldModelBelief,
  type WorldModelBeliefState,
  type WorldModelCandidate,
  type WorldModelCandidateStatus,
  type WorldModelLikelihoodUpdate,
  type WorldModelMethod,
} from './worldModel';
import { invokeWorldModelModule, validateWorldModelModule } from './worldModelRuntime';

const STORE_KEY = 'world-models.json';
const FORBIDDEN_IDENTIFIERS = new Set([
  'require',
  'process',
  'fetch',
  'WebSocket',
  'Deno',
  'Bun',
  'eval',
  'Function',
]);

interface PersistedWorldModels {
  readonly protocol: 'world-model-store/1';
  readonly evidenceHead: string;
  readonly candidates: readonly WorldModelCandidate[];
  readonly beliefs: readonly WorldModelBelief[];
}

export class AgentWorldModelService
  extends Disposable
  implements IAgentWorldModelService
{
  declare readonly _serviceBrand: undefined;

  private readonly scope: string;
  private readonly readyPromise: Promise<void>;
  private candidates = new Map<CandidateId, WorldModelCandidate>();
  private beliefs = new Map<CandidateId, WorldModelBelief>();
  private evidenceHead = '';
  private writeTail: Promise<void> = Promise.resolve();

  constructor(
    @IAgentScopeContext agent: IAgentScopeContext,
    @IAgentCausalRuleGraphService private readonly rules: IAgentCausalRuleGraphService,
    @IAgentAdaptiveRuntimeService private readonly runtime: IAgentAdaptiveRuntimeService,
    @IAtomicDocumentStore private readonly documents: IAtomicDocumentStore,
    @ISessionEvaluationLedgerService private readonly ledger: ISessionEvaluationLedgerService,
  ) {
    super();
    this.scope = agent.scope('adaptive');
    this._register(this.documents.acquire(this.scope, STORE_KEY));
    this.readyPromise = this.restore();
  }

  ready(): Promise<void> {
    return this.readyPromise;
  }

  propose(input: ProposeWorldModelInput): Promise<WorldModelCandidate> {
    return this.mutate(async () => {
      await this.rules.ready();
      const ruleGraph = this.rules.snapshot();
      if (input.ruleGraphHash !== ruleGraph.hash) {
        throw new Error('World model proposal targets a stale causal-rule graph.');
      }
      for (const ruleId of input.ruleIds) {
        if (this.rules.get(ruleId) === undefined) throw new Error(`World model references unknown rule: ${ruleId}`);
      }
      for (const parentId of input.parentCandidateIds ?? []) this.require(parentId);

      const sourceHash = hash(input.source);
      const duplicate = [...this.candidates.values()].find(
        (candidate) => candidate.manifest.sourceHash === sourceHash,
      );
      if (duplicate !== undefined) return duplicate;

      const compiledSource = compileCandidate(input.source);
      await validateWorldModelModule(compiledSource, {
        timeoutMs: 5_000,
        memoryLimitMb: 256,
        seed: sourceHash,
      });
      const candidateId = sourceHash as CandidateId;
      const candidate: WorldModelCandidate = {
        manifest: {
          protocol: 'world-model-module/1',
          candidateId,
          parentCandidateIds: unique(input.parentCandidateIds ?? []),
          sourceHash,
          compiledHash: hash(compiledSource),
          ruleGraphHash: input.ruleGraphHash,
          stateSchemaHash: input.stateSchemaHash,
          actionSchemaHash: input.actionSchemaHash,
          observationSchemaHash: input.observationSchemaHash,
          deterministic: input.deterministic,
          supportedEvaluatorIds: unique(input.supportedEvaluatorIds ?? []),
          evidenceHead: input.evidenceHead,
        },
        source: input.source,
        compiledSource,
        ruleIds: unique(input.ruleIds),
        status: 'sandbox-valid',
        createdAt: Date.now(),
        evaluationRefs: [],
      };
      this.candidates.set(candidateId, candidate);
      this.beliefs.set(candidateId, {
        candidateId,
        logWeight: 0,
        normalizedWeight: 0,
        planningEligible: false,
        hardGateStatus: 'unknown',
        calibrationStatus: 'uncalibrated',
        supportingEvidenceRefs: [],
        contradictingEvidenceRefs: [],
      });
      this.evidenceHead = input.evidenceHead;
      this.normalizeBeliefs();
      await this.persist();
      await this.ledger.append({ recordType: 'world_model.proposed', payload: candidate });
      this.publishRuntimeStatus();
      return candidate;
    });
  }

  async invoke<T = unknown>(
    candidateId: CandidateId,
    method: WorldModelMethod,
    args: readonly unknown[],
    options: { readonly timeoutMs?: number; readonly signal?: AbortSignal; readonly seed?: string } = {},
  ): Promise<T> {
    await this.readyPromise;
    const candidate = this.require(candidateId);
    if (candidate.status === 'rejected' || candidate.status === 'quarantined') {
      throw new Error(`World model candidate is not executable: ${candidateId}`);
    }
    return invokeWorldModelModule<T>(candidate.compiledSource, method, args, {
      timeoutMs: options.timeoutMs ?? 10_000,
      memoryLimitMb: 512,
      signal: options.signal,
      seed: options.seed ?? candidate.manifest.sourceHash,
    });
  }

  updateLikelihood(update: WorldModelLikelihoodUpdate): Promise<WorldModelBeliefState> {
    return this.mutate(async () => {
      const belief = this.requireBelief(update.candidateId);
      const candidate = this.require(update.candidateId);
      const contradiction = update.deterministicContradiction === true;
      const updatedBelief: WorldModelBelief = contradiction
        ? {
            ...belief,
            logWeight: Number.NEGATIVE_INFINITY,
            normalizedWeight: 0,
            planningEligible: false,
            hardGateStatus: 'failed',
            contradictingEvidenceRefs: unique([...belief.contradictingEvidenceRefs, update.evidenceRef]),
          }
        : {
            ...belief,
            logWeight: belief.logWeight + update.logLikelihood,
            supportingEvidenceRefs: update.supports === true
              ? unique([...belief.supportingEvidenceRefs, update.evidenceRef])
              : belief.supportingEvidenceRefs,
            contradictingEvidenceRefs: update.supports === false
              ? unique([...belief.contradictingEvidenceRefs, update.evidenceRef])
              : belief.contradictingEvidenceRefs,
          };
      this.beliefs.set(update.candidateId, updatedBelief);
      if (contradiction) {
        this.candidates.set(update.candidateId, {
          ...candidate,
          status: 'rejected',
          rejectionReason: `Deterministic contradiction: ${update.evidenceRef}`,
          evaluationRefs: unique([...candidate.evaluationRefs, update.evidenceRef]),
        });
      } else {
        this.candidates.set(update.candidateId, {
          ...candidate,
          evaluationRefs: unique([...candidate.evaluationRefs, update.evidenceRef]),
        });
      }
      this.evidenceHead = update.evidenceRef;
      this.normalizeBeliefs();
      await this.persist();
      const state = this.beliefState();
      await this.ledger.append({
        recordType: 'world_model.posterior.updated',
        payload: { update, beliefState: state },
      });
      this.publishRuntimeStatus();
      return state;
    });
  }

  setStatus(
    candidateId: CandidateId,
    status: WorldModelCandidateStatus,
    reason?: string,
  ): Promise<WorldModelCandidate> {
    return this.mutate(async () => {
      const candidate = this.require(candidateId);
      const updated: WorldModelCandidate = {
        ...candidate,
        status,
        rejectionReason: status === 'rejected' || status === 'quarantined' ? reason : undefined,
      };
      this.candidates.set(candidateId, updated);
      const belief = this.requireBelief(candidateId);
      const planningEligible = ['planning-eligible', 'active', 'promoted'].includes(status);
      this.beliefs.set(candidateId, {
        ...belief,
        planningEligible,
        hardGateStatus: planningEligible ? 'passed' : status === 'rejected' ? 'failed' : belief.hardGateStatus,
        logWeight: status === 'rejected' ? Number.NEGATIVE_INFINITY : belief.logWeight,
      });
      this.normalizeBeliefs();
      await this.persist();
      this.publishRuntimeStatus();
      return updated;
    });
  }

  get(candidateId: CandidateId): WorldModelCandidate | undefined {
    return this.candidates.get(candidateId);
  }

  list(status?: WorldModelCandidateStatus): readonly WorldModelCandidate[] {
    return [...this.candidates.values()]
      .filter((candidate) => status === undefined || candidate.status === status)
      .sort((left, right) => left.manifest.candidateId.localeCompare(right.manifest.candidateId));
  }

  beliefState(): WorldModelBeliefState {
    const beliefs = [...this.beliefs.values()].sort((left, right) => left.candidateId.localeCompare(right.candidateId));
    const worldModelSetId = hash({
      candidates: beliefs.map((belief) => [belief.candidateId, belief.logWeight, belief.planningEligible]),
      evidenceHead: this.evidenceHead,
    }) as WorldModelSetId;
    return { worldModelSetId, evidenceHead: this.evidenceHead, beliefs };
  }

  activeCandidates(): readonly WorldModelCandidate[] {
    const eligible = new Set(
      [...this.beliefs.values()]
        .filter((belief) => belief.planningEligible && belief.normalizedWeight > 0)
        .map((belief) => belief.candidateId),
    );
    return this.list().filter((candidate) => eligible.has(candidate.manifest.candidateId));
  }

  async flush(): Promise<void> {
    await this.readyPromise;
    await this.writeTail;
  }

  override dispose(): void {
    void this.flush();
    super.dispose();
  }

  private require(candidateId: CandidateId): WorldModelCandidate {
    const candidate = this.candidates.get(candidateId);
    if (candidate === undefined) throw new Error(`Unknown world model candidate: ${candidateId}`);
    return candidate;
  }

  private requireBelief(candidateId: CandidateId): WorldModelBelief {
    const belief = this.beliefs.get(candidateId);
    if (belief === undefined) throw new Error(`Missing world model belief: ${candidateId}`);
    return belief;
  }

  private normalizeBeliefs(): void {
    const finite = [...this.beliefs.values()].filter(
      (belief) => Number.isFinite(belief.logWeight) && belief.hardGateStatus !== 'failed',
    );
    const maximum = finite.length === 0
      ? Number.NEGATIVE_INFINITY
      : Math.max(...finite.map((belief) => belief.logWeight));
    const denominator = finite.reduce(
      (sum, belief) => sum + Math.exp(belief.logWeight - maximum),
      0,
    );
    for (const [candidateId, belief] of this.beliefs) {
      const normalizedWeight = Number.isFinite(belief.logWeight) && denominator > 0
        ? Math.exp(belief.logWeight - maximum) / denominator
        : 0;
      this.beliefs.set(candidateId, { ...belief, normalizedWeight });
    }
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
    const persisted = await this.documents.get<PersistedWorldModels>(this.scope, STORE_KEY);
    if (persisted?.protocol !== 'world-model-store/1') return;
    this.candidates = new Map(
      persisted.candidates.map((candidate) => [candidate.manifest.candidateId, candidate]),
    );
    this.beliefs = new Map(persisted.beliefs.map((belief) => [belief.candidateId, belief]));
    this.evidenceHead = persisted.evidenceHead;
    this.normalizeBeliefs();
    this.publishRuntimeStatus();
  }

  private persist(): Promise<void> {
    const payload: PersistedWorldModels = {
      protocol: 'world-model-store/1',
      evidenceHead: this.evidenceHead,
      candidates: this.list(),
      beliefs: this.beliefState().beliefs,
    };
    return this.documents.set(this.scope, STORE_KEY, payload);
  }

  private publishRuntimeStatus(): void {
    const state = this.beliefState();
    this.runtime.update({
      viableModels: state.beliefs.filter((belief) => belief.hardGateStatus !== 'failed').length,
      normalizedPosteriorEntropy: normalizedEntropy(state.beliefs.map((belief) => belief.normalizedWeight)),
    });
  }
}

function compileCandidate(source: string): string {
  const syntax = ts.createSourceFile('world-model.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const forbidden: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node) || ts.isExportDeclaration(node)) {
      forbidden.push(`Module syntax is forbidden at offset ${node.getStart(syntax)}.`);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      forbidden.push(`Dynamic import is forbidden at offset ${node.getStart(syntax)}.`);
    }
    if (ts.isIdentifier(node) && FORBIDDEN_IDENTIFIERS.has(node.text)) {
      const parent = node.parent;
      const propertyName = ts.isPropertyAccessExpression(parent) && parent.name === node;
      const objectKey = ts.isPropertyAssignment(parent) && parent.name === node;
      if (!propertyName && !objectKey) forbidden.push(`Forbidden identifier ${node.text} at offset ${node.getStart(syntax)}.`);
    }
    ts.forEachChild(node, visit);
  };
  visit(syntax);
  if (syntax.parseDiagnostics.length > 0) {
    forbidden.push(...syntax.parseDiagnostics.map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    ));
  }
  if (forbidden.length > 0) throw new Error(forbidden.join('\n'));
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.None,
      strict: true,
      removeComments: false,
    },
    reportDiagnostics: true,
    fileName: 'world-model.ts',
  });
  const errors = compiled.diagnostics?.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error) ?? [];
  if (errors.length > 0) {
    throw new Error(errors.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')).join('\n'));
  }
  return compiled.outputText;
}

function normalizedEntropy(weights: readonly number[]): number {
  const positive = weights.filter((weight) => weight > 0);
  if (positive.length <= 1) return 0;
  const entropy = positive.reduce((sum, weight) => sum - weight * Math.log(weight), 0);
  return entropy / Math.log(positive.length);
}

function hash(value: unknown): string {
  const content = typeof value === 'string' ? value : canonicalJson(value);
  return createHash('sha256').update(content).digest('hex');
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

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentWorldModelService,
  AgentWorldModelService,
  ScopeActivation.OnScopeCreated,
  'worldModel',
);
