import { describe, expect, it } from 'vitest';

import { StateRegistry } from '#/_base/state/stateRegistry';
import { OrderedHookSlot } from '#/hooks';
import type { IAgentAdaptiveMemoryService } from '#/agent/adaptiveMemory/adaptiveMemory';
import type { IAgentAdaptiveDirectiveService } from '#/agent/adaptivePrompt/adaptiveDirectiveService';
import type { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type {
  AfterStepContext,
  BeforeStepContext,
  IAgentLoopService,
} from '#/agent/loop/loop';
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
  EvaluationLedgerHead,
  EvaluationLedgerRecord,
  ISessionEvaluationLedgerService,
} from '#/session/evaluationLedger/evaluationLedger';
import type { ISessionStructuralSignalsService } from '#/session/structuralSignals/structuralSignals';

const EVIDENCE = 'verified-evidence' as EvidenceId;

class FakeLoop {
  readonly hooks = {
    onWillBeginStep: new OrderedHookSlot<BeforeStepContext>(),
    onDidFinishStep: new OrderedHookSlot<AfterStepContext>(),
  };
  readonly enqueued: unknown[] = [];
  enqueue(request: unknown) {
    this.enqueued.push(request);
    return { assigned: Promise.resolve(undefined), abort: () => false };
  }
}

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
  readonly appended: unknown[] = [];
  constructor(private readonly baseline: BaselineSnapshot) {}
  async ready(): Promise<void> {}
  async append<TPayload>(input: unknown): Promise<EvaluationLedgerRecord<TPayload>> {
    this.appended.push(input);
    return {
      protocol: 'adaptive-ledger/1',
      sequence: this.appended.length + 1,
      previousRecordHash: 'previous',
      recordHash: 'hash',
      recordType: 'final.claim.verified',
      payload: input as TPayload,
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
  async verify() {
    return { valid: true, records: 1, head: this.head() };
  }
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
  const loop = new FakeLoop();
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
    undo: () => ({ removed: [], tokenCount: 0 }),
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

  new AgentAdaptiveFinalResponseGateService(
    loop as unknown as IAgentLoopService,
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
  return { loop, runtime, verifier, getDirective: () => directive, ledger };
}

function afterContext(): AfterStepContext {
  return {
    turnId: 1,
    step: 2,
    signal: new AbortController().signal,
    usage: { inputTokens: 1, outputTokens: 1 },
    finishReason: 'completed',
    stopTurn: false,
  };
}

describe('AgentAdaptiveFinalResponseGateService', () => {
  it('blocks lower-priority preparation during a commit-only turn', async () => {
    const { loop } = fixture([verification(true)]);
    let lowerHookRan = false;
    loop.hooks.onWillBeginStep.register('lower', async (_context, next) => {
      lowerHookRan = true;
      await next();
    }, { priority: -1_000_000 });
    await loop.hooks.onWillBeginStep.run({
      turnId: 1,
      step: 2,
      signal: new AbortController().signal,
    });
    expect(lowerHookRan).toBe(false);
  });

  it('allows a valid response to continue to reconciliation', async () => {
    const { loop, verifier } = fixture([verification(true)]);
    let reconciliationRan = false;
    loop.hooks.onDidFinishStep.register('reconciliation', async (_context, next) => {
      reconciliationRan = true;
      await next();
    }, { priority: 1_000_000 });
    await loop.hooks.onDidFinishStep.run(afterContext());
    expect(reconciliationRan).toBe(true);
    expect(verifier.plans[0]?.changedFiles).toEqual(['src/a.ts']);
  });

  it('enqueues exactly one correction and blocks reconciliation', async () => {
    const { loop, getDirective } = fixture([verification(false)]);
    let reconciliationRan = false;
    loop.hooks.onDidFinishStep.register('reconciliation', async (_context, next) => {
      reconciliationRan = true;
      await next();
    }, { priority: 1_000_000 });
    await loop.hooks.onDidFinishStep.run(afterContext());
    expect(reconciliationRan).toBe(false);
    expect(loop.enqueued).toHaveLength(1);
    expect(getDirective()).toContain('Rewrite the final response once');
  });

  it('rejects commit after a second invalid response', async () => {
    const { loop, runtime } = fixture([verification(false), verification(false)]);
    await loop.hooks.onDidFinishStep.run(afterContext());
    const second = afterContext();
    await loop.hooks.onDidFinishStep.run(second);
    expect(loop.enqueued).toHaveLength(1);
    expect(runtime.failure?.phase).toBe('commit-rejected');
    expect(second.stopTurn).toBe(true);
  });
});
