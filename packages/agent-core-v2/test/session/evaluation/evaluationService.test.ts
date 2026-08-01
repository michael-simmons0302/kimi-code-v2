import { describe, expect, it } from 'vitest';

import {
  EVALUATION_RESULT_PROTOCOL,
  EVALUATION_SPEC_PROTOCOL,
  createEvaluationId,
  createEvidenceId,
  type EvidenceId,
} from '#/agent/adaptiveRuntime/adaptiveProtocol';
import type {
  EvaluationResult,
  EvaluationSpec,
  EvaluatorDefinition,
  ISessionEvaluationRegistry,
} from '#/session/evaluation/evaluation';
import type {
  EvaluationCacheEntry,
  EvaluationCacheHit,
  EvaluationCacheIdentity,
  ISessionEvaluationCacheService,
  PutEvaluationCacheInput,
} from '#/session/evaluation/evaluationCache';
import { createEvaluationSpecHash } from '#/session/evaluation/evaluationIdentity';
import { SessionEvaluationService } from '#/session/evaluation/evaluationService';
import { createEvaluationEnvironmentManifest } from '#/session/evaluation/environmentManifest';
import type {
  AppendEvidenceLinkInput,
  EvidenceGraphSnapshot,
  EvidenceLink,
  EvidenceNode,
  ISessionEvidenceGraphService,
} from '#/session/evaluationLedger/evidenceGraph';
import type {
  AppendEvaluationLedgerInput,
  EvaluationLedgerHead,
  EvaluationLedgerRecord,
  ISessionEvaluationLedgerService,
} from '#/session/evaluationLedger/evaluationLedger';

class Ledger implements ISessionEvaluationLedgerService {
  declare readonly _serviceBrand: undefined;
  readonly values: EvaluationLedgerRecord[] = [];
  async ready(): Promise<void> {}
  async append<TPayload>(
    input: AppendEvaluationLedgerInput<TPayload>,
  ): Promise<EvaluationLedgerRecord<TPayload>> {
    const previous = this.values.at(-1);
    const record: EvaluationLedgerRecord<TPayload> = {
      protocol: 'adaptive-ledger/1',
      sequence: this.values.length + 1,
      previousRecordHash: previous?.recordHash ?? null,
      recordHash: `record-${String(this.values.length + 1)}`,
      recordType: input.recordType,
      adaptiveRunId: input.adaptiveRunId,
      evidenceId: input.evidenceId,
      payload: input.payload,
    };
    this.values.push(record as EvaluationLedgerRecord);
    return record;
  }
  async *records(): AsyncIterable<EvaluationLedgerRecord> { yield* this.values; }
  head(): EvaluationLedgerHead {
    const record = this.values.at(-1);
    return {
      protocol: 'adaptive-ledger/1',
      sequence: record?.sequence ?? 0,
      recordHash: record?.recordHash ?? null,
    };
  }
  async verify() { return { valid: true, records: this.values.length, head: this.head() }; }
  async flush(): Promise<void> {}
}

class Graph implements ISessionEvidenceGraphService {
  declare readonly _serviceBrand: undefined;
  readonly nodes = new Map<EvidenceId, EvidenceNode>();
  readonly links: AppendEvidenceLinkInput[] = [];
  async ready(): Promise<void> {}
  async appendLink(input: AppendEvidenceLinkInput): Promise<EvidenceLink> {
    this.links.push(input);
    return {
      protocol: 'adaptive-evidence-graph/1',
      linkId: `link-${String(this.links.length)}`,
      sequence: this.links.length,
      ...input,
      contentHash: `hash-${String(this.links.length)}`,
    };
  }
  async getNode(evidenceId: EvidenceId): Promise<EvidenceNode | undefined> {
    return this.nodes.get(evidenceId);
  }
  async linksFor(): Promise<readonly EvidenceLink[]> { return []; }
  async traverse(): Promise<readonly EvidenceNode[]> { return []; }
  async supportingEvidenceForClaim(): Promise<readonly EvidenceNode[]> { return []; }
  async counterexamplesForRule(): Promise<readonly EvidenceNode[]> { return []; }
  async snapshot(): Promise<EvidenceGraphSnapshot> {
    return { protocol: 'adaptive-evidence-graph/1', nodes: [], links: [], hash: 'hash' };
  }
  async flush(): Promise<void> {}
}

class Cache implements ISessionEvaluationCacheService {
  declare readonly _serviceBrand: undefined;
  hit: EvaluationCacheHit | undefined;
  puts: PutEvaluationCacheInput[] = [];
  putError: Error | undefined;
  async ready(): Promise<void> {}
  deterministicKey(): string { return 'deterministic'; }
  stochasticReplicateKey(): string { return 'stochastic'; }
  getDeterministic(): EvaluationCacheHit | undefined { return this.hit; }
  getStochasticReplicate(): EvaluationCacheHit | undefined { return this.hit; }
  async put(input: PutEvaluationCacheInput): Promise<EvaluationCacheEntry> {
    if (this.putError !== undefined) throw this.putError;
    this.puts.push(input);
    return {
      protocol: 'evaluation-cache/1',
      cacheKey: 'stored',
      identity: input.identity,
      mode: input.result.mode === 'deterministic' ? 'deterministic' : 'stochastic-replicate',
      seed: input.seed,
      result: input.result,
      environment: input.environment,
      createdAtSequence: input.createdAtSequence,
      sourceEvaluationId: input.result.evaluationId,
    };
  }
  list(): readonly EvaluationCacheEntry[] { return []; }
  async invalidateEvaluator(): Promise<number> { return 0; }
  async flush(): Promise<void> {}
}

function definition(
  execute: EvaluatorDefinition['execute'],
  mode: EvaluatorDefinition['mode'] = 'deterministic',
): EvaluatorDefinition {
  return {
    evaluatorId: 'test.evaluator',
    version: '1',
    mode,
    soundness: 'sound',
    scale: 'repository',
    level: 'validity',
    outcomeFamily: 'boolean',
    defaultTimeoutMs: 1_000,
    cachePolicy: 'exact-environment',
    execute,
  };
}

function environment() {
  return createEvaluationEnvironmentManifest({
    baselineSnapshotHash: 'baseline',
    candidatePatchHash: 'patch',
    candidateWorkspaceHash: 'workspace',
    operatingSystem: 'linux',
    architecture: 'x64',
    sandboxBackendId: 'linux-bwrap',
    nodeVersion: '22.19.0',
    dependencyStateHash: 'dependencies',
    evaluatorId: 'test.evaluator',
    evaluatorVersion: '1',
    configurationHash: 'configuration',
    permittedEnvironment: { CI: '1' },
  });
}

function spec(
  inputEvidenceRefs: readonly EvidenceId[] = [],
  mode: 'deterministic' | 'stochastic' = 'deterministic',
  seed?: string,
): EvaluationSpec<{ readonly value: number }> {
  const base: EvaluationSpec<{ readonly value: number }> = {
    protocol: EVALUATION_SPEC_PROTOCOL,
    evaluationId: createEvaluationId(),
    evaluatorId: 'test.evaluator',
    evaluatorVersion: '1',
    input: { value: 1 },
    inputEvidenceRefs,
    budget: { timeoutMs: 1_000 },
    seed,
  };
  const manifest = environment();
  const identity: EvaluationCacheIdentity = {
    evaluatorId: 'test.evaluator',
    evaluatorVersion: '1',
    evaluationSpecHash: createEvaluationSpecHash(base, '1'),
    baselineSnapshotHash: manifest.baselineSnapshotHash,
    candidatePatchHash: manifest.candidatePatchHash,
    environmentManifestHash: manifest.environmentHash,
    dependencyStateHash: manifest.dependencyStateHash,
  };
  return { ...base, cache: { identity, environment: manifest } };
}

function passedResult(evidenceId = createEvidenceId()): EvaluationResult<boolean> {
  return {
    protocol: EVALUATION_RESULT_PROTOCOL,
    evaluationId: createEvaluationId(),
    evidenceId,
    evaluatorId: 'test.evaluator',
    evaluatorVersion: '1',
    mode: 'deterministic',
    soundness: 'sound',
    scale: 'repository',
    level: 'validity',
    outcomeFamily: 'boolean',
    status: 'passed',
    outcome: true,
    assertions: [],
    counterexampleRefs: [],
    artifactRefs: [],
    cost: { wallMs: 10 },
  };
}

function fixture(
  evaluator: EvaluatorDefinition,
): {
  readonly service: SessionEvaluationService;
  readonly ledger: Ledger;
  readonly graph: Graph;
  readonly cache: Cache;
} {
  const ledger = new Ledger();
  const graph = new Graph();
  const cache = new Cache();
  const registry = {
    _serviceBrand: undefined,
    get: () => evaluator,
    list: () => [evaluator],
  } as unknown as ISessionEvaluationRegistry;
  return {
    service: new SessionEvaluationService(registry, ledger, graph, cache),
    ledger,
    graph,
    cache,
  };
}

function output(mode: 'deterministic' | 'stochastic' = 'deterministic') {
  return {
    status: 'passed' as const,
    outcome: true,
    assertions: [],
    counterexampleRefs: [],
    artifactRefs: [],
    cost: { wallMs: 1 },
    mode,
  };
}

describe('SessionEvaluationService cache and evidence integration', () => {
  it('executes a cache miss, stores it, and links every input evidence node', async () => {
    let executions = 0;
    const inputEvidence = createEvidenceId();
    const run = fixture(definition(async () => {
      executions += 1;
      const { mode: _mode, ...result } = output();
      return result;
    }));
    run.graph.nodes.set(inputEvidence, {} as EvidenceNode);
    const result = await run.service.evaluate(spec([inputEvidence]));
    expect(executions).toBe(1);
    expect(result.evidenceId).toBeDefined();
    expect(run.cache.puts).toHaveLength(1);
    expect(run.graph.links).toContainEqual({
      fromEvidenceId: inputEvidence,
      toEvidenceId: result.evidenceId,
      relation: 'evaluated',
    });
    expect(run.ledger.values.map((record) => record.recordType)).toContain(
      'evaluation.cache.stored',
    );
  });

  it('returns an exact cache hit without executing and links it to source evidence', async () => {
    let executions = 0;
    const run = fixture(definition(async () => {
      executions += 1;
      const { mode: _mode, ...result } = output();
      return result;
    }));
    const request = spec();
    const source = passedResult();
    run.cache.hit = {
      cacheKey: 'hit',
      entry: {
        protocol: 'evaluation-cache/1',
        cacheKey: 'hit',
        identity: request.cache!.identity,
        mode: 'deterministic',
        result: source,
        environment: request.cache!.environment,
        createdAtSequence: 4,
        sourceEvaluationId: source.evaluationId,
      },
      provenance: {
        sourceEvaluationId: source.evaluationId,
        createdAtSequence: 4,
        exactEnvironment: true,
        seedMatched: true,
      },
    };
    run.graph.nodes.set(source.evidenceId!, {} as EvidenceNode);
    const result = await run.service.evaluate(request);
    expect(executions).toBe(0);
    expect(result.evidenceId).not.toBe(source.evidenceId);
    expect(result.cost.wallMs).toBe(0);
    expect(run.graph.links).toContainEqual({
      fromEvidenceId: source.evidenceId,
      toEvidenceId: result.evidenceId,
      relation: 'derived-from',
    });
  });

  it('rejects missing input provenance before evaluator execution', async () => {
    let executions = 0;
    const run = fixture(definition(async () => {
      executions += 1;
      const { mode: _mode, ...result } = output();
      return result;
    }));
    await expect(run.service.evaluate(spec([createEvidenceId()]))).rejects.toThrow(
      'input evidence does not exist',
    );
    expect(executions).toBe(0);
  });

  it('rejects a stale evaluation specification cache identity', async () => {
    const run = fixture(definition(async () => {
      const { mode: _mode, ...result } = output();
      return result;
    }));
    const request = spec();
    const stale = {
      ...request,
      cache: {
        ...request.cache!,
        identity: { ...request.cache!.identity, evaluationSpecHash: 'stale' },
      },
    };
    await expect(run.service.evaluate(stale)).rejects.toThrow(
      'specification hash mismatch',
    );
  });

  it('does not fail a valid evaluation when cache persistence fails', async () => {
    const run = fixture(definition(async () => {
      const { mode: _mode, ...result } = output();
      return result;
    }));
    run.cache.putError = new Error('disk unavailable');
    const result = await run.service.evaluate(spec());
    expect(result.status).toBe('passed');
    expect(run.ledger.values.map((record) => record.recordType)).toContain(
      'evaluation.cache.write_failed',
    );
  });

  it('does not cache an unseeded stochastic evaluation', async () => {
    const run = fixture(definition(async () => {
      const { mode: _mode, ...result } = output('stochastic');
      return result;
    }, 'stochastic'));
    const result = await run.service.evaluate(spec([], 'stochastic'));
    expect(result.mode).toBe('stochastic');
    expect(run.cache.puts).toHaveLength(0);
  });
});
