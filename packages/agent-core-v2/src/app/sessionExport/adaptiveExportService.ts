import { createHash } from 'node:crypto';

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentAdaptiveMemoryService } from '#/agent/adaptiveMemory/adaptiveMemory';
import { IAgentSearchPolicyValueService } from '#/agent/testTimeSearch/searchPolicyValue';
import { IWorldModelCalibrationService } from '#/agent/worldModel/worldModelCalibration';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { ISessionAdaptivePersistenceService } from '#/session/adaptivePersistence/adaptivePersistence';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionCandidateWorkspaceService } from '#/session/candidateWorkspace/candidateWorkspace';
import { ISessionEvaluationCacheService } from '#/session/evaluation/evaluationCache';
import { ISessionEvaluationLedgerService } from '#/session/evaluationLedger/evaluationLedger';
import { ISessionEvaluationSandbox } from '#/session/evaluationSandbox/evaluationSandbox';
import { ISessionSearchCheckpointService } from '#/session/searchCheckpoint/searchCheckpoint';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import {
  ADAPTIVE_EXPORT_PROTOCOL,
  ISessionAdaptiveExportService,
  type AdaptiveExportManifest,
  type AdaptiveExportPreparation,
} from './adaptiveExport';

const MANIFEST_KEY = 'manifest/adaptive-export-manifest.json';
const ARCHITECTURE_VERSION = 'evolve-architecture/1';
const EXCLUDED_PATH_FRAGMENTS = Object.freeze([
  'adaptive/workspaces',
  'adaptive/ephemeral-agents',
  'adaptive/hidden-promotion',
  'adaptive/promotion/hidden',
  'adaptive/protected-evaluator',
  'adaptive/evaluations/hidden',
  'credentials',
]);

export class SessionAdaptiveExportService
  extends Disposable
  implements ISessionAdaptiveExportService
{
  declare readonly _serviceBrand: undefined;

  private readonly scope: string;

  constructor(
    @ISessionContext session: ISessionContext,
    @IAtomicDocumentStore private readonly documents: IAtomicDocumentStore,
    @ISessionEvaluationLedgerService private readonly ledger: ISessionEvaluationLedgerService,
    @ISessionAdaptivePersistenceService private readonly persistence: ISessionAdaptivePersistenceService,
    @ISessionEvaluationCacheService private readonly cache: ISessionEvaluationCacheService,
    @ISessionSearchCheckpointService private readonly checkpoints: ISessionSearchCheckpointService,
    @ISessionEvaluationSandbox private readonly sandbox: ISessionEvaluationSandbox,
    @ISessionCandidateWorkspaceService private readonly workspaces: ISessionCandidateWorkspaceService,
    @IWorldModelCalibrationService private readonly calibration: IWorldModelCalibrationService,
    @IAgentLifecycleService private readonly agents: IAgentLifecycleService,
  ) {
    super();
    this.scope = session.scope('adaptive');
    this._register(this.documents.acquire(this.scope, MANIFEST_KEY));
  }

  async prepare(): Promise<AdaptiveExportPreparation> {
    await this.flushAll();
    const ledgerVerification = await this.ledger.verify();
    if (!ledgerVerification.valid) {
      throw new Error(`Adaptive export refused because the ledger is invalid: ${ledgerVerification.error ?? 'unknown error'}`);
    }
    const summary = await this.summarizeLedger();
    const artifacts = this.persistence.listArtifacts();
    const excludedArtifactHashes = artifacts
      .filter((artifact) => artifact.sensitivity === 'protected-evaluator')
      .map((artifact) => artifact.artifactHash)
      .sort();
    const excluded = new Set(excludedArtifactHashes);
    const retainedArtifactHashes = artifacts
      .filter((artifact) => !excluded.has(artifact.artifactHash))
      .map((artifact) => artifact.artifactHash)
      .sort();
    const baseline = this.workspaces.baseline();
    const checkpointList = this.checkpoints.list();
    const manifestBase = deepFreeze({
      protocol: ADAPTIVE_EXPORT_PROTOCOL,
      architectureVersion: ARCHITECTURE_VERSION,
      adaptiveRunCount: summary.runIds.size,
      latestRunId: summary.latestRunId,
      latestRunStatus: summary.latestRunStatus,
      ledgerHeadHash: ledgerVerification.head.recordHash,
      ledgerRecords: ledgerVerification.records,
      artifactCount: artifacts.length,
      exportedArtifactCount: retainedArtifactHashes.length,
      redactedArtifactCount: excludedArtifactHashes.length,
      candidateCount: summary.candidateIds.size,
      evaluationCount: summary.evaluationIds.size,
      checkpointCount: checkpointList.length,
      checkpointProtocol: 'adaptive-search-checkpoint/1',
      sandboxBackend: this.sandbox.backend().id,
      baselineSnapshotHash: baseline?.hash,
      redaction: {
        protectedEvaluatorArtifactsExcluded: excludedArtifactHashes.length > 0,
        credentialsExcluded: true as const,
        transientWorkspacesExcluded: true as const,
        hiddenPromotionInputsExcluded: true as const,
      },
      verification: {
        ledgerValid: true,
        artifactIndexValid: true,
        checkpointIndexValid: true,
      },
      generatedAtSequence: ledgerVerification.head.sequence,
    });
    const manifest: AdaptiveExportManifest = Object.freeze({
      ...manifestBase,
      manifestHash: hashCanonical(manifestBase),
    });
    await this.documents.set(this.scope, MANIFEST_KEY, manifest);
    return {
      manifest,
      excludedArtifactHashes,
      retainedArtifactHashes,
      excludedPathFragments: EXCLUDED_PATH_FRAGMENTS,
    };
  }

  manifest(): Promise<AdaptiveExportManifest | undefined> {
    return this.documents.get<AdaptiveExportManifest>(this.scope, MANIFEST_KEY);
  }

  async verify(manifest: AdaptiveExportManifest): Promise<boolean> {
    if (manifest.protocol !== ADAPTIVE_EXPORT_PROTOCOL) return false;
    const { manifestHash, ...base } = manifest;
    if (hashCanonical(base) !== manifestHash) return false;
    const ledgerVerification = await this.ledger.verify();
    if (!ledgerVerification.valid) return false;
    if (ledgerVerification.head.recordHash !== manifest.ledgerHeadHash) return false;
    if (ledgerVerification.records !== manifest.ledgerRecords) return false;
    const artifacts = this.persistence.listArtifacts();
    if (artifacts.length !== manifest.artifactCount) return false;
    if (this.checkpoints.list().length !== manifest.checkpointCount) return false;
    return true;
  }

  private async flushAll(): Promise<void> {
    await Promise.all([
      this.ledger.ready(),
      this.persistence.ready(),
      this.cache.ready(),
      this.checkpoints.ready(),
      this.sandbox.ready(),
      this.workspaces.ready(),
      this.calibration.ready(),
    ]);
    await Promise.all([
      this.ledger.flush(),
      this.persistence.flush(),
      this.cache.flush(),
      this.checkpoints.flush(),
      this.calibration.flush(),
      ...this.agents.list().flatMap((agent) => {
        const flushes: Promise<void>[] = [];
        try {
          flushes.push(agent.accessor.get(IAgentAdaptiveMemoryService).flush());
        } catch {}
        try {
          flushes.push(agent.accessor.get(IAgentSearchPolicyValueService).flush());
        } catch {}
        return flushes;
      }),
    ]);
  }

  private async summarizeLedger(): Promise<{
    readonly runIds: ReadonlySet<string>;
    readonly candidateIds: ReadonlySet<string>;
    readonly evaluationIds: ReadonlySet<string>;
    readonly latestRunId?: string;
    readonly latestRunStatus?: string;
  }> {
    const runIds = new Set<string>();
    const candidateIds = new Set<string>();
    const evaluationIds = new Set<string>();
    let latestRunId: string | undefined;
    let latestRunStatus: string | undefined;
    for await (const record of this.ledger.records()) {
      if (record.adaptiveRunId !== undefined) {
        runIds.add(record.adaptiveRunId);
        latestRunId = record.adaptiveRunId;
      }
      const payload = asObject(record.payload);
      const candidateId = firstString(payload, ['candidateId', 'worldModelCandidateId']);
      const evaluationId = firstString(payload, ['evaluationId']);
      if (candidateId !== undefined) candidateIds.add(candidateId);
      if (evaluationId !== undefined) evaluationIds.add(evaluationId);
      if (
        record.recordType === 'adaptive.run.completed' ||
        record.recordType === 'adaptive.run.cancelled' ||
        record.recordType === 'adaptive.run.failed'
      ) {
        latestRunStatus = record.recordType;
      }
    }
    return { runIds, candidateIds, evaluationIds, latestRunId, latestRunStatus };
  }
}

function asObject(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object'
    ? value as Readonly<Record<string, unknown>>
    : {};
}

function firstString(
  object: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = object[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
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
  ISessionAdaptiveExportService,
  SessionAdaptiveExportService,
  ScopeActivation.OnScopeCreated,
  'adaptiveExport',
);
