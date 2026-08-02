import { createHash } from 'node:crypto';

import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentAdaptiveRuntimeService } from '#/agent/adaptiveRuntime/adaptiveRuntime';
import { IWorldModelCalibrationService } from '#/agent/worldModel/worldModelCalibration';
import { ISessionAdaptivePersistenceService } from '#/session/adaptivePersistence/adaptivePersistence';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionEvidenceGraphService } from '#/session/evaluationLedger/evidenceGraph';
import { ISessionEvaluationLedgerService } from '#/session/evaluationLedger/evaluationLedger';
import { ISessionSearchCheckpointService } from '#/session/searchCheckpoint/searchCheckpoint';
import { ISessionStructuralSignalsService } from '#/session/structuralSignals/structuralSignals';
import {
  ADAPTIVE_INSPECTION_PROTOCOL,
  ISessionAdaptiveInspectionService,
  type AdaptiveCheckpointInspection,
  type AdaptiveEvidenceInspection,
  type AdaptiveInspectionSnapshot,
  type AdaptiveRunInspection,
} from './adaptiveInspection';

export class SessionAdaptiveInspectionService
  implements ISessionAdaptiveInspectionService
{
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentLifecycleService private readonly agents: IAgentLifecycleService,
    @ISessionStructuralSignalsService private readonly signals: ISessionStructuralSignalsService,
    @ISessionEvaluationLedgerService private readonly ledger: ISessionEvaluationLedgerService,
    @ISessionEvidenceGraphService private readonly evidenceGraph: ISessionEvidenceGraphService,
    @ISessionSearchCheckpointService private readonly checkpointService: ISessionSearchCheckpointService,
    @ISessionAdaptivePersistenceService private readonly persistence: ISessionAdaptivePersistenceService,
    @IWorldModelCalibrationService private readonly calibrationService: IWorldModelCalibrationService,
  ) {}

  async ready(): Promise<void> {
    await Promise.all([
      this.signals.ready(),
      this.ledger.ready(),
      this.evidenceGraph.ready(),
      this.checkpointService.ready(),
      this.persistence.ready(),
      this.calibrationService.ready(),
    ]);
  }

  status(agentId = MAIN_AGENT_ID) {
    const handle = this.agents.get(agentId);
    if (handle === undefined) return undefined;
    try {
      return handle.accessor.get(IAgentAdaptiveRuntimeService).status();
    } catch {
      return undefined;
    }
  }

  async runs(): Promise<readonly AdaptiveRunInspection[]> {
    await this.ledger.ready();
    const runs = new Map<string, {
      firstSequence: number;
      lastSequence: number;
      status: string;
      evaluations: Set<string>;
      candidates: Set<string>;
      finalClaims: number;
    }>();
    for await (const record of this.ledger.records()) {
      const runId = record.adaptiveRunId;
      if (runId === undefined) continue;
      const existing = runs.get(runId) ?? {
        firstSequence: record.sequence,
        lastSequence: record.sequence,
        status: 'active',
        evaluations: new Set<string>(),
        candidates: new Set<string>(),
        finalClaims: 0,
      };
      existing.firstSequence = Math.min(existing.firstSequence, record.sequence);
      existing.lastSequence = Math.max(existing.lastSequence, record.sequence);
      const payload = asObject(record.payload);
      const evaluationId = stringField(payload, 'evaluationId');
      const candidateId = stringField(payload, 'candidateId') ??
        stringField(payload, 'worldModelCandidateId');
      if (evaluationId !== undefined) existing.evaluations.add(evaluationId);
      if (candidateId !== undefined) existing.candidates.add(candidateId);
      if (record.recordType === 'final.claim.verified') existing.finalClaims += 1;
      if (
        record.recordType === 'adaptive.run.completed' ||
        record.recordType === 'adaptive.run.cancelled' ||
        record.recordType === 'adaptive.run.failed'
      ) {
        existing.status = record.recordType;
      }
      runs.set(runId, existing);
    }
    return [...runs.entries()]
      .map(([runId, run]): AdaptiveRunInspection => ({
        runId,
        status: run.status,
        firstSequence: run.firstSequence,
        lastSequence: run.lastSequence,
        evaluations: run.evaluations.size,
        candidates: run.candidates.size,
        finalClaims: run.finalClaims,
      }))
      .sort((left, right) => left.firstSequence - right.firstSequence);
  }

  conflicts() {
    return this.signals.conflicts().map((conflict) => deepFreeze(structuredClone(conflict)));
  }

  async evidence(): Promise<AdaptiveEvidenceInspection> {
    const [verification, graph] = await Promise.all([
      this.ledger.verify(),
      this.evidenceGraph.snapshot(),
    ]);
    const counts: Record<string, number> = {};
    for await (const record of this.ledger.records()) {
      counts[record.recordType] = (counts[record.recordType] ?? 0) + 1;
    }
    return Object.freeze({
      ledgerValid: verification.valid,
      ledgerRecords: verification.records,
      ledgerHeadHash: verification.head.recordHash,
      evidenceNodes: graph.nodes.length,
      evidenceLinks: graph.links.length,
      recordTypeCounts: Object.freeze(
        Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right))),
      ),
    });
  }

  checkpoints(): AdaptiveCheckpointInspection {
    const checkpoints = this.checkpointService.list();
    const latest = checkpoints.at(-1);
    return Object.freeze({
      count: checkpoints.length,
      latestCheckpointId: latest?.checkpointId,
      latestSequence: latest?.createdAtSequence,
      latestReason: latest?.reason,
    });
  }

  artifacts() {
    return this.persistence
      .listArtifacts()
      .filter((artifact) => artifact.sensitivity !== 'protected-evaluator')
      .map((artifact) => deepFreeze(structuredClone(artifact)));
  }

  calibration() {
    return this.calibrationService
      .snapshot()
      .metrics
      .map((metrics) => deepFreeze(structuredClone(metrics)));
  }

  async snapshot(agentId = MAIN_AGENT_ID): Promise<AdaptiveInspectionSnapshot> {
    await this.ready();
    const [runs, evidence] = await Promise.all([this.runs(), this.evidence()]);
    const base = deepFreeze({
      protocol: ADAPTIVE_INSPECTION_PROTOCOL,
      status: this.status(agentId),
      runs,
      conflicts: this.conflicts(),
      evidence,
      checkpoints: this.checkpoints(),
      artifacts: this.artifacts(),
      calibration: this.calibration(),
      generatedAtSequence: evidence.ledgerRecords,
    });
    return Object.freeze({
      ...base,
      snapshotHash: hashCanonical(base),
    });
  }
}

function asObject(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object'
    ? value as Readonly<Record<string, unknown>>
    : {};
}

function stringField(
  object: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = object[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function hashCanonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, current: unknown) => {
    if (current !== null && typeof current === 'object' && !Array.isArray(current)) {
      const object = current as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(object)
          .sort()
          .filter((key) => object[key] !== undefined)
          .map((key) => [key, object[key]]),
      );
    }
    return current;
  });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

registerScopedService(
  LifecycleScope.Session,
  ISessionAdaptiveInspectionService,
  SessionAdaptiveInspectionService,
  ScopeActivation.OnScopeCreated,
  'adaptiveInspection',
);
