import { createHash, randomUUID } from 'node:crypto';

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { ISessionEvaluationLedgerService } from '#/session/evaluationLedger/evaluationLedger';
import {
  ADAPTIVE_MEMORY_PROTOCOL,
  IAgentAdaptiveMemoryService,
  type AdaptiveEvidenceCandidate,
  type AdaptiveEvidenceSelection,
  type AdaptiveSummaryRecord,
  type SaveAdaptiveSummaryInput,
} from './adaptiveMemory';

const STORE_KEY = 'adaptive-memory.json';

interface PersistedAdaptiveMemory {
  readonly protocol: typeof ADAPTIVE_MEMORY_PROTOCOL;
  readonly summaries: readonly AdaptiveSummaryRecord[];
}

export class AgentAdaptiveMemoryService
  extends Disposable
  implements IAgentAdaptiveMemoryService
{
  declare readonly _serviceBrand: undefined;

  private readonly scope: string;
  private readonly readyPromise: Promise<void>;
  private records: AdaptiveSummaryRecord[] = [];
  private writeTail: Promise<void> = Promise.resolve();

  constructor(
    @IAgentScopeContext agent: IAgentScopeContext,
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

  saveSummary(input: SaveAdaptiveSummaryInput): Promise<AdaptiveSummaryRecord> {
    return this.mutate(async () => {
      const evidenceIds = await this.knownEvidenceIds();
      validateSummaryInput(input, evidenceIds);
      const normalized = normalizeSummaryInput(input);
      const contentHash = hashCanonical(normalized);
      const duplicate = this.records.find(
        (record) =>
          record.contentHash === contentHash &&
          record.goalVersion === input.goalVersion &&
          record.structureHash === input.structureHash &&
          !record.stale,
      );
      if (duplicate !== undefined) return duplicate;

      const record: AdaptiveSummaryRecord = {
        protocol: ADAPTIVE_MEMORY_PROTOCOL,
        summaryId: randomUUID(),
        kind: normalized.kind,
        goalVersion: normalized.goalVersion,
        structureHash: normalized.structureHash,
        contentHash,
        createdAtSequence: this.ledger.head().sequence,
        claims: normalized.claims,
        trajectory: normalized.trajectory,
        exactDiagnostics: normalized.exactDiagnostics,
        decisiveCounterexampleRefs: normalized.decisiveCounterexampleRefs,
        artifactRefs: normalized.artifactRefs,
        stale: false,
      };
      this.records = [...this.records, record];
      await this.persist();
      return record;
    });
  }

  summaries(options: {
    readonly includeStale?: boolean;
    readonly kind?: AdaptiveSummaryRecord['kind'];
  } = {}): readonly AdaptiveSummaryRecord[] {
    return this.records
      .filter((record) => options.includeStale === true || !record.stale)
      .filter((record) => options.kind === undefined || record.kind === options.kind)
      .sort((left, right) => right.createdAtSequence - left.createdAtSequence);
  }

  selectEvidence(
    candidates: readonly AdaptiveEvidenceCandidate[],
    tokenBudget: number,
  ): AdaptiveEvidenceSelection {
    if (!Number.isFinite(tokenBudget) || tokenBudget < 0) {
      throw new RangeError('Adaptive evidence token budget must be non-negative.');
    }
    const unique = deduplicateCandidates(candidates);
    const mandatory = unique.filter(
      (candidate) => candidate.exactDiagnostic === true || candidate.decisiveCounterexample === true,
    );
    const mandatoryTokens = mandatory.reduce(
      (total, candidate) => total + normalizedTokenEstimate(candidate),
      0,
    );
    if (mandatoryTokens > tokenBudget) {
      throw new Error(
        `Adaptive evidence budget ${String(tokenBudget)} cannot preserve ${String(mandatoryTokens)} mandatory tokens.`,
      );
    }

    const selected = [...mandatory];
    let used = mandatoryTokens;
    const selectedIds = new Set(mandatory.map((candidate) => candidate.evidenceId));
    const ranked = unique
      .filter((candidate) => !selectedIds.has(candidate.evidenceId))
      .sort((left, right) => evidenceUtility(right) - evidenceUtility(left));
    for (const candidate of ranked) {
      const tokens = normalizedTokenEstimate(candidate);
      if (used + tokens > tokenBudget) continue;
      selected.push(candidate);
      used += tokens;
    }
    const finalIds = new Set(selected.map((candidate) => candidate.evidenceId));
    return {
      selected,
      omitted: unique
        .filter((candidate) => !finalIds.has(candidate.evidenceId))
        .map((candidate) => candidate.evidenceId),
      tokenEstimate: used,
    };
  }

  invalidateForGoal(goalVersion: number, reason: string): Promise<void> {
    return this.invalidate(
      (record) => record.goalVersion !== goalVersion,
      `goal:${String(goalVersion)}:${reason}`,
    );
  }

  invalidateForStructure(structureHash: string, reason: string): Promise<void> {
    return this.invalidate(
      (record) => record.structureHash !== structureHash,
      `structure:${structureHash}:${reason}`,
    );
  }

  async flush(): Promise<void> {
    await this.readyPromise;
    await this.writeTail;
  }

  private invalidate(
    predicate: (record: AdaptiveSummaryRecord) => boolean,
    reason: string,
  ): Promise<void> {
    return this.mutate(async () => {
      let changed = false;
      this.records = this.records.map((record) => {
        if (record.stale || !predicate(record)) return record;
        changed = true;
        return { ...record, stale: true, staleReason: reason };
      });
      if (changed) await this.persist();
    });
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
    await this.ledger.ready();
    const persisted = await this.documents.get<PersistedAdaptiveMemory>(this.scope, STORE_KEY);
    if (persisted === undefined) return;
    if (persisted.protocol !== ADAPTIVE_MEMORY_PROTOCOL) {
      throw new Error(`Unsupported adaptive memory protocol: ${String(persisted.protocol)}.`);
    }
    this.records = persisted.summaries.map(validatePersistedRecord);
  }

  private persist(): Promise<void> {
    const payload: PersistedAdaptiveMemory = {
      protocol: ADAPTIVE_MEMORY_PROTOCOL,
      summaries: this.records,
    };
    return this.documents.set(this.scope, STORE_KEY, payload);
  }

  private async knownEvidenceIds(): Promise<ReadonlySet<string>> {
    const ids = new Set<string>();
    for await (const record of this.ledger.records()) {
      if (record.evidenceId !== undefined) ids.add(record.evidenceId);
    }
    return ids;
  }
}

function validateSummaryInput(
  input: SaveAdaptiveSummaryInput,
  evidenceIds: ReadonlySet<string>,
): void {
  if (!Number.isInteger(input.goalVersion) || input.goalVersion < 0) {
    throw new Error('Adaptive summary goalVersion must be a non-negative integer.');
  }
  if (input.structureHash.length === 0) {
    throw new Error('Adaptive summary structureHash cannot be empty.');
  }
  if (input.claims.length === 0) {
    throw new Error('Adaptive summaries require at least one evidence-backed claim.');
  }
  for (const claim of input.claims) {
    if (claim.text.trim().length === 0) throw new Error('Adaptive summary claims cannot be empty.');
    if (claim.evidenceRefs.length === 0) {
      throw new Error(`Adaptive summary claim is unsupported: ${claim.text}`);
    }
    assertKnownEvidence(claim.evidenceRefs, evidenceIds);
  }
  assertKnownEvidence(input.decisiveCounterexampleRefs ?? [], evidenceIds);
  if (input.kind === 'trajectory' && input.trajectory === undefined) {
    throw new Error('Trajectory summaries require trajectory fields.');
  }
}

function assertKnownEvidence(
  references: readonly string[],
  evidenceIds: ReadonlySet<string>,
): void {
  for (const reference of references) {
    if (!evidenceIds.has(reference)) {
      throw new Error(`Adaptive summary references unknown evidence: ${reference}`);
    }
  }
}

function normalizeSummaryInput(input: SaveAdaptiveSummaryInput): SaveAdaptiveSummaryInput & {
  readonly exactDiagnostics: readonly string[];
  readonly decisiveCounterexampleRefs: readonly SaveAdaptiveSummaryInput['decisiveCounterexampleRefs'] & readonly [] | readonly any[];
  readonly artifactRefs: readonly string[];
} {
  return {
    ...input,
    claims: dedupeBy(
      input.claims.map((claim) => ({
        text: dedupeLines(claim.text),
        evidenceRefs: [...new Set(claim.evidenceRefs)].sort(),
      })),
      (claim) => `${claim.text}\u0000${claim.evidenceRefs.join(',')}`,
    ),
    trajectory:
      input.trajectory === undefined
        ? undefined
        : {
            ...input.trajectory,
            attemptedCause: dedupeLines(input.trajectory.attemptedCause),
            selectedEvaluation: dedupeLines(input.trajectory.selectedEvaluation),
            observedOutcome: dedupeLines(input.trajectory.observedOutcome),
            verifiedProgress: dedupeLines(input.trajectory.verifiedProgress),
            remainingDecision: dedupeLines(input.trajectory.remainingDecision),
            rulesSupported: [...new Set(input.trajectory.rulesSupported)].sort(),
            rulesRejected: [...new Set(input.trajectory.rulesRejected)].sort(),
            unresolvedConflicts: [...new Set(input.trajectory.unresolvedConflicts)].sort(),
            usefulArtifactRefs: [...new Set(input.trajectory.usefulArtifactRefs)].sort(),
          },
    exactDiagnostics: [...new Set((input.exactDiagnostics ?? []).map(dedupeLines))],
    decisiveCounterexampleRefs: [...new Set(input.decisiveCounterexampleRefs ?? [])],
    artifactRefs: [...new Set(input.artifactRefs ?? [])].sort(),
  };
}

function validatePersistedRecord(record: AdaptiveSummaryRecord): AdaptiveSummaryRecord {
  if (record.protocol !== ADAPTIVE_MEMORY_PROTOCOL) {
    throw new Error(`Unsupported adaptive summary protocol: ${String(record.protocol)}.`);
  }
  if (record.summaryId.length === 0 || record.contentHash.length === 0) {
    throw new Error('Persisted adaptive summary is missing identity fields.');
  }
  return record;
}

function deduplicateCandidates(
  candidates: readonly AdaptiveEvidenceCandidate[],
): readonly AdaptiveEvidenceCandidate[] {
  const byHash = new Map<string, AdaptiveEvidenceCandidate>();
  for (const candidate of candidates) {
    if (candidate.text.trim().length === 0) continue;
    const previous = byHash.get(candidate.contentHash);
    if (previous === undefined || evidenceUtility(candidate) > evidenceUtility(previous)) {
      byHash.set(candidate.contentHash, candidate);
    }
  }
  return [...byHash.values()];
}

function evidenceUtility(candidate: AdaptiveEvidenceCandidate): number {
  const relevance =
    clamp01(candidate.structuralRelevance) +
    clamp01(candidate.causalRelevance) +
    1.5 * clamp01(candidate.decisionRelevance) +
    0.5 * clamp01(candidate.recency) -
    clamp01(candidate.redundancy);
  return relevance / Math.max(1, normalizedTokenEstimate(candidate));
}

function normalizedTokenEstimate(candidate: AdaptiveEvidenceCandidate): number {
  return Math.max(1, Math.ceil(candidate.tokenEstimate));
}

function dedupeLines(value: string): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const line of value.split(/\r?\n/)) {
    const normalized = line.trim();
    if (normalized.length === 0 || seen.has(normalized)) continue;
    seen.add(normalized);
    lines.push(normalized);
  }
  return lines.join('\n');
}

function dedupeBy<T>(values: readonly T[], key: (value: T) => string): readonly T[] {
  const result = new Map<string, T>();
  for (const value of values) result.set(key(value), value);
  return [...result.values()];
}

function hashCanonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
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

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentAdaptiveMemoryService,
  AgentAdaptiveMemoryService,
  ScopeActivation.OnScopeCreated,
  'adaptiveMemory',
);
