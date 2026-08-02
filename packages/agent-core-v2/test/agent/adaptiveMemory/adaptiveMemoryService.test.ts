import { describe, expect, it } from 'vitest';

import type { IDisposable } from '#/_base/di/lifecycle';
import type { Event } from '#/_base/event';
import type { EvidenceId } from '#/agent/adaptiveRuntime/adaptiveProtocol';
import type { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import type { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import type {
  EvaluationLedgerHead,
  EvaluationLedgerRecord,
  ISessionEvaluationLedgerService,
} from '#/session/evaluationLedger/evaluationLedger';
import { AgentAdaptiveMemoryService } from '#/agent/adaptiveMemory/adaptiveMemoryService';

const EVIDENCE_A = 'evidence-a' as EvidenceId;
const EVIDENCE_B = 'evidence-b' as EvidenceId;

class MemoryDocuments implements IAtomicDocumentStore {
  declare readonly _serviceBrand: undefined;
  readonly values = new Map<string, unknown>();

  async get<T>(scope: string, key: string): Promise<T | undefined> {
    return this.values.get(`${scope}/${key}`) as T | undefined;
  }

  async set<T>(scope: string, key: string, value: T): Promise<void> {
    this.values.set(`${scope}/${key}`, structuredClone(value));
  }

  async delete(scope: string, key: string): Promise<void> {
    this.values.delete(`${scope}/${key}`);
  }

  async list(scope: string, prefix = ''): Promise<readonly string[]> {
    const start = `${scope}/`;
    return [...this.values.keys()]
      .filter((key) => key.startsWith(start))
      .map((key) => key.slice(start.length))
      .filter((key) => key.startsWith(prefix));
  }

  watch(): Event<void> {
    return () => ({ dispose() {} });
  }

  acquire(): IDisposable {
    return { dispose() {} };
  }
}

class MemoryLedger implements ISessionEvaluationLedgerService {
  declare readonly _serviceBrand: undefined;
  private readonly ledgerRecords: EvaluationLedgerRecord[] = [
    record(1, EVIDENCE_A),
    record(2, EVIDENCE_B),
  ];

  async ready(): Promise<void> {}
  async append(): Promise<never> {
    throw new Error('append is not used by this test');
  }
  async *records(): AsyncIterable<EvaluationLedgerRecord> {
    yield* this.ledgerRecords;
  }
  head(): EvaluationLedgerHead {
    return { protocol: 'adaptive-ledger/1', sequence: 2, recordHash: 'head' };
  }
  async verify() {
    return { valid: true, records: 2, head: this.head() };
  }
  async flush(): Promise<void> {}
}

function record(sequence: number, evidenceId: EvidenceId): EvaluationLedgerRecord {
  return {
    protocol: 'adaptive-ledger/1',
    sequence,
    previousRecordHash: sequence === 1 ? null : 'previous',
    recordHash: `hash-${String(sequence)}`,
    recordType: 'evaluation.completed',
    evidenceId,
    payload: {},
  };
}

function service(documents = new MemoryDocuments()): {
  readonly service: AgentAdaptiveMemoryService;
  readonly documents: MemoryDocuments;
} {
  const agent: IAgentScopeContext = {
    _serviceBrand: undefined,
    agentId: 'main',
    scope: (key = '') => (key.length === 0 ? 'agents/main' : `agents/main/${key}`),
  };
  return {
    service: new AgentAdaptiveMemoryService(agent, documents, new MemoryLedger()),
    documents,
  };
}

describe('AgentAdaptiveMemoryService', () => {
  it('rejects unsupported summary claims', async () => {
    const { service: memory } = service();
    await memory.ready();
    await expect(
      memory.saveSummary({
        kind: 'verified-progress',
        goalVersion: 1,
        structureHash: 'structure-a',
        claims: [{ text: 'Tests passed.', evidenceRefs: [] }],
      }),
    ).rejects.toThrow('unsupported');
  });

  it('rejects unknown evidence references', async () => {
    const { service: memory } = service();
    await expect(
      memory.saveSummary({
        kind: 'failure',
        goalVersion: 1,
        structureHash: 'structure-a',
        claims: [
          {
            text: 'The evaluator failed.',
            evidenceRefs: ['missing' as EvidenceId],
          },
        ],
      }),
    ).rejects.toThrow('unknown evidence');
  });

  it('deduplicates narration while preserving evidence and exact diagnostics', async () => {
    const { service: memory } = service();
    const saved = await memory.saveSummary({
      kind: 'trajectory',
      goalVersion: 1,
      structureHash: 'structure-a',
      claims: [
        {
          text: 'The typecheck failed.\nThe typecheck failed.',
          evidenceRefs: [EVIDENCE_A, EVIDENCE_A],
        },
      ],
      trajectory: {
        attemptedCause: 'Missing registration.\nMissing registration.',
        selectedEvaluation: 'Run typecheck.',
        observedOutcome: 'Typecheck failed.',
        rulesSupported: ['rule-a', 'rule-a'],
        rulesRejected: [],
        unresolvedConflicts: ['conflict-a', 'conflict-a'],
        usefulArtifactRefs: ['artifact-a', 'artifact-a'],
        verifiedProgress: 'Registration added.',
        remainingDecision: 'Re-run typecheck.',
      },
      exactDiagnostics: ['TS2345: mismatch', 'TS2345: mismatch'],
      decisiveCounterexampleRefs: [EVIDENCE_B, EVIDENCE_B],
    });
    expect(saved.claims).toEqual([
      { text: 'The typecheck failed.', evidenceRefs: [EVIDENCE_A] },
    ]);
    expect(saved.trajectory?.rulesSupported).toEqual(['rule-a']);
    expect(saved.exactDiagnostics).toEqual(['TS2345: mismatch']);
    expect(saved.decisiveCounterexampleRefs).toEqual([EVIDENCE_B]);
  });

  it('returns the existing record for an identical active summary', async () => {
    const { service: memory } = service();
    const input = {
      kind: 'verified-progress' as const,
      goalVersion: 1,
      structureHash: 'structure-a',
      claims: [{ text: 'A gate passed.', evidenceRefs: [EVIDENCE_A] }],
    };
    const first = await memory.saveSummary(input);
    const second = await memory.saveSummary(input);
    expect(second.summaryId).toBe(first.summaryId);
    expect(memory.summaries()).toHaveLength(1);
  });

  it('rehydrates summaries from the atomic document store', async () => {
    const first = service();
    await first.service.saveSummary({
      kind: 'verified-progress',
      goalVersion: 1,
      structureHash: 'structure-a',
      claims: [{ text: 'A gate passed.', evidenceRefs: [EVIDENCE_A] }],
    });
    await first.service.flush();
    const second = service(first.documents);
    await second.service.ready();
    expect(second.service.summaries()).toHaveLength(1);
  });

  it('preserves mandatory evidence and ranks remaining evidence within budget', () => {
    const { service: memory } = service();
    const selection = memory.selectEvidence(
      [
        candidate(EVIDENCE_A, 'diagnostic', 4, {
          exactDiagnostic: true,
          decisionRelevance: 0.2,
        }),
        candidate(EVIDENCE_B, 'high-value', 4, {
          decisionRelevance: 1,
          causalRelevance: 1,
        }),
        candidate('evidence-c' as EvidenceId, 'low-value', 4, {
          redundancy: 1,
        }),
      ],
      8,
    );
    expect(selection.selected.map((entry) => entry.text)).toEqual([
      'diagnostic',
      'high-value',
    ]);
    expect(selection.tokenEstimate).toBe(8);
  });

  it('deduplicates candidates by content hash', () => {
    const { service: memory } = service();
    const selection = memory.selectEvidence(
      [
        { ...candidate(EVIDENCE_A, 'same', 2), contentHash: 'same-hash' },
        {
          ...candidate(EVIDENCE_B, 'same', 2, { decisionRelevance: 1 }),
          contentHash: 'same-hash',
        },
      ],
      10,
    );
    expect(selection.selected).toHaveLength(1);
    expect(selection.selected[0]?.evidenceId).toBe(EVIDENCE_B);
  });

  it('fails rather than dropping mandatory evidence when the budget is too small', () => {
    const { service: memory } = service();
    expect(() =>
      memory.selectEvidence(
        [candidate(EVIDENCE_A, 'counterexample', 20, { decisiveCounterexample: true })],
        10,
      ),
    ).toThrow('cannot preserve');
  });

  it('marks incompatible goal and structure summaries stale without deleting history', async () => {
    const { service: memory } = service();
    await memory.saveSummary({
      kind: 'verified-progress',
      goalVersion: 1,
      structureHash: 'structure-a',
      claims: [{ text: 'A gate passed.', evidenceRefs: [EVIDENCE_A] }],
    });
    await memory.invalidateForGoal(2, 'user steering');
    expect(memory.summaries()).toHaveLength(0);
    expect(memory.summaries({ includeStale: true })[0]).toMatchObject({
      stale: true,
      staleReason: 'goal:2:user steering',
    });
  });
});

function candidate(
  evidenceId: EvidenceId,
  text: string,
  tokenEstimate: number,
  overrides: Partial<{
    structuralRelevance: number;
    causalRelevance: number;
    decisionRelevance: number;
    recency: number;
    redundancy: number;
    exactDiagnostic: boolean;
    decisiveCounterexample: boolean;
  }> = {},
) {
  return {
    evidenceId,
    text,
    contentHash: `hash:${text}`,
    tokenEstimate,
    structuralRelevance: overrides.structuralRelevance ?? 0.5,
    causalRelevance: overrides.causalRelevance ?? 0.5,
    decisionRelevance: overrides.decisionRelevance ?? 0.5,
    recency: overrides.recency ?? 0.5,
    redundancy: overrides.redundancy ?? 0,
    exactDiagnostic: overrides.exactDiagnostic,
    decisiveCounterexample: overrides.decisiveCounterexample,
  };
}
