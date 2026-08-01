import { describe, expect, it } from 'vitest';

import { StateRegistry } from '#/_base/state/stateRegistry';
import type { IAgentAdaptiveMemoryService } from '#/agent/adaptiveMemory/adaptiveMemory';
import type { IAgentAdaptiveDirectiveService } from '#/agent/adaptivePrompt/adaptiveDirectiveService';
import type { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { IAgentStateService } from '#/agent/state/agentState';
import type { EvidenceId } from '#/agent/adaptiveRuntime/adaptiveProtocol';
import type { IAgentAdaptiveRuntimeService } from '#/agent/adaptiveRuntime/adaptiveRuntime';
import { AgentAdaptiveFinalResponseGateService } from '#/agent/adaptiveRuntime/adaptiveFinalResponseGateService';
import type {
  FinalResponsePlan,
  FinalResponseVerification,
  IAgentFinalResponseVerifierService,
} from '#/agent/adaptiveRuntime/finalResponseVerifier';
import type {
  BaselineSnapshot,
  ISessionCandidateWorkspaceService,
} from '#/session/candidateWorkspace/candidateWorkspace';
import type {
  AppendEvaluationLedgerInput,
  EvaluationLedgerHead,
  EvaluationLedgerRecord,
  ISessionEvaluationLedgerService,
} from '#/session/evaluationLedger/evaluationLedger';
import type { ISessionStructuralSignalsService } from '#/session/structuralSignals/structuralSignals';

const EVIDENCE = 'verified-evidence' as EvidenceId;

class FakeRuntime {
  currentPhase = 'committing';
  failure: { phase: string; reason: string } | undefined;
  enabled() { return true; }
  phase() { return this.currentPhase; }
  runId() { return undefined; }
  fail(phase: string, reason: string) {
    this.currentPhase = phase;
    this.failure = { phase, reason };
  }
}

class FakeVerifier implements IAgentFinalResponseVerifierService {
  declare readonly _serviceBrand: undefined;
  readonly plans: FinalResponsePlan[] = [];
  readonly texts: string[] = [];
  results: FinalResponseVerification[] = [];
  async verify(text: string, plan: FinalResponsePlan): Promise<FinalResponseVerification> {
    this.texts.push(text);
    this.plans.push(plan);
    const next = this.results.shift();
    if (next === undefined) throw new Error('No verifier result configured.');
    return next;
  }
}

class FakeLedger implements ISessionEvaluationLedgerService {
  declare readonly _serviceBrand: undefined;
  readonly appended: AppendEvaluationLedgerInput[] = [];
  constructor(private readonly baseline: BaselineSnapshot) {}
  async ready(): Promise<void> {}
  async append<TPayload>(
    input: AppendEvaluationLedgerInput<TPayload>,
  ): Promise<EvaluationLedgerRecord<TPayload>> {
    this.appended.push(input as AppendEvaluationLedgerInput);
    return {
      protocol: 'adaptive-ledger/1',
      sequence: this.appended.length + 1,
      previousRecordHash: 'previous',
      recordHash: 'hash',
      recordType: input.recordType,
      adaptiveRunId: input.adaptiveRunId,
      evidenceId: input.evidenceId,
      payload: input.payload,
    };
  }
  async *records(): AsyncIterable<EvaluationLedgerRecord> {
    yield {
      protocol: 'adaptive-ledger/1',
      sequence: 1,
      previousRecordHash: null,
      recordHash: 'baseline',
      recordType: 'baseline.captured',
      payload: this.baseline,
    };
  }
  head(): EvaluationLedgerHead {
    return { protocol: 'adaptive-ledger/1', sequence: 1, recordHash: 'baseline' };
  }
  async verify() { return { valid: true, records: 1, head: this.head() }; }
  async flush(): Promise<void> {}
}

function baseline(hash: string): BaselineSnapshot {
  return {
    protocol: 'candidate-baseline/1',
    snapshotId: `snapshot-${hash}` as BaselineSnapshot['snapshotId'],
    root: '/workspace',
    kind: 'git',
    files: [{
      relativePath: 'src/a.ts',
      sha256: hash,
      byteLength: 1,
      executable: false,
    }],
    createdAt: 1,
    hash,
  };
}

function verification(valid: boolean): FinalResponseVerification {
  return {
    valid,
    estimatedTokens: 20,
    unsupportedClaims: valid ? [] : ['unsupported'],
    missingChangedFiles: [],
    missingRequirements: [],
    forbiddenInternalDetails: [],
    evidenceRefs: [EVIDENCE],
  };
}

function fixture(results: FinalResponseVerification[]) {
  const runtime = new FakeRuntime();
  const verifier = new FakeVerifier();
  verifier.results = [...results];
  let directive: string | undefined;
  const directives: IAgentAdaptiveDirectiveService = {
    _serviceBrand: undefined,
    set: (value) => { directive = value; },
    get: () => directive,
  };
  const memory: IAgentAdaptiveMemoryService = {
    _serviceBrand: undefined,
    ready: async () => {},
    saveSummary: async () => { throw new Error('unused'); },
    summaries: () => [{
      protocol: 'adaptive-memory/1',
      summaryId: 'summary',
      kind: 'verified-progress',
      goalVersion: 1,
      structureHash: 'structure',
      contentHash: 'content',
      createdAtSequence: 1,
      claims: [{ text: 'Typecheck passed.', evidenceRefs: [EVIDENCE] }],
      exactDiagnostics: [],
      decisiveCounterexampleRefs: [],
      artifactRefs: [],
      stale: false,
    }],
    selectEvidence: () => ({ selected: [], omitted: [], tokenEstimate: 0 }),
    invalidateForGoal: async () => {},
    invalidateForStructure: async () => {},
    flush: async () => {},
  };
  const context: IAgentContextMemoryService = {
    _serviceBrand: undefined,
    get: () => [{ role: 'assistant', content: [{ type: 'text', text: 'Final answer.' }] }],
    append: () => {},
    appendLoopEvent: () => {},
    clear: () => {},
    undo: () => ({ cutIndex: -1, removedCount: 0, stoppedAtCompaction: false }),
    applyCompaction: (input) => ({
      summary: input.summary,
      contextSummary: input.contextSummary ?? '',
      compactedCount: input.compactedCount,
      tokensBefore: input.tokensBefore,
      tokensAfter: input.tokensAfter ?? 0,
      keptUserMessageCount: input.keptUserMessageCount ?? 0,
      keptHeadUserMessageCount: input.keptHeadUserMessageCount,
      droppedCount: input.droppedCount,
    }),
  };
  const initial = baseline('before');
  const current = baseline('after');
  const workspaces = {
    _serviceBrand: undefined,
    ready: async () => {},
    baseline: () => current,
  } as unknown as ISessionCandidateWorkspaceService;
  const ledger = new FakeLedger(initial);
  const signals = {
    _serviceBrand: undefined,
    conflicts: () => [],
  } as unknown as ISessionStructuralSignalsService;
  const states = new StateRegistry() as unknown as IAgentStateService;

  const service = new AgentAdaptiveFinalResponseGateService(
    runtime as unknown as IAgentAdaptiveRuntimeService,
    directives,
    memory,
    context,
    verifier,
    states,
    workspaces,
    ledger,
    signals,
  );
  return { service, runtime, verifier, getDirective: () => directive, ledger };
}

describe('AgentAdaptiveFinalResponseGateService', () => {
  it('suppresses coordinator preparation only during the committing phase', () => {
    const { service, runtime } = fixture([verification(true)]);
    expect(service.allowCoordinatorPreparation()).toBe(false);
    runtime.currentPhase = 'planning';
    expect(service.allowCoordinatorPreparation()).toBe(true);
  });

  it('returns verified with the exact changed-file plan', async () => {
    const { service, verifier, getDirective } = fixture([verification(true)]);
    const result = await service.verifyAfterStep();
    expect(result.kind).toBe('verified');
    expect(verifier.plans[0]?.changedFiles).toEqual(['src/a.ts']);
    expect(getDirective()).toBeUndefined();
  });

  it('requests exactly one bounded correction', async () => {
    const { service, getDirective } = fixture([verification(false)]);
    const result = await service.verifyAfterStep();
    expect(result.kind).toBe('correction-required');
    expect(getDirective()).toContain('Rewrite the final response once');
  });

  it('rejects commit after the correction also fails', async () => {
    const { service, runtime, getDirective } = fixture([
      verification(false),
      verification(false),
    ]);
    expect((await service.verifyAfterStep()).kind).toBe('correction-required');
    expect((await service.verifyAfterStep()).kind).toBe('rejected');
    expect(runtime.failure?.phase).toBe('commit-rejected');
    expect(getDirective()).toBeUndefined();
  });

  it('is not applicable outside the committing phase', async () => {
    const { service, runtime } = fixture([]);
    runtime.currentPhase = 'planning';
    expect(await service.verifyAfterStep()).toEqual({ kind: 'not-applicable' });
  });
});
