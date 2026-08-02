import { createControlledPromise } from '@antfu/utils';
import { describe, expect, it } from 'vitest';

import type { IDisposable } from '#/_base/di/lifecycle';
import type { Event } from '#/_base/event';
import { StateRegistry } from '#/_base/state/stateRegistry';
import type { IAgentAdaptiveMemoryService } from '#/agent/adaptiveMemory/adaptiveMemory';
import type { IAgentAdaptiveDirectiveService } from '#/agent/adaptivePrompt/adaptiveDirectiveService';
import { adaptiveCoordinatorStateKey } from '#/agent/adaptiveRuntime/adaptiveCoordinatorService';
import type { IAgentAdaptiveRuntimeService } from '#/agent/adaptiveRuntime/adaptiveRuntime';
import type {
  ConversationUndoParticipant,
  IAgentConversationUndoParticipantRegistry,
} from '#/agent/contextMemory/conversationUndoParticipants';
import type {
  FullCompactionTask,
  IAgentFullCompactionService,
} from '#/agent/fullCompaction/fullCompaction';
import type { IAgentStateService } from '#/agent/state/agentState';
import type { IAgentTestTimeSearchService } from '#/agent/testTimeSearch/testTimeSearch';
import type {
  IAgentWorldModelService,
  WorldModelCandidate,
} from '#/agent/worldModel/worldModel';
import type {
  AppendEvaluationLedgerInput,
  EvaluationLedgerHead,
  EvaluationLedgerRecord,
  ISessionEvaluationLedgerService,
} from '#/session/evaluationLedger/evaluationLedger';
import { AgentAdaptiveLifecycleService } from '#/session/adaptiveLifecycle/adaptiveLifecycleService';

class UndoRegistry implements IAgentConversationUndoParticipantRegistry {
  declare readonly _serviceBrand: undefined;
  participant: ConversationUndoParticipant | undefined;
  register(participant: ConversationUndoParticipant): IDisposable {
    this.participant = participant;
    return { dispose: () => { this.participant = undefined; } };
  }
  ordered(): readonly ConversationUndoParticipant[] {
    return this.participant === undefined ? [] : [this.participant];
  }
}

class Compaction implements IAgentFullCompactionService {
  declare readonly _serviceBrand: undefined;
  listener: ((task: FullCompactionTask) => void) | undefined;
  readonly onDidFinishCompaction: Event<FullCompactionTask> = (listener) => {
    this.listener = listener;
    return { dispose: () => { this.listener = undefined; } };
  };
  compact(): Promise<never> { throw new Error('unused'); }
  active(): FullCompactionTask | undefined { return undefined; }
}

class Ledger implements ISessionEvaluationLedgerService {
  declare readonly _serviceBrand: undefined;
  readonly appended: AppendEvaluationLedgerInput[] = [];
  async ready(): Promise<void> {}
  async append<TPayload>(
    input: AppendEvaluationLedgerInput<TPayload>,
  ): Promise<EvaluationLedgerRecord<TPayload>> {
    this.appended.push(input as AppendEvaluationLedgerInput);
    const sequence = this.appended.length;
    return {
      protocol: 'adaptive-ledger/1',
      sequence,
      previousRecordHash: sequence === 1 ? null : `hash-${String(sequence - 1)}`,
      recordHash: `hash-${String(sequence)}`,
      recordType: input.recordType,
      adaptiveRunId: input.adaptiveRunId,
      evidenceId: input.evidenceId,
      payload: input.payload,
    };
  }
  async *records(): AsyncIterable<EvaluationLedgerRecord> {}
  head(): EvaluationLedgerHead {
    return {
      protocol: 'adaptive-ledger/1',
      sequence: this.appended.length,
      recordHash: this.appended.length === 0 ? null : `hash-${String(this.appended.length)}`,
    };
  }
  async verify() { return { valid: true, records: this.appended.length, head: this.head() }; }
  async flush(): Promise<void> {}
}

function candidate(status: WorldModelCandidate['status']): WorldModelCandidate {
  return {
    manifest: {
      protocol: 'world-model-module/1',
      candidateId: 'candidate' as WorldModelCandidate['manifest']['candidateId'],
      parentCandidateIds: [],
      sourceHash: 'source',
      compiledHash: 'compiled',
      ruleGraphHash: 'rules',
      stateSchemaHash: 'state',
      actionSchemaHash: 'action',
      observationSchemaHash: 'observation',
      deterministic: true,
      supportedEvaluatorIds: [],
      evidenceHead: 'head',
    },
    source: 'source',
    compiledSource: 'compiled',
    ruleIds: [],
    status,
    createdAt: 1,
    evaluationRefs: [],
  };
}

function fixture() {
  const undo = new UndoRegistry();
  const compaction = new Compaction();
  const ledger = new Ledger();
  const runtime = {
    _serviceBrand: undefined,
    enabled: () => true,
    runId: () => 'run' as never,
    resetReasons: [] as string[],
    reset(reason: string) { this.resetReasons.push(reason); },
  } as unknown as IAgentAdaptiveRuntimeService & { resetReasons: string[] };
  let directive: string | undefined = 'active';
  const directives: IAgentAdaptiveDirectiveService = {
    _serviceBrand: undefined,
    get: () => directive,
    set: (value) => { directive = value; },
  };
  const memory = {
    _serviceBrand: undefined,
    invalidations: [] as Array<{ goalVersion: number; reason: string }>,
    ready: async () => {},
    invalidateForGoal(goalVersion: number, reason: string) {
      this.invalidations.push({ goalVersion, reason });
      return Promise.resolve();
    },
    flush: async () => {},
  } as unknown as IAgentAdaptiveMemoryService & {
    invalidations: Array<{ goalVersion: number; reason: string }>;
  };
  const search = {
    _serviceBrand: undefined,
    invalidations: [] as string[],
    checkpoints: 0,
    ready: async () => {},
    invalidate(reason: string) {
      this.invalidations.push(reason);
      return Promise.resolve();
    },
    checkpoint() { this.checkpoints += 1; return Promise.resolve(); },
    flush: async () => {},
  } as unknown as IAgentTestTimeSearchService & {
    invalidations: string[];
    checkpoints: number;
  };
  const model = candidate('active');
  const worldModels = {
    _serviceBrand: undefined,
    ready: async () => {},
    list: () => [model],
    setStatus: async (_id: unknown, status: WorldModelCandidate['status']) => {
      model.status = status;
      return model;
    },
    flush: async () => {},
  } as unknown as IAgentWorldModelService;
  const states = new StateRegistry() as unknown as IAgentStateService;
  const service = new AgentAdaptiveLifecycleService(
    runtime,
    directives,
    memory,
    search,
    worldModels,
    states,
    undo,
    compaction,
    ledger,
  );
  return {
    service,
    undo,
    compaction,
    ledger,
    runtime,
    memory,
    search,
    model,
    states,
    getDirective: () => directive,
  };
}

describe('AgentAdaptiveLifecycleService', () => {
  it('invalidates task-time state after committed conversation undo', async () => {
    const run = fixture();
    const prepared = await run.undo.participant!.prepare();
    await prepared.commit();

    expect(run.ledger.appended.some(({ recordType }) => recordType === 'adaptive.context.undone'))
      .toBe(true);
    expect(run.search.invalidations).toEqual(['Conversation history was undone.']);
    expect(run.memory.invalidations).toEqual([
      { goalVersion: 2, reason: 'Conversation history was undone.' },
    ]);
    expect(run.runtime.resetReasons).toEqual(['Conversation history was undone.']);
    expect(run.model.status).toBe('history-consistent');
    expect(run.getDirective()).toBeUndefined();
    expect(run.states.get(adaptiveCoordinatorStateKey)).toMatchObject({
      initialized: false,
      runRecorded: false,
      goalVersion: 2,
      requiredHardGates: [],
      passedHardGates: [],
      failedHardGates: [],
    });
  });

  it('reconciles a fork without recording it as an undo', async () => {
    const run = fixture();
    await run.service.reconcileFork('source-session');
    expect(run.ledger.appended.some(({ recordType }) => recordType === 'adaptive.context.undone'))
      .toBe(false);
    expect(run.search.invalidations[0]).toContain('source-session');
    expect(run.states.get(adaptiveCoordinatorStateKey).goalVersion).toBe(2);
  });

  it('records compaction and checkpoints without invalidating the search', async () => {
    const run = fixture();
    const completion = createControlledPromise<{
      summary: string;
      contextSummary: string;
      compactedCount: number;
      tokensBefore: number;
      tokensAfter: number;
      keptUserMessageCount: number;
      keptHeadUserMessageCount: number;
      droppedCount: number;
    }>();
    run.compaction.listener?.({
      taskId: 'compact-1',
      promise: completion,
      cancel: () => false,
    });
    completion.resolve({
      summary: 'summary',
      contextSummary: 'context',
      compactedCount: 4,
      tokensBefore: 100,
      tokensAfter: 25,
      keptUserMessageCount: 1,
      keptHeadUserMessageCount: 1,
      droppedCount: 3,
    });
    await completion;
    await Promise.resolve();

    expect(run.ledger.appended.some(({ recordType }) => recordType === 'adaptive.context.compacted'))
      .toBe(true);
    expect(run.search.checkpoints).toBe(1);
    expect(run.search.invalidations).toEqual([]);
  });
});
