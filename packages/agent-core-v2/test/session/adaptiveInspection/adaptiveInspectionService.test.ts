import { describe, expect, it } from 'vitest';

import type { IAgentScopeHandle } from '#/_base/di/scope';
import { IAgentAdaptiveRuntimeService } from '#/agent/adaptiveRuntime/adaptiveRuntime';
import type { IWorldModelCalibrationService } from '#/agent/worldModel/worldModelCalibration';
import type { ISessionAdaptivePersistenceService } from '#/session/adaptivePersistence/adaptivePersistence';
import type { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { SessionAdaptiveInspectionService } from '#/session/adaptiveInspection/adaptiveInspectionService';
import type { ISessionEvidenceGraphService } from '#/session/evaluationLedger/evidenceGraph';
import type {
  EvaluationLedgerRecord,
  ISessionEvaluationLedgerService,
} from '#/session/evaluationLedger/evaluationLedger';
import type { ISessionSearchCheckpointService } from '#/session/searchCheckpoint/searchCheckpoint';
import type { ISessionStructuralSignalsService } from '#/session/structuralSignals/structuralSignals';

const records: EvaluationLedgerRecord[] = [
  {
    protocol: 'adaptive-ledger/1', sequence: 1, previousRecordHash: null,
    recordHash: 'a'.repeat(64), recordType: 'adaptive.run.started',
    adaptiveRunId: 'run-1' as never, payload: {},
  },
  {
    protocol: 'adaptive-ledger/1', sequence: 2, previousRecordHash: 'a'.repeat(64),
    recordHash: 'b'.repeat(64), recordType: 'evaluation.completed',
    adaptiveRunId: 'run-1' as never, payload: { evaluationId: 'evaluation-1' },
  },
  {
    protocol: 'adaptive-ledger/1', sequence: 3, previousRecordHash: 'b'.repeat(64),
    recordHash: 'c'.repeat(64), recordType: 'world_model.proposed',
    adaptiveRunId: 'run-1' as never, payload: { candidateId: 'candidate-1' },
  },
  {
    protocol: 'adaptive-ledger/1', sequence: 4, previousRecordHash: 'c'.repeat(64),
    recordHash: 'd'.repeat(64), recordType: 'final.claim.verified',
    adaptiveRunId: 'run-1' as never, payload: {},
  },
  {
    protocol: 'adaptive-ledger/1', sequence: 5, previousRecordHash: 'd'.repeat(64),
    recordHash: 'e'.repeat(64), recordType: 'adaptive.run.completed',
    adaptiveRunId: 'run-1' as never, payload: {},
  },
];

function fixture() {
  const runtimeStatus = {
    runId: '00000000-0000-4000-8000-000000000000' as never,
    phase: 'completed' as const,
    evaluationsCompleted: 1,
    evaluationsActive: 0,
    viableModels: 3,
    openConflicts: 1,
    normalizedPosteriorEntropy: 0.2,
    decisionWeightedUncertainty: 0.1,
    remainingBudgetFraction: 0.5,
    verifiedCandidates: 1,
  };
  const runtime = { status: () => runtimeStatus };
  const handle = {
    id: 'main',
    accessor: {
      get: (identifier: unknown) => {
        if (identifier === IAgentAdaptiveRuntimeService) return runtime;
        throw new Error('Unexpected service.');
      },
    },
  } as unknown as IAgentScopeHandle;
  const agents = {
    _serviceBrand: undefined,
    get: (agentId: string) => agentId === 'main' ? handle : undefined,
  } as unknown as IAgentLifecycleService;
  const conflicts = [{
    conflictId: 'conflict-1',
    kind: 'prediction-conflict',
    severity: 'evaluation-required',
    status: 'open',
    structureRefs: ['src/a.ts'],
    ruleIds: [],
    evidenceRefs: ['evidence-1'],
    suggestedEvaluatorIds: ['typescript.typecheck'],
  }];
  const signals = {
    _serviceBrand: undefined,
    ready: async () => {},
    conflicts: () => conflicts,
  } as unknown as ISessionStructuralSignalsService;
  const ledger = {
    _serviceBrand: undefined,
    ready: async () => {},
    verify: async () => ({
      valid: true,
      records: records.length,
      head: { protocol: 'adaptive-ledger/1', sequence: 5, recordHash: 'e'.repeat(64) },
    }),
    records: async function* () { yield* records; },
  } as unknown as ISessionEvaluationLedgerService;
  const evidenceGraph = {
    _serviceBrand: undefined,
    ready: async () => {},
    snapshot: async () => ({
      protocol: 'adaptive-evidence-graph/1',
      nodes: [{ evidenceId: 'evidence-1' }],
      links: [{ linkId: 'link-1' }],
      hash: 'graph-hash',
    }),
  } as unknown as ISessionEvidenceGraphService;
  const checkpointService = {
    _serviceBrand: undefined,
    ready: async () => {},
    list: () => [{
      checkpointId: 'checkpoint-1',
      createdAtSequence: 4,
      reason: 'after evaluation',
    }],
  } as unknown as ISessionSearchCheckpointService;
  const persistence = {
    _serviceBrand: undefined,
    ready: async () => {},
    listArtifacts: () => [
      {
        artifactHash: '1'.repeat(64), byteLength: 10, mediaType: 'text/plain',
        sensitivity: 'workspace-private', createdAtSequence: 1,
        referenceCount: 1, pinned: false, labels: {},
      },
      {
        artifactHash: '2'.repeat(64), byteLength: 10, mediaType: 'application/json',
        sensitivity: 'protected-evaluator', createdAtSequence: 2,
        referenceCount: 1, pinned: true, labels: { hiddenCase: 'true' },
      },
    ],
  } as unknown as ISessionAdaptivePersistenceService;
  const calibration = {
    _serviceBrand: undefined,
    ready: async () => {},
    snapshot: () => ({
      protocol: 'adaptive-calibration/1',
      observations: [],
      hash: 'calibration-hash',
      metrics: [{
        protocol: 'adaptive-calibration/1',
        evaluatorFamily: 'typescript.typecheck',
        modelLineage: 'lineage-a',
        observations: 20,
        booleanAndCategoricalObservations: 20,
        intervalObservations: 0,
        brierScore: 0.01,
        logLoss: 0.05,
        reliabilityBins: [],
        status: 'calibrated',
        informationGainMultiplier: 1,
        promotionEligible: true,
        regimeShift: false,
        updatedAtSequence: 20,
      }],
    }),
  } as unknown as IWorldModelCalibrationService;
  return {
    service: new SessionAdaptiveInspectionService(
      agents,
      signals,
      ledger,
      evidenceGraph,
      checkpointService,
      persistence,
      calibration,
    ),
    runtimeStatus,
  };
}

describe('SessionAdaptiveInspectionService', () => {
  it('returns the selected agent adaptive status', () => {
    const { service, runtimeStatus } = fixture();
    expect(service.status()).toEqual(runtimeStatus);
    expect(service.status('missing')).toBeUndefined();
  });

  it('summarizes runs without exposing private search state', async () => {
    const { service } = fixture();
    expect(await service.runs()).toEqual([{
      runId: 'run-1',
      status: 'adaptive.run.completed',
      firstSequence: 1,
      lastSequence: 5,
      evaluations: 1,
      candidates: 1,
      finalClaims: 1,
    }]);
  });

  it('reports immutable conflicts, evidence counts, and checkpoint metadata', async () => {
    const { service } = fixture();
    expect(service.conflicts()).toMatchObject([{ conflictId: 'conflict-1' }]);
    expect(await service.evidence()).toMatchObject({
      ledgerValid: true,
      ledgerRecords: 5,
      evidenceNodes: 1,
      evidenceLinks: 1,
      recordTypeCounts: {
        'adaptive.run.started': 1,
        'evaluation.completed': 1,
        'world_model.proposed': 1,
        'final.claim.verified': 1,
        'adaptive.run.completed': 1,
      },
    });
    expect(service.checkpoints()).toEqual({
      count: 1,
      latestCheckpointId: 'checkpoint-1',
      latestSequence: 4,
      latestReason: 'after evaluation',
    });
  });

  it('excludes protected evaluator artifacts from inspection', () => {
    const { service } = fixture();
    expect(service.artifacts()).toHaveLength(1);
    expect(service.artifacts()[0]?.artifactHash).toBe('1'.repeat(64));
    expect(JSON.stringify(service.artifacts())).not.toContain('hiddenCase');
  });

  it('returns bounded calibration metrics without observations', () => {
    const { service } = fixture();
    expect(service.calibration()).toMatchObject([{
      evaluatorFamily: 'typescript.typecheck',
      status: 'calibrated',
      promotionEligible: true,
    }]);
  });

  it('produces a deterministic tamper-evident inspection snapshot', async () => {
    const { service } = fixture();
    const first = await service.snapshot();
    const second = await service.snapshot();
    expect(first.snapshotHash).toBe(second.snapshotHash);
    expect(first).toMatchObject({
      protocol: 'adaptive-inspection/1',
      runs: [{ runId: 'run-1' }],
      checkpoints: { count: 1 },
      generatedAtSequence: 5,
    });
    const serialized = JSON.stringify(first);
    expect(serialized).not.toMatch(/prompt|searchNode|hiddenCase/i);
  });
});
