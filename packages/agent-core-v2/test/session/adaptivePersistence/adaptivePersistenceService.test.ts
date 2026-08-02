import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { IDisposable } from '#/_base/di/lifecycle';
import type { Event } from '#/_base/event';
import type { IBootstrapService } from '#/app/bootstrap/bootstrap';
import type { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import type { BlobReadRange, IBlobStore } from '#/persistence/interface/blobStore';
import { SessionAdaptivePersistenceService } from '#/session/adaptivePersistence/adaptivePersistenceService';
import type { ISessionContext } from '#/session/sessionContext/sessionContext';

class Blobs implements IBlobStore {
  declare readonly _serviceBrand: undefined;
  readonly values = new Map<string, Uint8Array>();
  async put(scope: string, key: string, data: Uint8Array): Promise<void> {
    this.values.set(`${scope}/${key}`, data.slice());
  }
  async putStream(
    scope: string,
    key: string,
    source: AsyncIterable<Uint8Array>,
  ): Promise<void> {
    const chunks: Uint8Array[] = [];
    for await (const chunk of source) chunks.push(chunk);
    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const data = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.byteLength;
    }
    await this.put(scope, key, data);
  }
  async get(scope: string, key: string): Promise<Uint8Array | undefined> {
    return this.values.get(`${scope}/${key}`)?.slice();
  }
  async *getStream(
    scope: string,
    key: string,
    range?: BlobReadRange,
  ): AsyncIterable<Uint8Array> {
    const value = await this.get(scope, key);
    if (value === undefined) return;
    yield range === undefined ? value : value.slice(range.start, range.end);
  }
  async has(scope: string, key: string): Promise<boolean> {
    return this.values.has(`${scope}/${key}`);
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

const session = {
  _serviceBrand: undefined,
  cwd: '/workspace',
  scope: (subKey?: string) => subKey === undefined ? 'sessions/session-1' : `sessions/session-1/${subKey}`,
} as unknown as ISessionContext;

const bootstrap = {
  _serviceBrand: undefined,
  scope: (name: string) => name,
} as unknown as IBootstrapService;

function fixture(blobs = new Blobs(), documents = new Documents()) {
  return {
    service: new SessionAdaptivePersistenceService(session, bootstrap, blobs, documents),
    blobs,
    documents,
  };
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function hash(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

describe('SessionAdaptivePersistenceService', () => {
  it('exposes the locked session and global layout', () => {
    const { service } = fixture();
    expect(service.layout()).toMatchObject({
      protocol: 'adaptive-layout/1',
      sessionRoot: 'sessions/session-1/adaptive',
      sessionScopes: {
        artifacts: 'sessions/session-1/adaptive/artifacts',
        workspaces: 'sessions/session-1/adaptive/workspaces',
        ephemeralAgents: 'sessions/session-1/adaptive/ephemeral-agents',
      },
      globalRoot: 'adaptive',
      globalScopes: {
        programArchive: 'adaptive/program-archive',
        promotedPrompts: 'adaptive/promoted-prompts',
        promotedSearchPolicy: 'adaptive/promoted-search-policy',
        calibration: 'adaptive/calibration',
        benchmarkHistory: 'adaptive/benchmark-history',
        artifacts: 'adaptive/artifacts',
      },
    });
    expect(Object.isFrozen(service.layout())).toBe(true);
    expect(Object.isFrozen(service.layout().sessionScopes)).toBe(true);
  });

  it('stores artifacts under their SHA-256 content hash', async () => {
    const { service } = fixture();
    const data = bytes('evidence');
    const metadata = await service.putArtifact({
      bytes: data,
      mediaType: 'text/plain',
      sensitivity: 'workspace-private',
      createdAtSequence: 1,
      labels: { type: 'evaluation' },
    });
    expect(metadata.artifactHash).toBe(hash(data));
    expect(await service.getArtifact(metadata.artifactHash)).toEqual(data);
    expect(metadata.referenceCount).toBe(0);
    expect(metadata.pinned).toBe(false);
  });

  it('deduplicates identical content and rejects conflicting metadata', async () => {
    const { service } = fixture();
    const input = {
      bytes: bytes('same'),
      mediaType: 'text/plain',
      sensitivity: 'workspace-private' as const,
      createdAtSequence: 1,
    };
    const first = await service.putArtifact(input);
    const second = await service.putArtifact({ ...input, createdAtSequence: 2 });
    expect(second).toEqual(first);
    expect(service.listArtifacts()).toHaveLength(1);
    await expect(
      service.putArtifact({ ...input, mediaType: 'application/json' }),
    ).rejects.toThrow('metadata conflicts');
  });

  it('detects a corrupted pre-existing content-addressed blob', async () => {
    const blobs = new Blobs();
    const documents = new Documents();
    const data = bytes('expected');
    const artifactHash = hash(data);
    blobs.values.set(`sessions/session-1/adaptive/artifacts/${artifactHash}`, bytes('corrupt'));
    const { service } = fixture(blobs, documents);
    await expect(
      service.putArtifact({
        bytes: data,
        mediaType: 'text/plain',
        sensitivity: 'workspace-private',
        createdAtSequence: 1,
      }),
    ).rejects.toThrow('mismatch');
  });

  it('retains referenced and pinned artifacts during garbage collection', async () => {
    const { service } = fixture();
    const referenced = await service.putArtifact({
      bytes: bytes('referenced'),
      mediaType: 'text/plain',
      sensitivity: 'workspace-private',
      createdAtSequence: 1,
    });
    const pinned = await service.putArtifact({
      bytes: bytes('pinned'),
      mediaType: 'text/plain',
      sensitivity: 'workspace-private',
      createdAtSequence: 1,
      pin: true,
    });
    const deleted = await service.putArtifact({
      bytes: bytes('deleted'),
      mediaType: 'text/plain',
      sensitivity: 'workspace-private',
      createdAtSequence: 1,
    });
    await service.retain(referenced.artifactHash);
    const result = await service.garbageCollect({
      currentSequence: 100,
      minimumAgeSequences: 10,
    });
    expect(result.retainedReferenced).toEqual([referenced.artifactHash]);
    expect(result.retainedPinned).toEqual([pinned.artifactHash]);
    expect(result.deleted).toEqual([deleted.artifactHash]);
    expect(await service.getArtifact(deleted.artifactHash)).toBeUndefined();
  });

  it('retains young artifacts and respects the deletion limit', async () => {
    const { service } = fixture();
    const oldA = await service.putArtifact({
      bytes: bytes('old-a'), mediaType: 'text/plain', sensitivity: 'public', createdAtSequence: 1,
    });
    const oldB = await service.putArtifact({
      bytes: bytes('old-b'), mediaType: 'text/plain', sensitivity: 'public', createdAtSequence: 2,
    });
    const young = await service.putArtifact({
      bytes: bytes('young'), mediaType: 'text/plain', sensitivity: 'public', createdAtSequence: 95,
    });
    const result = await service.garbageCollect({
      currentSequence: 100,
      minimumAgeSequences: 10,
      maximumDeletes: 1,
    });
    expect(result.deleted).toHaveLength(1);
    expect(result.deleted[0]).toBe(oldA.artifactHash);
    expect(result.retainedYoung).toContain(oldB.artifactHash);
    expect(result.retainedYoung).toContain(young.artifactHash);
  });

  it('prevents reference underflow', async () => {
    const { service } = fixture();
    const artifact = await service.putArtifact({
      bytes: bytes('artifact'), mediaType: 'text/plain', sensitivity: 'public', createdAtSequence: 1,
    });
    await expect(service.release(artifact.artifactHash)).rejects.toThrow('already zero');
    await service.retain(artifact.artifactHash);
    expect((await service.release(artifact.artifactHash)).referenceCount).toBe(0);
  });

  it('stores promoted artifacts globally and pins them permanently', async () => {
    const { service } = fixture();
    const artifact = await service.putPromotedArtifact({
      bytes: bytes('promoted'),
      mediaType: 'application/json',
      sensitivity: 'protected-evaluator',
      createdAtSequence: 4,
    });
    expect(artifact.pinned).toBe(true);
    expect(await service.getPromotedArtifact(artifact.artifactHash)).toEqual(bytes('promoted'));
    expect(service.listPromotedArtifacts()).toEqual([artifact]);
  });

  it('restores indexes and verifies referenced blobs', async () => {
    const first = fixture();
    const artifact = await first.service.putArtifact({
      bytes: bytes('persisted'), mediaType: 'text/plain', sensitivity: 'public', createdAtSequence: 1,
    });
    await first.service.retain(artifact.artifactHash);
    await first.service.flush();
    const second = fixture(first.blobs, first.documents);
    await second.service.ready();
    expect(second.service.metadata(artifact.artifactHash)?.referenceCount).toBe(1);
    expect(await second.service.getArtifact(artifact.artifactHash)).toEqual(bytes('persisted'));
  });

  it('fails restore when an index references a missing blob', async () => {
    const first = fixture();
    const artifact = await first.service.putArtifact({
      bytes: bytes('lost'), mediaType: 'text/plain', sensitivity: 'public', createdAtSequence: 1,
    });
    await first.service.flush();
    first.blobs.values.delete(`sessions/session-1/adaptive/artifacts/${artifact.artifactHash}`);
    const second = fixture(first.blobs, first.documents);
    await expect(second.service.ready()).rejects.toThrow('missing blob');
  });
});
