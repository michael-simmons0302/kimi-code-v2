import { describe, expect, it } from 'vitest';

import type { IDisposable } from '#/_base/di/lifecycle';
import type { Event } from '#/_base/event';
import type { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { SessionAdaptiveExportService } from '#/app/sessionExport/adaptiveExportService';
import type { ISessionAdaptivePersistenceService } from '#/session/adaptivePersistence/adaptivePersistence';
import type { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import type { ISessionCandidateWorkspaceService } from '#/session/candidateWorkspace/candidateWorkspace';
import type { ISessionEvaluationCacheService } from '#/session/evaluation/evaluationCache';
import type {
  EvaluationLedgerRecord,
  ISessionEvaluationLedgerService,
} from '#/session/evaluationLedger/evaluationLedger';
import type { ISessionEvaluationSandbox } from '#/session/evaluationSandbox/evaluationSandbox';
import type { ISessionSearchCheckpointService } from '#/session/searchCheckpoint/searchCheckpoint';
import type { ISessionContext } from '#/session/sessionContext/sessionContext';
import type { IWorldModelCalibrationService } from '#/agent/worldModel/worldModelCalibration';

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
  async list(): Promise<readonly string[]> { return []; }
  watch(): Event<void> { return () => ({ dispose() {} }); }
  acquire(): IDisposable { return { dispose() {} }; }
}

const records: EvaluationLedgerRecord[] = [
  {
    protocol: 'adaptive-ledger/1',
    sequence: 1,
    previousRecordHash: null,
    recordHash: 'a'.repeat(64),
    recordType: 'adaptive.run.started',
    adaptiveRunId: 'run-1' as never,
    payload: {},
  },
  {
    protocol: 'adaptive-ledger/1',
    sequence: 2,
    previousRecordHash: 'a'.repeat(64),
    recordHash: 'b'.repeat(64),
    recordType: 'world_model.proposed',
    adaptiveRunId: 'run-1' as never,
    payload: { candidateId: 'candidate-1' },
  },
  {
    protocol: 'adaptive-ledger/1',
    sequence: 3,
    previousRecordHash: 'b'.repeat(64),
    recordHash: 'c'.repeat(64),
    recordType: 'evaluation.completed',
    adaptiveRunId: 'run-1' as never,
    payload: { evaluationId: 'evaluation-1' },
  },
  {
    protocol: 'adaptive-ledger/1',
    sequence: 4,
    previousRecordHash: 'c'.repeat(64),
    recordHash: 'd'.repeat(64),
    recordType: 'adaptive.run.completed',
    adaptiveRunId: 'run-1' as never,
    payload: {},
  },
];

function fixture() {
  const documents = new Documents();
  const calls: string[] = [];
  const ledger = {
    _serviceBrand: undefined,
    ready: async () => { calls.push('ledger.ready'); },
    flush: async () => { calls.push('ledger.flush'); },
    verify: async () => ({
      valid: true,
      records: records.length,
      head: { protocol: 'adaptive-ledger/1', sequence: 4, recordHash: 'd'.repeat(64) },
    }),
    records: async function* () { yield* records; },
  } as unknown as ISessionEvaluationLedgerService;
  const persistence = {
    _serviceBrand: undefined,
    ready: async () => { calls.push('persistence.ready'); },
    flush: async () => { calls.push('persistence.flush'); },
    listArtifacts: () => [
      {
        artifactHash: '1'.repeat(64),
        byteLength: 10,
        mediaType: 'text/plain',
        sensitivity: 'workspace-private',
        createdAtSequence: 1,
        referenceCount: 1,
        pinned: false,
        labels: {},
      },
      {
        artifactHash: '2'.repeat(64),
        byteLength: 10,
        mediaType: 'application/json',
        sensitivity: 'protected-evaluator',
        createdAtSequence: 2,
        referenceCount: 1,
        pinned: true,
        labels: {},
      },
    ],
  } as unknown as ISessionAdaptivePersistenceService;
  const cache = {
    _serviceBrand: undefined,
    ready: async () => { calls.push('cache.ready'); },
    flush: async () => { calls.push('cache.flush'); },
  } as unknown as ISessionEvaluationCacheService;
  const checkpoints = {
    _serviceBrand: undefined,
    ready: async () => { calls.push('checkpoints.ready'); },
    flush: async () => { calls.push('checkpoints.flush'); },
    list: () => [{ checkpointId: 'checkpoint-1' }],
  } as unknown as ISessionSearchCheckpointService;
  const sandbox = {
    _serviceBrand: undefined,
    ready: async () => { calls.push('sandbox.ready'); },
    backend: () => ({ id: 'linux-bwrap', available: true, supportedCapabilities: [] }),
  } as unknown as ISessionEvaluationSandbox;
  const workspaces = {
    _serviceBrand: undefined,
    ready: async () => { calls.push('workspaces.ready'); },
    baseline: () => ({ hash: 'baseline-hash' }),
  } as unknown as ISessionCandidateWorkspaceService;
  const calibration = {
    _serviceBrand: undefined,
    ready: async () => { calls.push('calibration.ready'); },
    flush: async () => { calls.push('calibration.flush'); },
  } as unknown as IWorldModelCalibrationService;
  const agents = {
    _serviceBrand: undefined,
    list: () => [],
  } as unknown as IAgentLifecycleService;
  const session = {
    _serviceBrand: undefined,
    scope: (subKey?: string) => subKey === undefined ? 'sessions/s1' : `sessions/s1/${subKey}`,
  } as unknown as ISessionContext;
  return {
    service: new SessionAdaptiveExportService(
      session,
      documents,
      ledger,
      persistence,
      cache,
      checkpoints,
      sandbox,
      workspaces,
      calibration,
      agents,
    ),
    calls,
    documents,
  };
}

describe('SessionAdaptiveExportService', () => {
  it('flushes adaptive state and produces a hash-verified manifest', async () => {
    const { service, calls } = fixture();
    const preparation = await service.prepare();
    expect(calls).toEqual(expect.arrayContaining([
      'ledger.ready',
      'persistence.ready',
      'cache.ready',
      'checkpoints.ready',
      'sandbox.ready',
      'workspaces.ready',
      'calibration.ready',
      'ledger.flush',
      'persistence.flush',
      'cache.flush',
      'checkpoints.flush',
      'calibration.flush',
    ]));
    expect(preparation.manifest).toMatchObject({
      protocol: 'adaptive-export-manifest/1',
      architectureVersion: 'evolve-architecture/1',
      adaptiveRunCount: 1,
      latestRunId: 'run-1',
      latestRunStatus: 'adaptive.run.completed',
      ledgerRecords: 4,
      artifactCount: 2,
      exportedArtifactCount: 1,
      redactedArtifactCount: 1,
      candidateCount: 1,
      evaluationCount: 1,
      checkpointCount: 1,
      sandboxBackend: 'linux-bwrap',
      baselineSnapshotHash: 'baseline-hash',
      verification: {
        ledgerValid: true,
        artifactIndexValid: true,
        checkpointIndexValid: true,
      },
    });
    expect(preparation.excludedArtifactHashes).toEqual(['2'.repeat(64)]);
    expect(preparation.retainedArtifactHashes).toEqual(['1'.repeat(64)]);
    expect(await service.verify(preparation.manifest)).toBe(true);
  });

  it('persists the generated manifest under the adaptive session scope', async () => {
    const { service } = fixture();
    const prepared = await service.prepare();
    expect(await service.manifest()).toEqual(prepared.manifest);
  });

  it('detects manifest tampering', async () => {
    const { service } = fixture();
    const prepared = await service.prepare();
    expect(
      await service.verify({
        ...prepared.manifest,
        evaluationCount: 99,
      }),
    ).toBe(false);
  });

  it('refuses export when the evidence ledger is invalid', async () => {
    const { service } = fixture();
    (service as unknown as { ledger: ISessionEvaluationLedgerService }).ledger = {
      _serviceBrand: undefined,
      ready: async () => {},
      flush: async () => {},
      verify: async () => ({
        valid: false,
        records: 0,
        head: { protocol: 'adaptive-ledger/1', sequence: 0, recordHash: null },
        error: 'hash mismatch',
      }),
      records: async function* () {},
    } as unknown as ISessionEvaluationLedgerService;
    await expect(service.prepare()).rejects.toThrow('ledger is invalid');
  });
});
