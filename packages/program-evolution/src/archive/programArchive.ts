import { createHash } from 'node:crypto';

import { createDecorator } from '@moonshot-ai/agent-core-v2/_base/di/instantiation';
import { Disposable } from '@moonshot-ai/agent-core-v2/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '@moonshot-ai/agent-core-v2/_base/di/scope';
import { IAgentScopeContext } from '@moonshot-ai/agent-core-v2/agent/scopeContext/scopeContext';
import { IAtomicDocumentStore } from '@moonshot-ai/agent-core-v2/persistence/interface/atomicDocumentStore';
import type { WorldModelCandidateBundle } from '@moonshot-ai/agent-core-v2/session/worldModelEvolution/worldModelEvolution';

export interface ArchiveDescriptor {
  readonly stateAbstractionFamily: string;
  readonly causalDepthBucket: number;
  readonly ruleCountBucket: number;
  readonly structuralScopeBucket: number;
  readonly stochasticityFamily: 'deterministic' | 'stochastic';
  readonly planningCostBucket: number;
  readonly generalizationBucket: number;
  readonly evaluatorCoverageBucket: number;
}

export interface ProgramArchiveEntry {
  readonly candidateId: string;
  readonly bundle: WorldModelCandidateBundle;
  readonly descriptor: ArchiveDescriptor;
  readonly islandId: string;
  readonly quality: number;
  readonly novelty: number;
  readonly status: 'proposed' | 'active' | 'promoted' | 'quarantined' | 'rejected' | 'archived';
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly evaluations: readonly string[];
}

export interface IAgentProgramArchiveService {
  readonly _serviceBrand: undefined;
  ready(): Promise<void>;
  insert(
    bundle: WorldModelCandidateBundle,
    options?: {
      readonly quality?: number;
      readonly novelty?: number;
      readonly status?: ProgramArchiveEntry['status'];
      readonly evaluations?: readonly string[];
    },
  ): Promise<ProgramArchiveEntry>;
  update(
    candidateId: string,
    update: Partial<Pick<ProgramArchiveEntry, 'quality' | 'novelty' | 'status' | 'evaluations'>>,
  ): Promise<ProgramArchiveEntry>;
  get(candidateId: string): ProgramArchiveEntry | undefined;
  list(status?: ProgramArchiveEntry['status']): readonly ProgramArchiveEntry[];
  selectParents(count: number, options?: { readonly exclude?: readonly string[] }): readonly ProgramArchiveEntry[];
  inspirations(parentId: string, count: number): readonly ProgramArchiveEntry[];
  prune(maximumEntries: number): Promise<readonly string[]>;
}

export const IAgentProgramArchiveService = createDecorator<IAgentProgramArchiveService>(
  'agentProgramArchiveService',
);

interface PersistedArchive {
  readonly protocol: 'program-archive/1';
  readonly entries: readonly ProgramArchiveEntry[];
}

export class AgentProgramArchiveService
  extends Disposable
  implements IAgentProgramArchiveService
{
  declare readonly _serviceBrand: undefined;

  private readonly scope: string;
  private readonly readyPromise: Promise<void>;
  private readonly entries = new Map<string, ProgramArchiveEntry>();
  private mutation: Promise<void> = Promise.resolve();

  constructor(
    @IAgentScopeContext agent: IAgentScopeContext,
    @IAtomicDocumentStore private readonly documents: IAtomicDocumentStore,
  ) {
    super();
    this.scope = agent.scope('adaptive');
    this._register(this.documents.acquire(this.scope, 'program-archive.json'));
    this.readyPromise = this.restore();
  }

  ready(): Promise<void> {
    return this.readyPromise;
  }

  insert(
    bundle: WorldModelCandidateBundle,
    options: {
      readonly quality?: number;
      readonly novelty?: number;
      readonly status?: ProgramArchiveEntry['status'];
      readonly evaluations?: readonly string[];
    } = {},
  ): Promise<ProgramArchiveEntry> {
    return this.mutate(async () => {
      const candidateId = createHash('sha256').update(bundle.source).digest('hex');
      const existing = this.entries.get(candidateId);
      if (existing !== undefined) return existing;
      const descriptor = describe(bundle);
      const now = Date.now();
      const entry: ProgramArchiveEntry = {
        candidateId,
        bundle,
        descriptor,
        islandId: islandId(descriptor),
        quality: clamp01(options.quality ?? 0),
        novelty: clamp01(options.novelty ?? this.estimateNovelty(descriptor)),
        status: options.status ?? 'proposed',
        createdAt: now,
        updatedAt: now,
        evaluations: unique(options.evaluations ?? []),
      };
      this.entries.set(candidateId, entry);
      await this.persist();
      return entry;
    });
  }

  update(
    candidateId: string,
    update: Partial<Pick<ProgramArchiveEntry, 'quality' | 'novelty' | 'status' | 'evaluations'>>,
  ): Promise<ProgramArchiveEntry> {
    return this.mutate(async () => {
      const current = this.require(candidateId);
      const updated: ProgramArchiveEntry = {
        ...current,
        quality: update.quality === undefined ? current.quality : clamp01(update.quality),
        novelty: update.novelty === undefined ? current.novelty : clamp01(update.novelty),
        status: update.status ?? current.status,
        evaluations: update.evaluations === undefined
          ? current.evaluations
          : unique([...current.evaluations, ...update.evaluations]),
        updatedAt: Date.now(),
      };
      this.entries.set(candidateId, updated);
      await this.persist();
      return updated;
    });
  }

  get(candidateId: string): ProgramArchiveEntry | undefined {
    return this.entries.get(candidateId);
  }

  list(status?: ProgramArchiveEntry['status']): readonly ProgramArchiveEntry[] {
    return [...this.entries.values()]
      .filter((entry) => status === undefined || entry.status === status)
      .sort((left, right) => left.candidateId.localeCompare(right.candidateId));
  }

  selectParents(
    count: number,
    options: { readonly exclude?: readonly string[] } = {},
  ): readonly ProgramArchiveEntry[] {
    const excluded = new Set(options.exclude ?? []);
    return this.list()
      .filter((entry) => !excluded.has(entry.candidateId) && !['rejected', 'quarantined'].includes(entry.status))
      .sort((left, right) => parentScore(right) - parentScore(left) || left.candidateId.localeCompare(right.candidateId))
      .slice(0, Math.max(0, count));
  }

  inspirations(parentId: string, count: number): readonly ProgramArchiveEntry[] {
    const parent = this.require(parentId);
    return this.list()
      .filter((entry) => entry.candidateId !== parentId && !['rejected', 'quarantined'].includes(entry.status))
      .map((entry) => ({ entry, score: complementaryScore(parent, entry) }))
      .sort((left, right) => right.score - left.score || left.entry.candidateId.localeCompare(right.entry.candidateId))
      .slice(0, Math.max(0, count))
      .map(({ entry }) => entry);
  }

  prune(maximumEntries: number): Promise<readonly string[]> {
    return this.mutate(async () => {
      if (!Number.isInteger(maximumEntries) || maximumEntries < 1) {
        throw new Error('maximumEntries must be a positive integer.');
      }
      const protectedIds = new Set(
        this.list()
          .filter((entry) => entry.status === 'promoted' || entry.status === 'active')
          .map((entry) => entry.candidateId),
      );
      const removable = this.list()
        .filter((entry) => !protectedIds.has(entry.candidateId))
        .sort((left, right) => retentionScore(left) - retentionScore(right) || left.createdAt - right.createdAt);
      const removed: string[] = [];
      while (this.entries.size > maximumEntries && removable.length > 0) {
        const entry = removable.shift()!;
        this.entries.delete(entry.candidateId);
        removed.push(entry.candidateId);
      }
      await this.persist();
      return removed;
    });
  }

  private estimateNovelty(descriptor: ArchiveDescriptor): number {
    const entries = this.list();
    if (entries.length === 0) return 1;
    const nearest = Math.min(...entries.map((entry) => descriptorDistance(descriptor, entry.descriptor)));
    return clamp01(nearest);
  }

  private require(candidateId: string): ProgramArchiveEntry {
    const entry = this.entries.get(candidateId);
    if (entry === undefined) throw new Error(`Unknown archive candidate: ${candidateId}`);
    return entry;
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    let resolveResult!: (value: T) => void;
    let rejectResult!: (error: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    this.mutation = this.mutation
      .then(async () => {
        await this.readyPromise;
        resolveResult(await operation());
      })
      .catch(rejectResult);
    return result;
  }

  private async restore(): Promise<void> {
    const persisted = await this.documents.get<PersistedArchive>(this.scope, 'program-archive.json');
    if (persisted?.protocol !== 'program-archive/1') return;
    for (const entry of persisted.entries) this.entries.set(entry.candidateId, entry);
  }

  private persist(): Promise<void> {
    const payload: PersistedArchive = { protocol: 'program-archive/1', entries: this.list() };
    return this.documents.set(this.scope, 'program-archive.json', payload);
  }
}

function describe(bundle: WorldModelCandidateBundle): ArchiveDescriptor {
  const source = bundle.source;
  const stateFields = (source.match(/state\.[A-Za-z_$][\w$]*/g) ?? []).length;
  const branches = (source.match(/\b(if|switch|case)\b/g) ?? []).length;
  const asyncCost = (source.match(/\basync\b|\bawait\b/g) ?? []).length;
  return {
    stateAbstractionFamily: createHash('sha256').update(String(stateFields)).update(source.replaceAll(/\s+/g, ' ').slice(0, 512)).digest('hex').slice(0, 12),
    causalDepthBucket: Math.min(8, Math.floor(branches / 4)),
    ruleCountBucket: Math.min(8, Math.floor(bundle.ruleIds.length / 4)),
    structuralScopeBucket: Math.min(8, new Set(bundle.ruleIds.map((ruleId) => String(ruleId).split(':')[0])).size),
    stochasticityFamily: bundle.deterministic ? 'deterministic' : 'stochastic',
    planningCostBucket: Math.min(8, Math.floor((source.length + asyncCost * 100) / 4096)),
    generalizationBucket: Math.min(8, Math.floor(bundle.supportedEvaluatorIds.length / 2)),
    evaluatorCoverageBucket: Math.min(8, bundle.supportedEvaluatorIds.length),
  };
}

function islandId(descriptor: ArchiveDescriptor): string {
  return `${descriptor.stateAbstractionFamily}:${descriptor.stochasticityFamily}:${descriptor.structuralScopeBucket}`;
}

function descriptorDistance(left: ArchiveDescriptor, right: ArchiveDescriptor): number {
  let distance = left.stateAbstractionFamily === right.stateAbstractionFamily ? 0 : 0.35;
  distance += Math.abs(left.causalDepthBucket - right.causalDepthBucket) / 8 * 0.15;
  distance += Math.abs(left.ruleCountBucket - right.ruleCountBucket) / 8 * 0.15;
  distance += Math.abs(left.structuralScopeBucket - right.structuralScopeBucket) / 8 * 0.15;
  distance += left.stochasticityFamily === right.stochasticityFamily ? 0 : 0.1;
  distance += Math.abs(left.evaluatorCoverageBucket - right.evaluatorCoverageBucket) / 8 * 0.1;
  return clamp01(distance);
}

function parentScore(entry: ProgramArchiveEntry): number {
  const statusBonus = entry.status === 'promoted' ? 0.2 : entry.status === 'active' ? 0.1 : 0;
  return 0.55 * entry.quality + 0.25 * entry.novelty + statusBonus;
}

function complementaryScore(parent: ProgramArchiveEntry, candidate: ProgramArchiveEntry): number {
  return (
    0.4 * candidate.quality +
    0.3 * candidate.novelty +
    0.3 * descriptorDistance(parent.descriptor, candidate.descriptor)
  );
}

function retentionScore(entry: ProgramArchiveEntry): number {
  return 0.6 * entry.quality + 0.3 * entry.novelty + (entry.status === 'archived' ? -0.1 : 0);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentProgramArchiveService,
  AgentProgramArchiveService,
  ScopeActivation.OnScopeCreated,
  'programArchive',
);
