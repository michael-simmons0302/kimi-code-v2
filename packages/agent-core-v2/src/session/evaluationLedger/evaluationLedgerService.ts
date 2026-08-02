import { createHash } from 'node:crypto';

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ADAPTIVE_LEDGER_PROTOCOL } from '#/agent/adaptiveRuntime/adaptiveProtocol';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import {
  ISessionEvaluationLedgerService,
  type AppendEvaluationLedgerInput,
  type EvaluationLedgerHead,
  type EvaluationLedgerRecord,
  type EvaluationLedgerVerification,
} from './evaluationLedger';

const LEDGER_KEY = 'ledger.jsonl';
const LEDGER_HEAD_KEY = 'ledger-head.json';

interface UnhashedLedgerRecord<TPayload = unknown> {
  readonly protocol: typeof ADAPTIVE_LEDGER_PROTOCOL;
  readonly sequence: number;
  readonly previousRecordHash: string | null;
  readonly recordType: EvaluationLedgerRecord['recordType'];
  readonly adaptiveRunId?: EvaluationLedgerRecord['adaptiveRunId'];
  readonly evidenceId?: EvaluationLedgerRecord['evidenceId'];
  readonly payload: TPayload;
}

export class SessionEvaluationLedgerService
  extends Disposable
  implements ISessionEvaluationLedgerService
{
  declare readonly _serviceBrand: undefined;

  private readonly scope: string;
  private readonly readyPromise: Promise<void>;
  private writeTail: Promise<void> = Promise.resolve();
  private currentHead: EvaluationLedgerHead = {
    protocol: ADAPTIVE_LEDGER_PROTOCOL,
    sequence: 0,
    recordHash: null,
  };

  constructor(
    @ISessionContext session: ISessionContext,
    @IAppendLogStore private readonly appendLog: IAppendLogStore,
    @IAtomicDocumentStore private readonly documents: IAtomicDocumentStore,
  ) {
    super();
    this.scope = session.scope('adaptive');
    this._register(this.appendLog.acquire(this.scope, LEDGER_KEY));
    this._register(this.documents.acquire(this.scope, LEDGER_HEAD_KEY));
    this.readyPromise = this.restoreAndVerify();
  }

  ready(): Promise<void> {
    return this.readyPromise;
  }

  append<TPayload>(
    input: AppendEvaluationLedgerInput<TPayload>,
  ): Promise<EvaluationLedgerRecord<TPayload>> {
    let resolveResult!: (record: EvaluationLedgerRecord<TPayload>) => void;
    let rejectResult!: (error: unknown) => void;
    const result = new Promise<EvaluationLedgerRecord<TPayload>>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });

    this.writeTail = this.writeTail.then(async () => {
      await this.readyPromise;
      const sequence = this.currentHead.sequence + 1;
      const base: UnhashedLedgerRecord<TPayload> = {
        protocol: ADAPTIVE_LEDGER_PROTOCOL,
        sequence,
        previousRecordHash: this.currentHead.recordHash,
        recordType: input.recordType,
        adaptiveRunId: input.adaptiveRunId,
        evidenceId: input.evidenceId,
        payload: input.payload,
      };
      const record: EvaluationLedgerRecord<TPayload> = {
        ...base,
        recordHash: hashLedgerRecord(base),
      };
      let appendError: unknown;
      this.appendLog.append(this.scope, LEDGER_KEY, record, {
        onError: (error) => {
          appendError = error;
        },
      });
      await this.appendLog.flush();
      if (appendError !== undefined) throw appendError;

      const head: EvaluationLedgerHead = {
        protocol: ADAPTIVE_LEDGER_PROTOCOL,
        sequence,
        recordHash: record.recordHash,
      };
      await this.documents.set(this.scope, LEDGER_HEAD_KEY, head);
      this.currentHead = head;
      resolveResult(record);
    }).catch((error: unknown) => {
      rejectResult(error);
    });

    return result;
  }

  async *records(): AsyncIterable<EvaluationLedgerRecord> {
    await this.readyPromise;
    for await (const record of this.appendLog.read<EvaluationLedgerRecord>(
      this.scope,
      LEDGER_KEY,
    )) {
      yield record;
    }
  }

  head(): EvaluationLedgerHead {
    return this.currentHead;
  }

  async verify(): Promise<EvaluationLedgerVerification> {
    let expectedPrevious: string | null = null;
    let expectedSequence = 0;
    try {
      for await (const record of this.appendLog.read<EvaluationLedgerRecord>(
        this.scope,
        LEDGER_KEY,
      )) {
        expectedSequence += 1;
        if (record.protocol !== ADAPTIVE_LEDGER_PROTOCOL) {
          throw new Error(`Unsupported ledger protocol: ${String(record.protocol)}`);
        }
        if (record.sequence !== expectedSequence) {
          throw new Error(
            `Ledger sequence mismatch at ${expectedSequence}: found ${record.sequence}`,
          );
        }
        if (record.previousRecordHash !== expectedPrevious) {
          throw new Error(`Ledger previous hash mismatch at sequence ${expectedSequence}`);
        }
        const { recordHash, ...base } = record;
        const calculated = hashLedgerRecord(base);
        if (recordHash !== calculated) {
          throw new Error(`Ledger record hash mismatch at sequence ${expectedSequence}`);
        }
        expectedPrevious = recordHash;
      }
      const head: EvaluationLedgerHead = {
        protocol: ADAPTIVE_LEDGER_PROTOCOL,
        sequence: expectedSequence,
        recordHash: expectedPrevious,
      };
      return { valid: true, records: expectedSequence, head };
    } catch (error) {
      return {
        valid: false,
        records: expectedSequence,
        head: {
          protocol: ADAPTIVE_LEDGER_PROTOCOL,
          sequence: expectedSequence,
          recordHash: expectedPrevious,
        },
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async flush(): Promise<void> {
    await this.readyPromise;
    await this.writeTail;
    await this.appendLog.flush();
  }

  override dispose(): void {
    void this.flush();
    super.dispose();
  }

  private async restoreAndVerify(): Promise<void> {
    const verification = await this.verify();
    if (!verification.valid) {
      throw new Error(`Adaptive evidence ledger is corrupted: ${verification.error}`);
    }
    const storedHead = await this.documents.get<EvaluationLedgerHead>(
      this.scope,
      LEDGER_HEAD_KEY,
    );
    if (storedHead !== undefined && !headsEqual(storedHead, verification.head)) {
      throw new Error('Adaptive evidence ledger head does not match the append log.');
    }
    this.currentHead = verification.head;
    if (storedHead === undefined) {
      await this.documents.set(this.scope, LEDGER_HEAD_KEY, verification.head);
    }
  }
}

function headsEqual(left: EvaluationLedgerHead, right: EvaluationLedgerHead): boolean {
  return (
    left.protocol === right.protocol &&
    left.sequence === right.sequence &&
    left.recordHash === right.recordHash
  );
}

function hashLedgerRecord(record: UnhashedLedgerRecord): string {
  const previous = record.previousRecordHash ?? '';
  return createHash('sha256')
    .update(previous)
    .update('\n')
    .update(canonicalJson(record))
    .digest('hex');
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, current: unknown) => {
    if (
      current !== null &&
      typeof current === 'object' &&
      !Array.isArray(current) &&
      !(current instanceof Uint8Array)
    ) {
      const source = current as Record<string, unknown>;
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(source).sort()) {
        if (source[key] !== undefined) sorted[key] = source[key];
      }
      return sorted;
    }
    return current;
  });
}

registerScopedService(
  LifecycleScope.Session,
  ISessionEvaluationLedgerService,
  SessionEvaluationLedgerService,
  ScopeActivation.OnScopeCreated,
  'evaluationLedger',
);
