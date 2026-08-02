import { describe, expect, it } from 'vitest';

import type { IDisposable } from '#/_base/di/lifecycle';
import type { Event } from '#/_base/event';
import type { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import type { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import type { ISessionContext } from '#/session/sessionContext/sessionContext';
import { SessionSearchCheckpointService } from '#/session/searchCheckpoint/searchCheckpointService';
import type { SearchCheckpointInput } from '#/session/searchCheckpoint/searchCheckpoint';
import type {
  EvaluationLedgerHead,
  EvaluationLedgerRecord,
  ISessionEvaluationLedgerService,
} from '#/session/evaluationLedger/evaluationLedger';

const LEDGER_A = 'a'.repeat(64);
const LEDGER_B = 'b'.repeat(64);

class AppendLog {
  readonly entries = new Map<string, unknown[]>();
  append(scope: string, key: string, value: unknown, options?: { onError?: (error: unknown) => void }) {
    try {
      const identity = `${scope}/${key}`;
      const values = this.entries.get(identity) ?? [];
      values.push(structuredClone(value));
      this.entries.set(identity, values);
    } catch (error) {
      options?.onError?.(error);
    }
  }
  async *read<T>(scope: string, key: string): AsyncIterable<T> {
    for (const value of this.entries.get(`${scope}/${key}`) ?? []) {
      yield structuredClone(value) as T;
    }
  }
  async flush(): Promise<void> {}
  acquire(): IDisposable { return { dispose() {} }; }
}

class Documents implements IAtomicDocumentStore {
  declare readonly _serviceBrand: undefined;
  readonly values = new Map<string, unknown>();
  async get<T>(scope: string, key: string): Promise<T | undefined> {
    return structuredClone(this.values.get(`${scope}/${key}`)) as T | undefined;
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
  watch(): Event<void> { return () => ({ dispose() {} }); }
  acquire(): IDisposable { return { dispose() {} }; }
}

class Ledger implements ISessionEvaluationLedgerService {
  declare readonly _serviceBrand: undefined;
  readonly entries: EvaluationLedgerRecord[] = [
    {
      protocol: 'adaptive-ledger/1',
      sequence: 1,
      previousRecordHash: null,
      recordHash: LEDGER_A,
      recordType: 'adaptive.run.started',
      payload: {},
    },
    {
      protocol: 'adaptive-ledger/1',
      sequence: 2,
      previousRecordHash: LEDGER_A,
      recordHash: LEDGER_B,
      recordType: 'search.action.selected',
      payload: {},
    },
  ];
  async ready(): Promise<void> {}
  async append(): Promise<never> { throw new Error('unused'); }
  async *records(): AsyncIterable<EvaluationLedgerRecord> { yield* this.entries; }
  head(): EvaluationLedgerHead {
    return { protocol: 'adaptive-ledger/1', sequence: 2, recordHash: LEDGER_B };
  }
  async verify() { return { valid: true, records: 2, head: this.head() }; }
  async flush(): Promise<void> {}
}

const session = {
  _serviceBrand: undefined,
  cwd: '/workspace',
  scope: (subKey?: string) => subKey === undefined ? 'sessions/s1' : `sessions/s1/${subKey}`,
} as unknown as ISessionContext;

function fixture(
  append = new AppendLog(),
  documents = new Documents(),
  ledger = new Ledger(),
) {
  return {
    service: new SessionSearchCheckpointService(
      session,
      append as unknown as IAppendLogStore,
      documents,
      ledger,
    ),
    append,
    documents,
    ledger,
  };
}

function input(
  sequence: number,
  overrides: Partial<SearchCheckpointInput<{ root: string }>> = {},
): SearchCheckpointInput<{ root: string }> {
  return {
    ledgerHeadHash: sequence === 1 ? LEDGER_A : LEDGER_B,
    createdAtSequence: sequence,
    architectureVersion: 'evolve-architecture/1',
    protocolVersions: {
      ledger: 'adaptive-ledger/1',
      search: 'adaptive-search-checkpoint/1',
    },
    state: { root: `root-${String(sequence)}` },
    budget: {
      maxInputTokens: 100,
      maxOutputTokens: 100,
      maxToolCalls: 10,
      maxEvaluationRuns: 10,
      maxModelProposalCount: 10,
      maxWallMs: 1000,
      maxCpuMs: 1000,
      maxDiskBytes: 1000,
      maxCandidates: 10,
    },
    cost: {
      inputTokens: 0,
      outputTokens: 0,
      toolCalls: 0,
      evaluationRuns: 0,
      modelProposalCount: 0,
      wallMs: 0,
      cpuMs: 0,
      diskBytes: 0,
    },
    randomStates: [{ generatorId: 'search', state: `state-${String(sequence)}` }],
    activeEvaluators: [],
    frontierTemperature: 0.75,
    transpositions: {
      entries: sequence,
      hits: 0,
      evictions: 0,
      hash: 'c'.repeat(64),
    },
    reason: `checkpoint-${String(sequence)}`,
    ...overrides,
  };
}

const compatibility = {
  architectureVersion: 'evolve-architecture/1',
  protocolVersions: {
    ledger: 'adaptive-ledger/1',
    search: 'adaptive-search-checkpoint/1',
  },
};

describe('SessionSearchCheckpointService', () => {
  it('commits an append-only checkpoint chain and atomic head', async () => {
    const { service } = fixture();
    const first = await service.commit(input(1));
    const second = await service.commit(input(2));
    expect(first.previousCheckpointHash).toBeNull();
    expect(second.previousCheckpointHash).toBe(first.checkpointHash);
    expect(service.latest()?.checkpointHash).toBe(second.checkpointHash);
    expect(service.list()).toHaveLength(2);
  });

  it('restores checkpoints across service reconstruction', async () => {
    const first = fixture();
    const checkpoint = await first.service.commit(input(1));
    await first.service.flush();
    const second = fixture(first.append, first.documents, first.ledger);
    await second.service.ready();
    expect(second.service.latest()?.checkpointHash).toBe(checkpoint.checkpointHash);
  });

  it('recovers the latest compatible checkpoint', async () => {
    const { service } = fixture();
    const first = await service.commit(input(1));
    await service.commit(input(2, { architectureVersion: 'evolve-architecture/2' }));
    const recovered = await service.recover(compatibility);
    expect(recovered.checkpoint?.checkpointHash).toBe(first.checkpointHash);
    expect(recovered.recoveredFromPrior).toBe(true);
    expect(recovered.rejected[0]?.reason).toContain('architecture');
  });

  it('rejects protocol-incompatible checkpoints', async () => {
    const { service } = fixture();
    await service.commit(input(1, {
      protocolVersions: { ledger: 'adaptive-ledger/2', search: 'adaptive-search-checkpoint/1' },
    }));
    const recovered = await service.recover(compatibility);
    expect(recovered.checkpoint).toBeUndefined();
    expect(recovered.rejected[0]?.reason).toContain('protocol ledger differs');
  });

  it('rejects checkpoints whose ledger head is unknown', async () => {
    const { service } = fixture();
    await expect(
      service.commit(input(1, { ledgerHeadHash: 'f'.repeat(64) })),
    ).rejects.toThrow('unknown ledger head');
  });

  it('rejects invalid frontier temperatures and duplicate random generators', async () => {
    const { service } = fixture();
    await expect(
      service.commit(input(1, { frontierTemperature: 0 })),
    ).rejects.toThrow('frontierTemperature');
    await expect(
      service.commit(input(1, {
        randomStates: [
          { generatorId: 'search', state: 'a' },
          { generatorId: 'search', state: 'b' },
        ],
      })),
    ).rejects.toThrow('Duplicate search random generator');
  });

  it('detects a corrupted checkpoint hash during restore', async () => {
    const first = fixture();
    await first.service.commit(input(1));
    const key = 'sessions/s1/adaptive/search-checkpoints.jsonl';
    const entry = first.append.entries.get(key)?.[0] as Record<string, unknown>;
    entry['checkpointHash'] = '0'.repeat(64);
    const second = fixture(first.append, first.documents, first.ledger);
    await expect(second.service.ready()).rejects.toThrow('hash mismatch');
  });

  it('detects an atomic head that disagrees with the checkpoint log', async () => {
    const first = fixture();
    await first.service.commit(input(1));
    first.documents.values.set('sessions/s1/adaptive/search-checkpoint-head.json', {
      protocol: 'adaptive-search-checkpoint/1',
      checkpointId: 'wrong',
      checkpointHash: '0'.repeat(64),
      sequence: 1,
    });
    const second = fixture(first.append, first.documents, first.ledger);
    await expect(second.service.ready()).rejects.toThrow('atomic head');
  });
});
