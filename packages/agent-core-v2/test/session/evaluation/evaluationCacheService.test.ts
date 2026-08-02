import { describe, expect, it } from 'vitest';

import type { IDisposable } from '#/_base/di/lifecycle';
import type { Event } from '#/_base/event';
import type { EvaluationId } from '#/agent/adaptiveRuntime/adaptiveProtocol';
import type { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import type { ISessionContext } from '#/session/sessionContext/sessionContext';
import type { EvaluationResult } from '#/session/evaluation/evaluation';
import { SessionEvaluationCacheService } from '#/session/evaluation/evaluationCacheService';
import type { EvaluationCacheIdentity } from '#/session/evaluation/evaluationCache';
import { createEvaluationEnvironmentManifest } from '#/session/evaluation/environmentManifest';

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
  scope: (subKey?: string) => subKey === undefined ? 'sessions/s1' : `sessions/s1/${subKey}`,
} as unknown as ISessionContext;

function fixture(documents = new Documents()) {
  return { service: new SessionEvaluationCacheService(session, documents), documents };
}

function manifest(overrides: Partial<Parameters<typeof createEvaluationEnvironmentManifest>[0]> = {}) {
  return createEvaluationEnvironmentManifest({
    baselineSnapshotHash: 'baseline',
    candidatePatchHash: 'patch',
    candidateWorkspaceHash: 'workspace',
    operatingSystem: 'linux',
    architecture: 'x64',
    sandboxBackendId: 'linux-bwrap',
    sandboxBackendVersion: '1',
    nodeVersion: '22.19.0',
    pnpmVersion: '10.0.0',
    lockfileHash: 'lockfile',
    dependencyStateHash: 'dependencies',
    evaluatorId: 'typescript.typecheck',
    evaluatorVersion: '1',
    configurationHash: 'configuration',
    permittedEnvironment: { CI: '1', LANG: 'C.UTF-8' },
    structuralStateHash: 'structure',
    ...overrides,
  });
}

function identity(
  environmentHash: string,
  overrides: Partial<EvaluationCacheIdentity> = {},
): EvaluationCacheIdentity {
  return {
    evaluatorId: 'typescript.typecheck',
    evaluatorVersion: '1',
    evaluationSpecHash: 'spec',
    baselineSnapshotHash: 'baseline',
    candidatePatchHash: 'patch',
    environmentManifestHash: environmentHash,
    dependencyStateHash: 'dependencies',
    ...overrides,
  };
}

function result(
  evaluationId: string,
  mode: 'deterministic' | 'stochastic' = 'deterministic',
  status: EvaluationResult['status'] = 'passed',
): EvaluationResult {
  return {
    protocol: 'evaluation-result/1',
    evaluationId: evaluationId as EvaluationId,
    evaluatorId: 'typescript.typecheck',
    evaluatorVersion: '1',
    mode,
    soundness: 'sound',
    scale: 'repository',
    level: 'validity',
    outcomeFamily: 'boolean',
    status,
    outcome: true,
    assertions: [],
    counterexampleRefs: [],
    artifactRefs: [],
    cost: { wallMs: 1 },
  };
}

describe('evaluation environment manifest', () => {
  it('hashes environment variables independent of property order', () => {
    const first = manifest({ permittedEnvironment: { CI: '1', LANG: 'C.UTF-8' } });
    const second = manifest({ permittedEnvironment: { LANG: 'C.UTF-8', CI: '1' } });
    expect(first.environmentHash).toBe(second.environmentHash);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.permittedEnvironment)).toBe(true);
  });

  it('changes identity when a relevant environment field changes', () => {
    expect(manifest().environmentHash).not.toBe(
      manifest({ evaluatorVersion: '2' }).environmentHash,
    );
    expect(manifest().environmentHash).not.toBe(
      manifest({ dependencyStateHash: 'changed' }).environmentHash,
    );
    expect(manifest().environmentHash).not.toBe(
      manifest({ seed: 'different' }).environmentHash,
    );
  });

  it('rejects invalid environment variable names', () => {
    expect(() => manifest({ permittedEnvironment: { 'BAD-NAME': '1' } })).toThrow(
      'Invalid permitted environment variable',
    );
  });
});

describe('SessionEvaluationCacheService', () => {
  it('stores and returns deterministic results only under exact identity', async () => {
    const { service } = fixture();
    const environment = manifest();
    const cacheIdentity = identity(environment.environmentHash);
    await service.put({
      identity: cacheIdentity,
      result: result('evaluation-1'),
      environment,
      createdAtSequence: 1,
    });
    const hit = service.getDeterministic(cacheIdentity);
    expect(hit).toMatchObject({
      provenance: {
        sourceEvaluationId: 'evaluation-1',
        createdAtSequence: 1,
        exactEnvironment: true,
        seedMatched: true,
      },
    });
    expect(
      service.getDeterministic({ ...cacheIdentity, candidatePatchHash: 'changed' }),
    ).toBeUndefined();
  });

  it('stores stochastic results as exact seed-specific replicates', async () => {
    const { service } = fixture();
    const environment = manifest({ seed: 'seed-a' });
    const cacheIdentity = identity(environment.environmentHash);
    await service.put({
      identity: cacheIdentity,
      result: result('replicate-1', 'stochastic'),
      environment,
      createdAtSequence: 1,
      seed: 'seed-a',
    });
    expect(service.getStochasticReplicate(cacheIdentity, 'seed-a')).toBeDefined();
    expect(service.getStochasticReplicate(cacheIdentity, 'seed-b')).toBeUndefined();
  });

  it('rejects a stochastic result without a seed', async () => {
    const { service } = fixture();
    const environment = manifest();
    await expect(
      service.put({
        identity: identity(environment.environmentHash),
        result: result('replicate', 'stochastic'),
        environment,
        createdAtSequence: 1,
      }),
    ).rejects.toThrow('require a seed');
  });

  it('does not cache infrastructure failures or cancellations', async () => {
    const { service } = fixture();
    const environment = manifest();
    const cacheIdentity = identity(environment.environmentHash);
    await expect(
      service.put({
        identity: cacheIdentity,
        result: result('failed', 'deterministic', 'infrastructure-failed'),
        environment,
        createdAtSequence: 1,
      }),
    ).rejects.toThrow('not cacheable');
    await expect(
      service.put({
        identity: cacheIdentity,
        result: result('cancelled', 'deterministic', 'cancelled'),
        environment,
        createdAtSequence: 1,
      }),
    ).rejects.toThrow('not cacheable');
  });

  it('rejects mismatched environment and evaluator identity', async () => {
    const { service } = fixture();
    const environment = manifest();
    await expect(
      service.put({
        identity: identity('0'.repeat(64)),
        result: result('evaluation'),
        environment,
        createdAtSequence: 1,
      }),
    ).rejects.toThrow('does not match its environment');
    await expect(
      service.put({
        identity: identity(environment.environmentHash, { evaluatorVersion: '2' }),
        result: result('evaluation'),
        environment,
        createdAtSequence: 1,
      }),
    ).rejects.toThrow('version does not match');
  });

  it('deduplicates exact entries and rejects overwrite collisions', async () => {
    const { service } = fixture();
    const environment = manifest();
    const cacheIdentity = identity(environment.environmentHash);
    const input = {
      identity: cacheIdentity,
      result: result('evaluation-1'),
      environment,
      createdAtSequence: 1,
    };
    const first = await service.put(input);
    expect(await service.put(input)).toEqual(first);
    await expect(
      service.put({ ...input, result: result('evaluation-2') }),
    ).rejects.toThrow('overwrite attempt');
  });

  it('invalidates selected evaluator versions without touching others', async () => {
    const { service } = fixture();
    const firstEnvironment = manifest();
    const secondEnvironment = manifest({ evaluatorVersion: '2' });
    await service.put({
      identity: identity(firstEnvironment.environmentHash),
      result: result('v1'),
      environment: firstEnvironment,
      createdAtSequence: 1,
    });
    await service.put({
      identity: identity(secondEnvironment.environmentHash, { evaluatorVersion: '2' }),
      result: { ...result('v2'), evaluatorVersion: '2' },
      environment: secondEnvironment,
      createdAtSequence: 2,
    });
    expect(await service.invalidateEvaluator('typescript.typecheck', '1')).toBe(1);
    expect(service.list()).toHaveLength(1);
    expect(service.list()[0]?.identity.evaluatorVersion).toBe('2');
  });

  it('persists cache entries across service reconstruction', async () => {
    const first = fixture();
    const environment = manifest();
    const cacheIdentity = identity(environment.environmentHash);
    await first.service.put({
      identity: cacheIdentity,
      result: result('evaluation-1'),
      environment,
      createdAtSequence: 1,
    });
    await first.service.flush();
    const second = fixture(first.documents);
    await second.service.ready();
    expect(second.service.getDeterministic(cacheIdentity)?.entry.sourceEvaluationId).toBe(
      'evaluation-1',
    );
  });

  it('fails restore when persisted cache keys are corrupted', async () => {
    const first = fixture();
    const environment = manifest();
    await first.service.put({
      identity: identity(environment.environmentHash),
      result: result('evaluation-1'),
      environment,
      createdAtSequence: 1,
    });
    const key = 'sessions/s1/adaptive/evaluation-cache.json';
    const document = first.documents.values.get(key) as {
      entries: Array<Record<string, unknown>>;
    };
    document.entries[0]!['cacheKey'] = 'corrupt';
    const second = fixture(first.documents);
    await expect(second.service.ready()).rejects.toThrow('key mismatch');
  });
});
