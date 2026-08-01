import { createHash } from 'node:crypto';

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IBlobStore } from '#/persistence/interface/blobStore';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import {
  ADAPTIVE_ARTIFACT_INDEX_PROTOCOL,
  ADAPTIVE_LAYOUT_PROTOCOL,
  ISessionAdaptivePersistenceService,
  type AdaptiveArtifactIndex,
  type AdaptiveArtifactMetadata,
  type AdaptiveGarbageCollectionResult,
  type AdaptivePersistenceLayout,
  type PutAdaptiveArtifactInput,
} from './adaptivePersistence';

const SESSION_INDEX_KEY = 'artifact-index.json';
const GLOBAL_INDEX_KEY = 'global-artifact-index.json';

interface MutableIndex {
  protocol: typeof ADAPTIVE_ARTIFACT_INDEX_PROTOCOL;
  artifacts: AdaptiveArtifactMetadata[];
  updatedAtSequence: number;
}

export class SessionAdaptivePersistenceService
  extends Disposable
  implements ISessionAdaptivePersistenceService
{
  declare readonly _serviceBrand: undefined;

  private readonly sessionRoot: string;
  private readonly globalRoot: string;
  private readonly sessionArtifactScope: string;
  private readonly globalArtifactScope: string;
  private readonly layoutValue: AdaptivePersistenceLayout;
  private readonly readyPromise: Promise<void>;
  private sessionIndex: MutableIndex = emptyIndex();
  private globalIndex: MutableIndex = emptyIndex();
  private writeTail: Promise<void> = Promise.resolve();

  constructor(
    @ISessionContext session: ISessionContext,
    @IBootstrapService bootstrap: IBootstrapService,
    @IBlobStore private readonly blobs: IBlobStore,
    @IAtomicDocumentStore private readonly documents: IAtomicDocumentStore,
  ) {
    super();
    this.sessionRoot = session.scope('adaptive');
    this.globalRoot = bootstrap.scope('adaptive');
    this.sessionArtifactScope = session.scope('adaptive/artifacts');
    this.globalArtifactScope = `${this.globalRoot}/artifacts`;
    this._register(this.documents.acquire(this.sessionRoot, SESSION_INDEX_KEY));
    this._register(this.documents.acquire(this.globalRoot, GLOBAL_INDEX_KEY));
    this.layoutValue = createLayout(session, bootstrap);
    this.readyPromise = this.restore();
  }

  ready(): Promise<void> {
    return this.readyPromise;
  }

  layout(): AdaptivePersistenceLayout {
    return this.layoutValue;
  }

  putArtifact(input: PutAdaptiveArtifactInput): Promise<AdaptiveArtifactMetadata> {
    return this.put('session', input);
  }

  putPromotedArtifact(
    input: PutAdaptiveArtifactInput,
  ): Promise<AdaptiveArtifactMetadata> {
    return this.put('global', { ...input, pin: true });
  }

  async getArtifact(artifactHash: string): Promise<Uint8Array | undefined> {
    await this.readyPromise;
    validateHash(artifactHash);
    return this.blobs.get(this.sessionArtifactScope, artifactHash);
  }

  async getPromotedArtifact(artifactHash: string): Promise<Uint8Array | undefined> {
    await this.readyPromise;
    validateHash(artifactHash);
    return this.blobs.get(this.globalArtifactScope, artifactHash);
  }

  metadata(artifactHash: string): AdaptiveArtifactMetadata | undefined {
    validateHash(artifactHash);
    return this.sessionIndex.artifacts.find(
      (artifact) => artifact.artifactHash === artifactHash,
    );
  }

  promotedMetadata(artifactHash: string): AdaptiveArtifactMetadata | undefined {
    validateHash(artifactHash);
    return this.globalIndex.artifacts.find(
      (artifact) => artifact.artifactHash === artifactHash,
    );
  }

  retain(artifactHash: string): Promise<AdaptiveArtifactMetadata> {
    return this.updateSessionMetadata(artifactHash, (metadata) => ({
      ...metadata,
      referenceCount: metadata.referenceCount + 1,
    }));
  }

  release(artifactHash: string): Promise<AdaptiveArtifactMetadata> {
    return this.updateSessionMetadata(artifactHash, (metadata) => {
      if (metadata.referenceCount === 0) {
        throw new Error(`Adaptive artifact reference count is already zero: ${artifactHash}`);
      }
      return { ...metadata, referenceCount: metadata.referenceCount - 1 };
    });
  }

  pin(artifactHash: string): Promise<AdaptiveArtifactMetadata> {
    return this.updateSessionMetadata(artifactHash, (metadata) => ({
      ...metadata,
      pinned: true,
    }));
  }

  garbageCollect(input: {
    readonly currentSequence: number;
    readonly minimumAgeSequences: number;
    readonly maximumDeletes?: number;
  }): Promise<AdaptiveGarbageCollectionResult> {
    return this.mutate(async () => {
      validateCollectionInput(input);
      const maximumDeletes = input.maximumDeletes ?? Number.POSITIVE_INFINITY;
      const deleted: string[] = [];
      const retainedReferenced: string[] = [];
      const retainedPinned: string[] = [];
      const retainedYoung: string[] = [];
      const retained: AdaptiveArtifactMetadata[] = [];
      for (const artifact of this.sessionIndex.artifacts) {
        if (artifact.referenceCount > 0) {
          retainedReferenced.push(artifact.artifactHash);
          retained.push(artifact);
          continue;
        }
        if (artifact.pinned) {
          retainedPinned.push(artifact.artifactHash);
          retained.push(artifact);
          continue;
        }
        const age = input.currentSequence - artifact.createdAtSequence;
        if (age < input.minimumAgeSequences || deleted.length >= maximumDeletes) {
          retainedYoung.push(artifact.artifactHash);
          retained.push(artifact);
          continue;
        }
        await this.blobs.delete(this.sessionArtifactScope, artifact.artifactHash);
        deleted.push(artifact.artifactHash);
      }
      this.sessionIndex = {
        protocol: ADAPTIVE_ARTIFACT_INDEX_PROTOCOL,
        artifacts: retained,
        updatedAtSequence: Math.max(
          this.sessionIndex.updatedAtSequence,
          input.currentSequence,
        ),
      };
      await this.persistSessionIndex();
      return {
        deleted,
        retainedReferenced,
        retainedPinned,
        retainedYoung,
      };
    });
  }

  listArtifacts(): readonly AdaptiveArtifactMetadata[] {
    return [...this.sessionIndex.artifacts].sort(compareMetadata);
  }

  listPromotedArtifacts(): readonly AdaptiveArtifactMetadata[] {
    return [...this.globalIndex.artifacts].sort(compareMetadata);
  }

  async flush(): Promise<void> {
    await this.readyPromise;
    await this.writeTail;
  }

  private put(
    target: 'session' | 'global',
    input: PutAdaptiveArtifactInput,
  ): Promise<AdaptiveArtifactMetadata> {
    return this.mutate(async () => {
      validatePutInput(input);
      const artifactHash = hashBytes(input.bytes);
      const scope = target === 'session'
        ? this.sessionArtifactScope
        : this.globalArtifactScope;
      const index = target === 'session' ? this.sessionIndex : this.globalIndex;
      const existing = index.artifacts.find(
        (artifact) => artifact.artifactHash === artifactHash,
      );
      if (existing !== undefined) {
        assertMetadataCompatible(existing, input);
        await this.verifyExistingBlob(scope, artifactHash, input.bytes);
        return existing;
      }
      if (await this.blobs.has(scope, artifactHash)) {
        await this.verifyExistingBlob(scope, artifactHash, input.bytes);
      } else {
        await this.blobs.put(scope, artifactHash, input.bytes);
      }
      const metadata = Object.freeze({
        artifactHash,
        byteLength: input.bytes.byteLength,
        mediaType: input.mediaType,
        sensitivity: input.sensitivity,
        createdAtSequence: input.createdAtSequence,
        referenceCount: 0,
        pinned: target === 'global' || input.pin === true,
        labels: Object.freeze(sortRecord(input.labels ?? {})),
      });
      const next: MutableIndex = {
        protocol: ADAPTIVE_ARTIFACT_INDEX_PROTOCOL,
        artifacts: [...index.artifacts, metadata].sort(compareMetadata),
        updatedAtSequence: Math.max(index.updatedAtSequence, input.createdAtSequence),
      };
      if (target === 'session') {
        this.sessionIndex = next;
        await this.persistSessionIndex();
      } else {
        this.globalIndex = next;
        await this.persistGlobalIndex();
      }
      return metadata;
    });
  }

  private updateSessionMetadata(
    artifactHash: string,
    update: (metadata: AdaptiveArtifactMetadata) => AdaptiveArtifactMetadata,
  ): Promise<AdaptiveArtifactMetadata> {
    return this.mutate(async () => {
      validateHash(artifactHash);
      const index = this.sessionIndex.artifacts.findIndex(
        (artifact) => artifact.artifactHash === artifactHash,
      );
      if (index < 0) throw new Error(`Adaptive artifact does not exist: ${artifactHash}`);
      const current = this.sessionIndex.artifacts[index] as AdaptiveArtifactMetadata;
      const next = Object.freeze(update(current));
      const artifacts = [...this.sessionIndex.artifacts];
      artifacts[index] = next;
      this.sessionIndex = {
        ...this.sessionIndex,
        artifacts: artifacts.sort(compareMetadata),
      };
      await this.persistSessionIndex();
      return next;
    });
  }

  private async verifyExistingBlob(
    scope: string,
    artifactHash: string,
    expected: Uint8Array,
  ): Promise<void> {
    const existing = await this.blobs.get(scope, artifactHash);
    if (existing === undefined) {
      throw new Error(`Adaptive artifact index references a missing blob: ${artifactHash}`);
    }
    if (hashBytes(existing) !== artifactHash || !equalBytes(existing, expected)) {
      throw new Error(`Content-addressed adaptive artifact mismatch: ${artifactHash}`);
    }
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

  private async restore(): Promise<void> {
    const [sessionIndex, globalIndex] = await Promise.all([
      this.documents.get<AdaptiveArtifactIndex>(this.sessionRoot, SESSION_INDEX_KEY),
      this.documents.get<AdaptiveArtifactIndex>(this.globalRoot, GLOBAL_INDEX_KEY),
    ]);
    this.sessionIndex = validateIndex(sessionIndex);
    this.globalIndex = validateIndex(globalIndex);
    await Promise.all([
      verifyIndexBlobs(this.blobs, this.sessionArtifactScope, this.sessionIndex),
      verifyIndexBlobs(this.blobs, this.globalArtifactScope, this.globalIndex),
    ]);
  }

  private persistSessionIndex(): Promise<void> {
    return this.documents.set(this.sessionRoot, SESSION_INDEX_KEY, this.sessionIndex);
  }

  private persistGlobalIndex(): Promise<void> {
    return this.documents.set(this.globalRoot, GLOBAL_INDEX_KEY, this.globalIndex);
  }
}

function createLayout(
  session: ISessionContext,
  bootstrap: IBootstrapService,
): AdaptivePersistenceLayout {
  const sessionRoot = session.scope('adaptive');
  const globalRoot = bootstrap.scope('adaptive');
  return deepFreeze({
    protocol: ADAPTIVE_LAYOUT_PROTOCOL,
    sessionRoot,
    sessionScopes: {
      manifest: session.scope('adaptive/manifest'),
      ledger: session.scope('adaptive/ledger'),
      signals: session.scope('adaptive/signals'),
      evidence: session.scope('adaptive/evidence'),
      conflicts: session.scope('adaptive/conflicts'),
      causalRules: session.scope('adaptive/causal-rules'),
      worldModels: session.scope('adaptive/world-models'),
      evaluations: session.scope('adaptive/evaluations'),
      search: session.scope('adaptive/search'),
      checkpoints: session.scope('adaptive/checkpoints'),
      candidates: session.scope('adaptive/candidates'),
      memory: session.scope('adaptive/memory'),
      artifacts: session.scope('adaptive/artifacts'),
      workspaces: session.scope('adaptive/workspaces'),
      ephemeralAgents: session.scope('adaptive/ephemeral-agents'),
    },
    globalRoot,
    globalScopes: {
      programArchive: `${globalRoot}/program-archive`,
      promotedPrompts: `${globalRoot}/promoted-prompts`,
      promotedSearchPolicy: `${globalRoot}/promoted-search-policy`,
      calibration: `${globalRoot}/calibration`,
      benchmarkHistory: `${globalRoot}/benchmark-history`,
      artifacts: `${globalRoot}/artifacts`,
    },
  });
}

function validateIndex(index: AdaptiveArtifactIndex | undefined): MutableIndex {
  if (index === undefined) return emptyIndex();
  if (index.protocol !== ADAPTIVE_ARTIFACT_INDEX_PROTOCOL) {
    throw new Error(`Unsupported adaptive artifact index protocol: ${String(index.protocol)}`);
  }
  if (!Number.isInteger(index.updatedAtSequence) || index.updatedAtSequence < 0) {
    throw new Error('Adaptive artifact index sequence must be non-negative.');
  }
  const hashes = new Set<string>();
  const artifacts = index.artifacts.map((artifact) => {
    validateMetadata(artifact);
    if (hashes.has(artifact.artifactHash)) {
      throw new Error(`Duplicate adaptive artifact metadata: ${artifact.artifactHash}`);
    }
    hashes.add(artifact.artifactHash);
    return deepFreeze(structuredClone(artifact));
  }).sort(compareMetadata);
  return {
    protocol: ADAPTIVE_ARTIFACT_INDEX_PROTOCOL,
    artifacts,
    updatedAtSequence: index.updatedAtSequence,
  };
}

async function verifyIndexBlobs(
  blobs: IBlobStore,
  scope: string,
  index: MutableIndex,
): Promise<void> {
  for (const artifact of index.artifacts) {
    const bytes = await blobs.get(scope, artifact.artifactHash);
    if (bytes === undefined) {
      throw new Error(`Adaptive artifact index references a missing blob: ${artifact.artifactHash}`);
    }
    if (bytes.byteLength !== artifact.byteLength || hashBytes(bytes) !== artifact.artifactHash) {
      throw new Error(`Adaptive artifact failed restore verification: ${artifact.artifactHash}`);
    }
  }
}

function validatePutInput(input: PutAdaptiveArtifactInput): void {
  if (!(input.bytes instanceof Uint8Array)) throw new Error('Adaptive artifact bytes are required.');
  if (input.mediaType.trim().length === 0) throw new Error('Adaptive artifact mediaType is required.');
  if (!Number.isInteger(input.createdAtSequence) || input.createdAtSequence < 0) {
    throw new Error('Adaptive artifact createdAtSequence must be non-negative.');
  }
}

function validateMetadata(metadata: AdaptiveArtifactMetadata): void {
  validateHash(metadata.artifactHash);
  if (!Number.isInteger(metadata.byteLength) || metadata.byteLength < 0) {
    throw new Error(`Adaptive artifact byteLength is invalid: ${metadata.artifactHash}`);
  }
  if (!Number.isInteger(metadata.createdAtSequence) || metadata.createdAtSequence < 0) {
    throw new Error(`Adaptive artifact sequence is invalid: ${metadata.artifactHash}`);
  }
  if (!Number.isInteger(metadata.referenceCount) || metadata.referenceCount < 0) {
    throw new Error(`Adaptive artifact reference count is invalid: ${metadata.artifactHash}`);
  }
}

function assertMetadataCompatible(
  existing: AdaptiveArtifactMetadata,
  input: PutAdaptiveArtifactInput,
): void {
  if (
    existing.byteLength !== input.bytes.byteLength ||
    existing.mediaType !== input.mediaType ||
    existing.sensitivity !== input.sensitivity
  ) {
    throw new Error(
      `Adaptive artifact metadata conflicts with existing content: ${existing.artifactHash}`,
    );
  }
}

function validateCollectionInput(input: {
  readonly currentSequence: number;
  readonly minimumAgeSequences: number;
  readonly maximumDeletes?: number;
}): void {
  if (!Number.isInteger(input.currentSequence) || input.currentSequence < 0) {
    throw new Error('Garbage collection currentSequence must be non-negative.');
  }
  if (!Number.isInteger(input.minimumAgeSequences) || input.minimumAgeSequences < 0) {
    throw new Error('Garbage collection minimumAgeSequences must be non-negative.');
  }
  if (
    input.maximumDeletes !== undefined &&
    (!Number.isInteger(input.maximumDeletes) || input.maximumDeletes < 0)
  ) {
    throw new Error('Garbage collection maximumDeletes must be non-negative.');
  }
}

function validateHash(hash: string): void {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error(`Invalid adaptive artifact hash: ${hash}`);
}

function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength &&
    left.every((value, index) => value === right[index]);
}

function compareMetadata(
  left: AdaptiveArtifactMetadata,
  right: AdaptiveArtifactMetadata,
): number {
  return left.createdAtSequence - right.createdAtSequence ||
    left.artifactHash.localeCompare(right.artifactHash);
}

function sortRecord(
  value: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

function emptyIndex(): MutableIndex {
  return {
    protocol: ADAPTIVE_ARTIFACT_INDEX_PROTOCOL,
    artifacts: [],
    updatedAtSequence: 0,
  };
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
  ISessionAdaptivePersistenceService,
  SessionAdaptivePersistenceService,
  ScopeActivation.OnScopeCreated,
  'adaptivePersistence',
);
