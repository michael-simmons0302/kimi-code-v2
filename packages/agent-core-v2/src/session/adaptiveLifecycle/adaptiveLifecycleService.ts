import { rm } from 'node:fs/promises';
import { join } from 'pathe';

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentAdaptiveMemoryService } from '#/agent/adaptiveMemory/adaptiveMemory';
import { IAgentAdaptiveDirectiveService } from '#/agent/adaptivePrompt/adaptiveDirectiveService';
import {
  adaptiveCoordinatorStateKey,
} from '#/agent/adaptiveRuntime/adaptiveCoordinatorService';
import {
  adaptiveFinalResponseGateStateKey,
} from '#/agent/adaptiveRuntime/adaptiveFinalResponseGateService';
import { IAgentAdaptiveRuntimeService } from '#/agent/adaptiveRuntime/adaptiveRuntime';
import {
  IAgentConversationUndoParticipantRegistry,
} from '#/agent/contextMemory/conversationUndoParticipants';
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentTestTimeSearchService } from '#/agent/testTimeSearch/testTimeSearch';
import { IAgentWorldModelService } from '#/agent/worldModel/worldModel';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionEvaluationLedgerService } from '#/session/evaluationLedger/evaluationLedger';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionLifecycleHooks } from '#/session/sessionLifecycleHooks/sessionLifecycleHooks';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import {
  IAgentAdaptiveLifecycleService,
  ISessionAdaptiveLifecycleService,
} from './adaptiveLifecycle';

const UNDO_PARTICIPANT_ID = 'adaptive-lifecycle';
const SESSION_DOCUMENTS_TO_RESET_ON_FORK = Object.freeze([
  'baseline.json',
  'evaluation-cache.json',
  'manifest/adaptive-export-manifest.json',
]);
const TRANSIENT_ADAPTIVE_DIRECTORIES = Object.freeze([
  'workspaces',
  'ephemeral-agents',
  'hidden-promotion',
  'promotion/hidden',
  'protected-evaluator',
  'evaluations/hidden',
]);

export class AgentAdaptiveLifecycleService
  extends Disposable
  implements IAgentAdaptiveLifecycleService
{
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentAdaptiveRuntimeService private readonly runtime: IAgentAdaptiveRuntimeService,
    @IAgentAdaptiveDirectiveService private readonly directive: IAgentAdaptiveDirectiveService,
    @IAgentAdaptiveMemoryService private readonly memory: IAgentAdaptiveMemoryService,
    @IAgentTestTimeSearchService private readonly search: IAgentTestTimeSearchService,
    @IAgentWorldModelService private readonly worldModels: IAgentWorldModelService,
    @IAgentStateService private readonly states: IAgentStateService,
    @IAgentConversationUndoParticipantRegistry undoParticipants: IAgentConversationUndoParticipantRegistry,
    @IAgentFullCompactionService compaction: IAgentFullCompactionService,
    @ISessionEvaluationLedgerService private readonly ledger: ISessionEvaluationLedgerService,
  ) {
    super();
    this._register(
      undoParticipants.register({
        id: UNDO_PARTICIPANT_ID,
        priority: 40,
        prepare: async () => ({
          commit: async () => {
            await this.invalidateTaskState('Conversation history was undone.');
          },
          rollback: async () => {},
        }),
      }),
    );
    this._register(
      compaction.onDidFinishCompaction((task) => {
        void task.promise.then(
          async (result) => {
            if (!this.runtime.enabled()) return;
            await this.ledger.ready();
            await this.ledger.append({
              recordType: 'adaptive.context.compacted',
              adaptiveRunId: this.runtime.runId(),
              payload: {
                source: task.trigger,
                compactedCount: result.compactedCount,
                tokensBefore: result.tokensBefore,
                tokensAfter: result.tokensAfter,
                droppedCount: result.droppedCount,
                keptUserMessageCount: result.keptUserMessageCount,
                keptHeadUserMessageCount: result.keptHeadUserMessageCount,
              },
            });
            await this.search.checkpoint();
            await this.memory.flush();
          },
          async (error) => {
            if (!this.runtime.enabled()) return;
            await this.ledger.ready();
            await this.ledger.append({
              recordType: 'adaptive.run.failed',
              adaptiveRunId: this.runtime.runId(),
              payload: {
                phase: 'infrastructure-failed',
                reason: `Adaptive compaction checkpoint failed: ${errorMessage(error)}`,
              },
            });
          },
        );
      }),
    );
  }

  reconcileFork(sourceSessionId: string): Promise<void> {
    if (sourceSessionId.trim().length === 0) {
      throw new Error('Fork reconciliation requires a source session ID.');
    }
    return this.invalidateTaskState(
      `Session forked from ${sourceSessionId}; copied task-time state requires revalidation.`,
    );
  }

  async flush(): Promise<void> {
    await Promise.all([
      this.memory.flush(),
      this.search.flush(),
      this.worldModels.flush(),
      this.ledger.flush(),
    ]);
  }

  private async invalidateTaskState(reason: string): Promise<void> {
    if (!this.runtime.enabled()) return;
    await Promise.all([
      this.ledger.ready(),
      this.memory.ready(),
      this.search.ready(),
      this.worldModels.ready(),
    ]);
    const current = this.states.get(adaptiveCoordinatorStateKey);
    const nextGoalVersion = current.goalVersion + 1;
    await this.ledger.append({
      recordType: 'adaptive.context.undone',
      adaptiveRunId: this.runtime.runId(),
      payload: {
        reason,
        previousGoalVersion: current.goalVersion,
        nextGoalVersion,
      },
    });
    this.states.set(adaptiveCoordinatorStateKey, {
      initialized: false,
      runRecorded: false,
      continuationCount: 0,
      evaluationsCompleted: 0,
      verifiedEvaluations: 0,
      goalVersion: nextGoalVersion,
      requiredHardGates: [],
      passedHardGates: [],
      failedHardGates: [],
      wallMs: 0,
      inputTokens: 0,
      outputTokens: 0,
    });
    this.states.set(adaptiveFinalResponseGateStateKey, { correctionAttempts: 0 });
    this.directive.set(undefined);
    this.runtime.reset(reason);
    await this.memory.invalidateForGoal(nextGoalVersion, reason);
    for (const candidate of this.worldModels.list()) {
      if (
        candidate.status === 'planning-eligible' ||
        candidate.status === 'active' ||
        candidate.status === 'promoted'
      ) {
        await this.worldModels.setStatus(
          candidate.manifest.candidateId,
          'history-consistent',
          reason,
        );
      }
    }
    await this.search.invalidate(reason);
  }
}

export class SessionAdaptiveLifecycleService
  extends Disposable
  implements ISessionAdaptiveLifecycleService
{
  declare readonly _serviceBrand: undefined;

  private readonly adaptiveScope: string;

  constructor(
    @ISessionContext private readonly session: ISessionContext,
    @ISessionLifecycleHooks hooks: ISessionLifecycleHooks,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
    @IAtomicDocumentStore private readonly documents: IAtomicDocumentStore,
    @ISessionEvaluationLedgerService private readonly ledger: ISessionEvaluationLedgerService,
    @IAgentLifecycleService private readonly agents: IAgentLifecycleService,
  ) {
    super();
    this.adaptiveScope = session.scope('adaptive');
    this._register(
      hooks.onDidCreateSession(async ({ source }) => {
        if (source.kind === 'fork') {
          await this.reconcileFork(source.sessionId);
          return;
        }
        if (source.kind === 'resume') {
          await this.recordResume();
        }
      }),
    );
    this._register(
      hooks.onWillCloseSession(async () => {
        await this.flushAgents();
        if (this.ledger.head().recordHash !== null) {
          await this.ledger.append({
            recordType: 'adaptive.session.closed',
            payload: { sessionId: this.session.sessionId },
          });
        }
        await this.ledger.flush();
        await this.removeTransientDirectories();
      }),
    );
  }

  private async reconcileFork(sourceSessionId: string): Promise<void> {
    await this.metadata.ready;
    const metadata = await this.metadata.read();
    if (metadata.forkedFrom !== sourceSessionId) {
      throw new Error(
        `Adaptive fork lineage mismatch: metadata=${String(metadata.forkedFrom)} source=${sourceSessionId}`,
      );
    }
    await this.removeTransientDirectories();
    for (const key of SESSION_DOCUMENTS_TO_RESET_ON_FORK) {
      await this.documents.delete(this.adaptiveScope, key);
    }
    await this.ledger.ready();
    await this.ledger.append({
      recordType: 'adaptive.session.forked',
      payload: {
        sourceSessionId,
        targetSessionId: this.session.sessionId,
      },
    });
    for (const agent of this.agents.list()) {
      await agent.accessor
        .get(IAgentAdaptiveLifecycleService)
        .reconcileFork(sourceSessionId);
    }
    await this.ledger.flush();
  }

  private async recordResume(): Promise<void> {
    await this.ledger.ready();
    if (this.ledger.head().recordHash === null) return;
    await this.ledger.append({
      recordType: 'adaptive.session.resumed',
      payload: { sessionId: this.session.sessionId },
    });
    await this.ledger.flush();
  }

  private async flushAgents(): Promise<void> {
    for (const agent of this.agents.list()) {
      await agent.accessor.get(IAgentAdaptiveLifecycleService).flush();
    }
  }

  private async removeTransientDirectories(): Promise<void> {
    await Promise.all(
      TRANSIENT_ADAPTIVE_DIRECTORIES.map((relativePath) =>
        rm(join(this.session.sessionDir, 'adaptive', relativePath), {
          recursive: true,
          force: true,
        }),
      ),
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentAdaptiveLifecycleService,
  AgentAdaptiveLifecycleService,
  ScopeActivation.OnScopeCreated,
  'adaptiveLifecycle',
);

registerScopedService(
  LifecycleScope.Session,
  ISessionAdaptiveLifecycleService,
  SessionAdaptiveLifecycleService,
  ScopeActivation.OnScopeCreated,
  'adaptiveLifecycle',
);
