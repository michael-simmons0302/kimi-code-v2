import { createHash, randomUUID } from 'node:crypto';

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionEvaluationLedgerService } from '#/session/evaluationLedger/evaluationLedger';
import {
  checkpointChainTo,
  recoverCheckpointTail,
} from './checkpointRecovery';
import {
  ISessionSearchCheckpointService,
  SEARCH_CHECKPOINT_PROTOCOL,
  type SearchCheckpoint,
  type SearchCheckpointCompatibility,
  type SearchCheckpointHead,
  type SearchCheckpointInput,
  type SearchCheckpointRecovery,
} from './searchCheckpoint';

const LOG_KEY = 'search-checkpoints.jsonl';
const HEAD_KEY = 'search-checkpoint-head.json';

export class SessionSearchCheckpointService
  extends Disposable
  implements ISessionSearchCheckpointService
{
  declare readonly _serviceBrand: undefined;

  private readonly scope: string;
  private readonly readyPromise: Promise<void>;
  private checkpoints: SearchCheckpoint[] = [];
  private currentHead: SearchCheckpointHead = emptyHead();
  private writeTail: Promise<void> = Promise.resolve();

  constructor(
    @ISessionContext session: ISessionContext,
    @IAppendLogStore private readonly appendLog: IAppendLogStore,
    @IAtomicDocumentStore private readonly documents: IAtomicDocumentStore,
    @ISessionEvaluationLedgerService private readonly ledger: ISessionEvaluationLedgerService,
  ) {
    super();
    this.scope = session.scope('adaptive');
    this._register(this.appendLog.acquire(this.scope, LOG_KEY));
    this._register(this.documents.acquire(this.scope, HEAD_KEY));
    this.readyPromise = this.restore();
  }

  ready(): Promise<void> {
    return this.readyPromise;
  }

  commit<TState>(
    input: SearchCheckpointInput<TState>,
  ): Promise<SearchCheckpoint<TState>> {
    return this.mutate(async () => {
      validateInput(input);
      await this.assertLedgerHeadExists(input.ledgerHeadHash);
      const checkpointId = randomUUID();
      const base = {
        protocol: SEARCH_CHECKPOINT_PROTOCOL,
        checkpointId,
        previousCheckpointHash: this.currentHead.checkpointHash,
        ...deepFreeze(structuredClone(input)),
      } as const;
      const checkpoint: SearchCheckpoint<TState> = Object.freeze({
        ...base,
        checkpointHash: hashCanonical(base),
      });
      let appendError: unknown;
      this.appendLog.append(this.scope, LOG_KEY, checkpoint, {
        onError: (error) => { appendError = error; },
      });
      await this.appendLog.flush();
      if (appendError !== undefined) throw appendError;
      const head = headFor(checkpoint);
      await this.documents.set(this.scope, HEAD_KEY, head);
      this.checkpoints = [...this.checkpoints, checkpoint];
      this.currentHead = head;
      return checkpoint;
    });
  }

  latest<TState = unknown>(): SearchCheckpoint<TState> | undefined {
    return this.checkpoints.at(-1) as SearchCheckpoint<TState> | undefined;
  }

  recover<TState = unknown>(
    compatibility: SearchCheckpointCompatibility,
  ): Promise<SearchCheckpointRecovery<TState>> {
    return this.mutate(async () => {
      validateCompatibility(compatibility);
      const durableLedgerHashes = await this.ledgerHashes();
      const result = recoverCheckpointTail({
        checkpoints: this.checkpoints,
        requestedHeadHash: this.currentHead.checkpointHash ?? undefined,
        durableLedgerHashes,
        compatibility,
      });
      const selected = result.checkpoint as SearchCheckpoint<TState> | undefined;
      const recoveredFromPrior =
        selected !== undefined && selected.checkpointHash !== this.currentHead.checkpointHash;
      if (selected !== undefined && recoveredFromPrior) {
        this.checkpoints = [...checkpointChainTo(selected, this.checkpoints)];
        this.currentHead = headFor(selected);
        await this.documents.set(this.scope, HEAD_KEY, this.currentHead);
        await this.recordRecovery(result.rejected, selected);
      }
      return {
        checkpoint: selected,
        recoveredFromPrior,
        exactRequestedHead: result.exactRequestedHead,
        rejected: result.rejected,
      };
    });
  }

  list(): readonly SearchCheckpoint[] {
    return [...this.checkpoints];
  }

  async flush(): Promise<void> {
    await this.readyPromise;
    await this.writeTail;
    await this.appendLog.flush();
  }

  private async restore(): Promise<void> {
    await this.ledger.ready();
    const checkpoints: SearchCheckpoint[] = [];
    for await (const checkpoint of this.appendLog.read<SearchCheckpoint>(
      this.scope,
      LOG_KEY,
    )) {
      checkpoints.push(deepFreeze(structuredClone(checkpoint)));
    }

    const persistedHead = await this.documents.get<SearchCheckpointHead>(
      this.scope,
      HEAD_KEY,
    );
    const requestedHeadHash = validHeadOrUndefined(persistedHead)?.checkpointHash ?? undefined;
    const durableLedgerHashes = await this.ledgerHashes();

    if (checkpoints.length === 0) {
      this.checkpoints = [];
      this.currentHead = emptyHead();
      if (persistedHead !== undefined) {
        await this.documents.set(this.scope, HEAD_KEY, this.currentHead);
      }
      return;
    }

    const structuralCompatibility: SearchCheckpointCompatibility = {
      architectureVersion: newestStructurallyValid(checkpoints)?.architectureVersion ?? '',
      protocolVersions: newestStructurallyValid(checkpoints)?.protocolVersions ?? {},
    };
    const result = recoverCheckpointTail({
      checkpoints,
      requestedHeadHash,
      durableLedgerHashes,
      compatibility: structuralCompatibility,
    });
    const selected = result.checkpoint;
    if (selected === undefined) {
      const details = result.rejected
        .map((entry) => `${entry.checkpointId}:${entry.reason}`)
        .join(', ');
      throw new Error(`No durable search checkpoint could be recovered: ${details}`);
    }

    this.checkpoints = [...checkpointChainTo(selected, checkpoints)];
    this.currentHead = headFor(selected);
    const headChanged =
      persistedHead?.checkpointHash !== this.currentHead.checkpointHash ||
      persistedHead?.checkpointId !== this.currentHead.checkpointId;
    if (headChanged) {
      await this.documents.set(this.scope, HEAD_KEY, this.currentHead);
    }
    if (result.rejected.length > 0 || headChanged) {
      await this.recordRecovery(result.rejected, selected);
    }
  }

  private async recordRecovery(
    rejected: SearchCheckpointRecovery['rejected'],
    selected: SearchCheckpoint,
  ): Promise<void> {
    await this.ledger.append({
      recordType: 'search.checkpoint.recovered',
      payload: {
        selectedCheckpointId: selected.checkpointId,
        selectedCheckpointHash: selected.checkpointHash,
        selectedSequence: selected.createdAtSequence,
        rejected,
      },
    });
  }

  private async assertLedgerHeadExists(recordHash: string): Promise<void> {
    const hashes = await this.ledgerHashes();
    if (!hashes.has(recordHash)) {
      throw new Error(`Search checkpoint references an unknown ledger head: ${recordHash}`);
    }
  }

  private async ledgerHashes(): Promise<ReadonlySet<string>> {
    const hashes = new Set<string>();
    for await (const record of this.ledger.records()) hashes.add(record.recordHash);
    return hashes;
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
}

function newestStructurallyValid(
  checkpoints: readonly SearchCheckpoint[],
): SearchCheckpoint | undefined {
  return [...checkpoints]
    .filter((checkpoint) => {
      try {
        validateCheckpoint(checkpoint);
        return true;
      } catch {
        return false;
      }
    })
    .sort((left, right) => right.createdAtSequence - left.createdAtSequence)[0];
}

function validateCheckpoint(checkpoint: SearchCheckpoint): void {
  if (checkpoint.protocol !== SEARCH_CHECKPOINT_PROTOCOL) {
    throw new Error(`Unsupported search checkpoint protocol: ${String(checkpoint.protocol)}.`);
  }
  validateInput(checkpoint);
  if (checkpoint.checkpointId.trim().length === 0) {
    throw new Error('Search checkpoint ID cannot be empty.');
  }
  const { checkpointHash: _checkpointHash, ...base } = checkpoint;
  if (hashCanonical(base) !== checkpoint.checkpointHash) {
    throw new Error(`Search checkpoint hash mismatch: ${checkpoint.checkpointId}`);
  }
}

function validateInput(input: SearchCheckpointInput): void {
  if (!/^[a-f0-9]{64}$/.test(input.ledgerHeadHash)) {
    throw new Error('Search checkpoint ledgerHeadHash must be a SHA-256 hash.');
  }
  if (!Number.isInteger(input.createdAtSequence) || input.createdAtSequence < 0) {
    throw new Error('Search checkpoint sequence must be non-negative.');
  }
  if (input.architectureVersion.trim().length === 0) {
    throw new Error('Search checkpoint architectureVersion cannot be empty.');
  }
  if (input.reason.trim().length === 0) {
    throw new Error('Search checkpoint reason cannot be empty.');
  }
  if (input.configHash !== undefined && input.configHash.trim().length === 0) {
    throw new Error('Search checkpoint configHash cannot be empty when provided.');
  }
  if (
    input.workspaceSnapshotHash !== undefined &&
    input.workspaceSnapshotHash.trim().length === 0
  ) {
    throw new Error('Search checkpoint workspaceSnapshotHash cannot be empty when provided.');
  }
  if (
    !Number.isFinite(input.frontierTemperature) ||
    input.frontierTemperature <= 0 ||
    input.frontierTemperature > 1
  ) {
    throw new Error('Search checkpoint frontierTemperature must be in (0, 1].');
  }
  const generatorIds = new Set<string>();
  for (const state of input.randomStates) {
    if (state.generatorId.trim().length === 0 || state.state.length === 0) {
      throw new Error('Search checkpoint random state is invalid.');
    }
    if (generatorIds.has(state.generatorId)) {
      throw new Error(`Duplicate search random generator: ${state.generatorId}`);
    }
    generatorIds.add(state.generatorId);
  }
  const evaluationIds = new Set<string>();
  for (const evaluation of input.activeEvaluators) {
    if (evaluationIds.has(evaluation.evaluationId)) {
      throw new Error(`Duplicate checkpoint evaluator: ${evaluation.evaluationId}`);
    }
    evaluationIds.add(evaluation.evaluationId);
  }
}

function validateCompatibility(compatibility: SearchCheckpointCompatibility): void {
  if (compatibility.architectureVersion.trim().length === 0) {
    throw new Error('Checkpoint compatibility architectureVersion cannot be empty.');
  }
  if (compatibility.configHash !== undefined && compatibility.configHash.trim().length === 0) {
    throw new Error('Checkpoint compatibility configHash cannot be empty when provided.');
  }
  if (
    compatibility.workspaceSnapshotHash !== undefined &&
    compatibility.workspaceSnapshotHash.trim().length === 0
  ) {
    throw new Error('Checkpoint compatibility workspaceSnapshotHash cannot be empty when provided.');
  }
}

function validHeadOrUndefined(
  head: SearchCheckpointHead | undefined,
): SearchCheckpointHead | undefined {
  if (head === undefined) return undefined;
  try {
    validateHead(head);
    return head;
  } catch {
    return undefined;
  }
}

function validateHead(head: SearchCheckpointHead): void {
  if (head.protocol !== SEARCH_CHECKPOINT_PROTOCOL) {
    throw new Error(`Unsupported search checkpoint head protocol: ${String(head.protocol)}.`);
  }
  if (!Number.isInteger(head.sequence) || head.sequence < 0) {
    throw new Error('Search checkpoint head sequence must be non-negative.');
  }
  if ((head.checkpointId === null) !== (head.checkpointHash === null)) {
    throw new Error('Search checkpoint head ID and hash must both be null or non-null.');
  }
}

function headFor(checkpoint: SearchCheckpoint): SearchCheckpointHead {
  return {
    protocol: SEARCH_CHECKPOINT_PROTOCOL,
    checkpointId: checkpoint.checkpointId,
    checkpointHash: checkpoint.checkpointHash,
    sequence: checkpoint.createdAtSequence,
  };
}

function emptyHead(): SearchCheckpointHead {
  return {
    protocol: SEARCH_CHECKPOINT_PROTOCOL,
    checkpointId: null,
    checkpointHash: null,
    sequence: 0,
  };
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
  ISessionSearchCheckpointService,
  SessionSearchCheckpointService,
  ScopeActivation.OnScopeCreated,
  'searchCheckpoint',
);
