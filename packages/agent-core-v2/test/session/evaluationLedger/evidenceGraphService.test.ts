import { describe, expect, it } from 'vitest';

import type { EvidenceId } from '#/agent/adaptiveRuntime/adaptiveProtocol';
import { SessionEvidenceGraphService } from '#/session/evaluationLedger/evidenceGraphService';
import type {
  AppendEvaluationLedgerInput,
  EvaluationLedgerHead,
  EvaluationLedgerRecord,
  ISessionEvaluationLedgerService,
} from '#/session/evaluationLedger/evaluationLedger';

const REQUEST = 'request' as EvidenceId;
const EVALUATION = 'evaluation' as EvidenceId;
const CLAIM = 'claim' as EvidenceId;
const RULE = 'rule' as EvidenceId;
const COUNTEREXAMPLE = 'counterexample' as EvidenceId;

class MemoryLedger implements ISessionEvaluationLedgerService {
  declare readonly _serviceBrand: undefined;
  readonly entries: EvaluationLedgerRecord[] = [];

  constructor() {
    this.seed('request.recorded', REQUEST, { requestId: 'request-1' });
    this.seed('evaluation.completed', EVALUATION, {
      evaluatorId: 'typescript.typecheck',
      status: 'passed',
      resultHash: 'result-hash',
    });
    this.seed('final.claim.verified', CLAIM, { claim: 'Typecheck passed.' });
    this.seed('causal.rule.proposed', RULE, { subjectRefs: ['src/a.ts'] });
    this.seed('counterexample.recorded', COUNTEREXAMPLE, { input: 'minimal-case' });
  }

  async ready(): Promise<void> {}

  async append<TPayload>(
    input: AppendEvaluationLedgerInput<TPayload>,
  ): Promise<EvaluationLedgerRecord<TPayload>> {
    const sequence = this.entries.length + 1;
    const record: EvaluationLedgerRecord<TPayload> = {
      protocol: 'adaptive-ledger/1',
      sequence,
      previousRecordHash: sequence === 1 ? null : `hash-${String(sequence - 1)}`,
      recordHash: `hash-${String(sequence)}`,
      recordType: input.recordType,
      adaptiveRunId: input.adaptiveRunId,
      evidenceId: input.evidenceId,
      payload: input.payload,
    };
    this.entries.push(record);
    return record;
  }

  async *records(): AsyncIterable<EvaluationLedgerRecord> {
    yield* this.entries;
  }

  head(): EvaluationLedgerHead {
    return {
      protocol: 'adaptive-ledger/1',
      sequence: this.entries.length,
      recordHash: this.entries.at(-1)?.recordHash ?? null,
    };
  }

  async verify() {
    return { valid: true, records: this.entries.length, head: this.head() };
  }

  async flush(): Promise<void> {}

  seed(
    recordType: EvaluationLedgerRecord['recordType'],
    evidenceId: EvidenceId,
    payload: unknown,
  ): void {
    const sequence = this.entries.length + 1;
    this.entries.push({
      protocol: 'adaptive-ledger/1',
      sequence,
      previousRecordHash: sequence === 1 ? null : `hash-${String(sequence - 1)}`,
      recordHash: `hash-${String(sequence)}`,
      recordType,
      evidenceId,
      payload,
    });
  }
}

describe('SessionEvidenceGraphService', () => {
  it('derives typed evidence nodes from immutable ledger records', async () => {
    const service = new SessionEvidenceGraphService(new MemoryLedger());
    await service.ready();
    expect(await service.getNode(REQUEST)).toMatchObject({ nodeType: 'request' });
    expect(await service.getNode(EVALUATION)).toMatchObject({
      nodeType: 'evaluation',
      artifactHash: 'result-hash',
    });
    expect(await service.getNode(RULE)).toMatchObject({
      nodeType: 'causal-rule',
      subjectRefs: ['src/a.ts'],
    });
  });

  it('rejects links whose endpoints are absent', async () => {
    const service = new SessionEvidenceGraphService(new MemoryLedger());
    await expect(
      service.appendLink({
        fromEvidenceId: 'missing' as EvidenceId,
        toEvidenceId: CLAIM,
        relation: 'supported',
      }),
    ).rejects.toThrow('source does not exist');
  });

  it('suppresses duplicate immutable links', async () => {
    const service = new SessionEvidenceGraphService(new MemoryLedger());
    const first = await service.appendLink({
      fromEvidenceId: EVALUATION,
      toEvidenceId: CLAIM,
      relation: 'verified',
    });
    const second = await service.appendLink({
      fromEvidenceId: EVALUATION,
      toEvidenceId: CLAIM,
      relation: 'verified',
    });
    expect(second.linkId).toBe(first.linkId);
    expect((await service.snapshot()).links).toHaveLength(1);
  });

  it('prevents cycles in causal provenance relations', async () => {
    const service = new SessionEvidenceGraphService(new MemoryLedger());
    await service.appendLink({
      fromEvidenceId: REQUEST,
      toEvidenceId: EVALUATION,
      relation: 'caused',
    });
    await expect(
      service.appendLink({
        fromEvidenceId: EVALUATION,
        toEvidenceId: REQUEST,
        relation: 'caused',
      }),
    ).rejects.toThrow('create a cycle');
  });

  it('permits explicitly noncausal reference cycles', async () => {
    const service = new SessionEvidenceGraphService(new MemoryLedger());
    await service.appendLink({
      fromEvidenceId: REQUEST,
      toEvidenceId: EVALUATION,
      relation: 'references',
    });
    await service.appendLink({
      fromEvidenceId: EVALUATION,
      toEvidenceId: REQUEST,
      relation: 'references',
    });
    expect((await service.snapshot()).links).toHaveLength(2);
  });

  it('returns transitive evidence supporting a final claim', async () => {
    const service = new SessionEvidenceGraphService(new MemoryLedger());
    await service.appendLink({
      fromEvidenceId: REQUEST,
      toEvidenceId: EVALUATION,
      relation: 'evaluated',
    });
    await service.appendLink({
      fromEvidenceId: EVALUATION,
      toEvidenceId: CLAIM,
      relation: 'verified',
    });
    expect(
      (await service.supportingEvidenceForClaim(CLAIM)).map((node) => node.evidenceId),
    ).toEqual([REQUEST, EVALUATION]);
  });

  it('returns counterexamples contradicting a causal rule', async () => {
    const service = new SessionEvidenceGraphService(new MemoryLedger());
    await service.appendLink({
      fromEvidenceId: COUNTEREXAMPLE,
      toEvidenceId: RULE,
      relation: 'contradicted',
    });
    expect(
      (await service.counterexamplesForRule(RULE)).map((node) => node.evidenceId),
    ).toEqual([COUNTEREXAMPLE]);
  });

  it('synchronizes ledger records appended after initialization', async () => {
    const ledger = new MemoryLedger();
    const service = new SessionEvidenceGraphService(ledger);
    await service.ready();
    const late = 'late-evidence' as EvidenceId;
    ledger.seed('tool.result.recorded', late, { artifactHash: 'late-hash' });
    expect(await service.getNode(late)).toMatchObject({
      nodeType: 'tool-result',
      artifactHash: 'late-hash',
    });
  });

  it('produces a deterministic snapshot hash', async () => {
    const service = new SessionEvidenceGraphService(new MemoryLedger());
    await service.appendLink({
      fromEvidenceId: EVALUATION,
      toEvidenceId: CLAIM,
      relation: 'verified',
    });
    expect((await service.snapshot()).hash).toBe((await service.snapshot()).hash);
  });
});
