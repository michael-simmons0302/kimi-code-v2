import { createHash, randomUUID } from 'node:crypto';

import { Disposable, type IDisposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import type { ConflictId } from '#/agent/adaptiveRuntime/adaptiveProtocol';
import { IEventBus, type DomainEvent } from '#/app/event/eventBus';
import { IHostFsWatchService, type HostFsChange } from '#/os/interface/hostFsWatch';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionCodeStructureService } from '#/session/codeStructure/codeStructure';
import { ISessionEvaluationLedgerService } from '#/session/evaluationLedger/evaluationLedger';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import {
  ISessionStructuralSignalsService,
  type StructuralConflict,
  type StructuralConflictKind,
  type StructuralSignal,
  type StructuralSignalEnvelope,
  type StructuralSignalSource,
} from './structuralSignals';

const SIGNAL_LOG_KEY = 'signals.jsonl';
const REDUCER_STATE_KEY = 'signal-reducer.json';
const QUEUE_CAPACITY = 10_000;
const FILE_DEBOUNCE_MS = 100;

interface ReducerState {
  readonly protocol: 'structural-signals/1';
  readonly lastSequence: number;
  readonly lastAllocatedSequence: number;
  readonly conflicts: readonly StructuralConflict[];
  readonly occurrences: Readonly<Record<string, number>>;
}

export class SessionStructuralSignalsService
  extends Disposable
  implements ISessionStructuralSignalsService
{
  declare readonly _serviceBrand: undefined;

  private readonly scope: string;
  private readonly readyPromise: Promise<void>;
  private reducer: ReducerState = {
    protocol: 'structural-signals/1',
    lastSequence: 0,
    lastAllocatedSequence: 0,
    conflicts: [],
    occurrences: {},
  };
  private queue: Promise<void> = Promise.resolve();
  private queuedOperations = 0;
  private readonly agentSubscriptions = new Map<string, IDisposable>();
  private readonly pendingFileChanges = new Map<string, HostFsChange>();
  private fileTimer: NodeJS.Timeout | undefined;

  constructor(
    @ISessionContext private readonly session: ISessionContext,
    @IAgentLifecycleService private readonly agents: IAgentLifecycleService,
    @IHostFsWatchService watch: IHostFsWatchService,
    @IAppendLogStore private readonly appendLog: IAppendLogStore,
    @IAtomicDocumentStore private readonly documents: IAtomicDocumentStore,
    @ISessionCodeStructureService private readonly structure: ISessionCodeStructureService,
    @ISessionEvaluationLedgerService private readonly ledger: ISessionEvaluationLedgerService,
  ) {
    super();
    this.scope = session.scope('adaptive');
    this._register(this.appendLog.acquire(this.scope, SIGNAL_LOG_KEY));
    this._register(this.documents.acquire(this.scope, REDUCER_STATE_KEY));
    this.readyPromise = this.restore();

    for (const agent of agents.list()) this.attachAgent(agent.id, agent.accessor.get(IEventBus));
    this._register(agents.onDidCreate((agent) => this.attachAgent(agent.id, agent.accessor.get(IEventBus))));
    this._register(agents.onDidDispose((agentId) => this.detachAgent(agentId)));

    const watcher = watch.watch(session.cwd, {
      recursive: true,
      ignored: (path) =>
        path.includes('/.git/') ||
        path.includes('/node_modules/') ||
        path.includes('/adaptive/workspaces/'),
    });
    this._register(watcher);
    this._register(watcher.onDidChange((change) => this.onFileChange(change)));
  }

  ready(): Promise<void> {
    return this.readyPromise;
  }

  enqueue(
    source: StructuralSignalSource,
    payload: StructuralSignal,
    options: {
      readonly sourceAgentId?: string;
      readonly workspaceSnapshotHash?: string;
    } = {},
  ): Promise<StructuralSignalEnvelope> {
    if (this.queuedOperations >= QUEUE_CAPACITY) {
      return this.enqueueOverflow().then(() => {
        throw new Error('Structural signal queue capacity exceeded.');
      });
    }
    this.queuedOperations += 1;
    let resolveResult!: (envelope: StructuralSignalEnvelope) => void;
    let rejectResult!: (error: unknown) => void;
    const result = new Promise<StructuralSignalEnvelope>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    this.queue = this.queue
      .then(async () => {
        await this.readyPromise;
        const envelope = this.makeEnvelope(source, payload, options);
        this.appendLog.append(this.scope, SIGNAL_LOG_KEY, envelope);
        await this.appendLog.flush();
        await this.reduce(envelope);
        resolveResult(envelope);
      })
      .catch(rejectResult)
      .finally(() => {
        this.queuedOperations -= 1;
      });
    return result;
  }

  conflicts(status?: StructuralConflict['status']): readonly StructuralConflict[] {
    return this.reducer.conflicts
      .filter((conflict) => status === undefined || conflict.status === status)
      .sort((left, right) => left.openedAtSequence - right.openedAtSequence);
  }

  async resolve(
    conflictId: ConflictId,
    status: 'resolved' | 'superseded' | 'stale' = 'resolved',
  ): Promise<void> {
    await this.readyPromise;
    const existing = this.reducer.conflicts.find((candidate) => candidate.conflictId === conflictId);
    if (existing === undefined) throw new Error(`Unknown structural conflict: ${conflictId}`);
    const updated: StructuralConflict = {
      ...existing,
      status,
      updatedAtSequence: this.reducer.lastSequence,
    };
    this.reducer = {
      ...this.reducer,
      conflicts: this.reducer.conflicts.map((candidate) =>
        candidate.conflictId === conflictId ? updated : candidate,
      ),
    };
    await this.documents.set(this.scope, REDUCER_STATE_KEY, this.reducer);
    await this.ledger.append({
      recordType: 'conflict.resolved',
      payload: { conflictId, status, sequence: this.reducer.lastSequence },
    });
  }

  async flush(): Promise<void> {
    if (this.fileTimer !== undefined) {
      clearTimeout(this.fileTimer);
      this.fileTimer = undefined;
      await this.flushFileChanges();
    }
    await this.readyPromise;
    await this.queue;
    await this.appendLog.flush();
  }

  override dispose(): void {
    if (this.fileTimer !== undefined) clearTimeout(this.fileTimer);
    for (const subscription of this.agentSubscriptions.values()) subscription.dispose();
    this.agentSubscriptions.clear();
    void this.flush();
    super.dispose();
  }

  private attachAgent(agentId: string, bus: IEventBus): void {
    if (this.agentSubscriptions.has(agentId)) return;
    this.agentSubscriptions.set(
      agentId,
      bus.subscribe((event) => {
        void this.enqueue(
          'agent-event',
          { kind: 'agent-event', agentId, eventType: event.type, event },
          { sourceAgentId: agentId },
        ).catch(() => undefined);
      }),
    );
  }

  private detachAgent(agentId: string): void {
    this.agentSubscriptions.get(agentId)?.dispose();
    this.agentSubscriptions.delete(agentId);
  }

  private onFileChange(change: HostFsChange): void {
    this.pendingFileChanges.set(change.path, change);
    if (this.fileTimer !== undefined) clearTimeout(this.fileTimer);
    this.fileTimer = setTimeout(() => {
      this.fileTimer = undefined;
      void this.flushFileChanges().catch(() => undefined);
    }, FILE_DEBOUNCE_MS);
  }

  private async flushFileChanges(): Promise<void> {
    const changes = [...this.pendingFileChanges.values()].sort((a, b) => a.path.localeCompare(b.path));
    this.pendingFileChanges.clear();
    for (const change of changes) {
      await this.enqueue('file-watch', {
        kind: 'file-change',
        path: change.path,
        action: change.action,
        entryKind: change.kind,
      });
    }
  }

  private makeEnvelope(
    source: StructuralSignalSource,
    payload: StructuralSignal,
    options: {
      readonly sourceAgentId?: string;
      readonly workspaceSnapshotHash?: string;
    },
  ): StructuralSignalEnvelope {
    const sequence = this.reducer.lastAllocatedSequence + 1;
    const dedupeKey = signalDedupeKey(source, payload, options.workspaceSnapshotHash);
    const occurrenceCount = (this.reducer.occurrences[dedupeKey] ?? 0) + 1;
    this.reducer = {
      ...this.reducer,
      lastAllocatedSequence: sequence,
      occurrences: { ...this.reducer.occurrences, [dedupeKey]: occurrenceCount },
    };
    return {
      sequence,
      signalId: randomUUID(),
      observedAtMs: Date.now(),
      source,
      sourceAgentId: options.sourceAgentId,
      workspaceSnapshotHash: options.workspaceSnapshotHash,
      payload,
      occurrenceCount,
    };
  }

  private async reduce(envelope: StructuralSignalEnvelope): Promise<void> {
    if (envelope.sequence !== this.reducer.lastSequence + 1) {
      throw new Error(
        `Structural signal sequence mismatch: expected ${this.reducer.lastSequence + 1}, received ${envelope.sequence}`,
      );
    }
    const proposed = await this.conflictsFor(envelope);
    this.reducer = {
      ...this.reducer,
      lastSequence: envelope.sequence,
      conflicts: mergeConflicts(this.reducer.conflicts, proposed),
    };
    await this.documents.set(this.scope, REDUCER_STATE_KEY, this.reducer);
    await this.ledger.append({
      recordType: 'structural.signal.recorded',
      payload: envelope,
    });
    for (const conflict of proposed) {
      await this.ledger.append({ recordType: 'conflict.opened', payload: conflict });
    }
  }

  private async conflictsFor(envelope: StructuralSignalEnvelope): Promise<readonly StructuralConflict[]> {
    const payload = envelope.payload;
    switch (payload.kind) {
      case 'file-change': {
        if (payload.entryKind === 'file') await this.structure.updatePaths([payload.path]);
        const snapshot = this.structure.snapshot();
        const fileNodes = snapshot?.nodes.filter((node) => node.path === payload.path) ?? [];
        const kinds = new Set(fileNodes.map((node) => node.kind));
        const conflicts: StructuralConflict[] = [];
        if (/manifest|generated/i.test(payload.path)) {
          conflicts.push(makeConflict(envelope, 'manifest-conflict', 'evaluation-required', [payload.path], [], [], ['repository.generated-manifests'], 'Generated artifact changed or became stale.'));
        }
        if (kinds.has('interface') || kinds.has('type') || kinds.has('service-registration')) {
          conflicts.push(makeConflict(envelope, 'public-contract-conflict', 'evaluation-required', fileNodes.map((node) => node.id), [], [], ['typescript.typecheck', 'repository.build'], 'A public or registered contract changed and requires integration verification.'));
        }
        if (kinds.has('wire-model') || kinds.has('wire-operation') || /session|persist|wire/i.test(payload.path)) {
          conflicts.push(makeConflict(envelope, 'persistence-conflict', 'commit-blocking', fileNodes.map((node) => node.id), [], [], ['persistence.schema-replay', 'persistence.backward-compatibility'], 'A persisted or replayed structure may require compatibility verification.'));
        }
        return conflicts;
      }
      case 'agent-event':
        if (payload.eventType === 'turn.step.interrupted') {
          return [makeConflict(envelope, 'event-order-conflict', 'evaluation-required', [], [], [], ['causal.event-order'], 'A runtime step was interrupted; ordering assumptions require reconciliation.')];
        }
        if (payload.eventType === 'error') {
          return [makeConflict(envelope, 'evidence-conflict', 'evaluation-required', [], [], [], ['runtime.patch-replay'], 'A runtime error was observed and requires causal attribution.')];
        }
        return [];
      case 'evaluation-result':
        return payload.status === 'failed'
          ? [makeConflict(envelope, 'evidence-conflict', 'evaluation-required', payload.structureRefs ?? [], [], [payload.evaluationId], [payload.evaluatorId], `Evaluation ${payload.evaluatorId} failed.`)]
          : [];
      case 'candidate-overlap':
        return [makeConflict(envelope, 'candidate-conflict', 'evaluation-required', payload.structureRefs, [], payload.candidateIds, ['repository.build'], 'Candidate patches overlap under potentially incompatible assumptions.')];
      case 'prediction-contradiction':
        return [makeConflict(envelope, 'prediction-conflict', 'commit-blocking', payload.structureRefs, payload.ruleIds, payload.evidenceRefs, ['causal.history-replay', 'causal.intervention'], 'Observed evidence contradicts an active causal prediction.')];
      case 'workspace-reconciled':
        return payload.conflictedPaths.length > 0
          ? [makeConflict(envelope, 'stale-evidence-conflict', 'commit-blocking', payload.conflictedPaths, [], [payload.baselineHash, payload.liveHash], ['repository.build'], 'The live workspace changed after the adaptive baseline and requires revalidation.')]
          : [];
    }
  }

  private async enqueueOverflow(): Promise<StructuralSignalEnvelope> {
    const envelope = this.makeEnvelope('workspace', {
      kind: 'workspace-reconciled',
      baselineHash: 'signal-queue',
      liveHash: 'overflow',
      conflictedPaths: ['structural-signal-queue'],
    }, {});
    const overflow = makeConflict(
      envelope,
      'signal-overflow',
      'commit-blocking',
      [],
      [],
      [],
      [],
      'Structural signal queue overflowed; commit is blocked until the index is rebuilt.',
    );
    this.reducer = {
      ...this.reducer,
      lastSequence: envelope.sequence,
      conflicts: mergeConflicts(this.reducer.conflicts, [overflow]),
    };
    this.appendLog.append(this.scope, SIGNAL_LOG_KEY, envelope);
    await this.appendLog.flush();
    await this.documents.set(this.scope, REDUCER_STATE_KEY, this.reducer);
    await this.ledger.append({ recordType: 'conflict.opened', payload: overflow });
    return envelope;
  }

  private async restore(): Promise<void> {
    const stored = await this.documents.get<ReducerState>(this.scope, REDUCER_STATE_KEY);
    if (stored?.protocol === 'structural-signals/1') this.reducer = stored;
    for await (const envelope of this.appendLog.read<StructuralSignalEnvelope>(this.scope, SIGNAL_LOG_KEY)) {
      if (envelope.sequence <= this.reducer.lastSequence) continue;
      await this.reduce(envelope);
    }
  }
}

function makeConflict(
  envelope: StructuralSignalEnvelope,
  kind: StructuralConflictKind,
  severity: StructuralConflict['severity'],
  structureRefs: readonly string[],
  ruleIds: readonly string[],
  evidenceRefs: readonly string[],
  suggestedEvaluatorIds: readonly string[],
  message: string,
): StructuralConflict {
  const material = JSON.stringify({ kind, structureRefs: [...structureRefs].sort(), ruleIds: [...ruleIds].sort(), evidenceRefs: [...evidenceRefs].sort() });
  return {
    conflictId: createHash('sha256').update(material).digest('hex') as ConflictId,
    kind,
    severity,
    status: 'open',
    openedAtSequence: envelope.sequence,
    updatedAtSequence: envelope.sequence,
    structureRefs,
    ruleIds,
    evidenceRefs,
    suggestedEvaluatorIds,
    message,
    occurrenceCount: envelope.occurrenceCount,
  };
}

function mergeConflicts(
  existing: readonly StructuralConflict[],
  proposed: readonly StructuralConflict[],
): readonly StructuralConflict[] {
  const merged = new Map(existing.map((conflict) => [conflict.conflictId, conflict]));
  for (const conflict of proposed) {
    const previous = merged.get(conflict.conflictId);
    merged.set(
      conflict.conflictId,
      previous === undefined
        ? conflict
        : {
            ...previous,
            status: 'open',
            updatedAtSequence: conflict.updatedAtSequence,
            occurrenceCount: previous.occurrenceCount + 1,
            evidenceRefs: [...new Set([...previous.evidenceRefs, ...conflict.evidenceRefs])],
          },
    );
  }
  return [...merged.values()];
}

function signalDedupeKey(
  source: StructuralSignalSource,
  payload: StructuralSignal,
  workspaceSnapshotHash?: string,
): string {
  return createHash('sha256')
    .update(source)
    .update('\n')
    .update(workspaceSnapshotHash ?? '')
    .update('\n')
    .update(JSON.stringify(payload))
    .digest('hex');
}

registerScopedService(
  LifecycleScope.Session,
  ISessionStructuralSignalsService,
  SessionStructuralSignalsService,
  ScopeActivation.OnScopeCreated,
  'structuralSignals',
);
