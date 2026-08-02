import { describe, expect, it } from 'vitest';

import type { IAgentScopeHandle } from '#/_base/di/scope';
import type { PermissionMode } from '#/agent/permissionPolicy/types';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentTaskService } from '#/agent/task/task';
import { IAgentUsageService } from '#/agent/usage/usage';
import { IWireService } from '#/wire/wire';
import { SessionAgentBatchService } from '#/session/agentBatch/agentBatchService';
import type {
  AgentListFilter,
  AgentPersistence,
  CreateAgentOptions,
  ForkAgentOptions,
  IAgentLifecycleService,
} from '#/session/agentLifecycle/agentLifecycle';

class FakeLifecycle implements IAgentLifecycleService {
  declare readonly _serviceBrand: undefined;
  readonly created: CreateAgentOptions[] = [];
  readonly removed: string[] = [];
  readonly onDidCreate = () => ({ dispose() {} });
  readonly onDidDispose = () => ({ dispose() {} });

  async create(options: CreateAgentOptions = {}): Promise<IAgentScopeHandle> {
    this.created.push(options);
    return fakeHandle(options.agentId ?? 'agent');
  }
  async fork(_sourceAgentId: string, _options?: ForkAgentOptions): Promise<IAgentScopeHandle> {
    throw new Error('unused');
  }
  get(): IAgentScopeHandle | undefined { return undefined; }
  list(_filter?: AgentListFilter): readonly IAgentScopeHandle[] { return []; }
  persistence(): AgentPersistence | undefined { return undefined; }
  broadcastPermissionMode(_mode: PermissionMode): void {}
  async remove(agentId: string): Promise<void> { this.removed.push(agentId); }
}

function fakeHandle(id: string): IAgentScopeHandle {
  let usageReads = 0;
  let wireReads = 0;
  const turn = {
    id: 1,
    signal: new AbortController().signal,
    ready: Promise.resolve(),
    result: Promise.resolve({
      type: 'completed' as const,
      steps: 1,
      truncated: false,
    }),
    cancel: () => false,
  };
  const services = new Map<unknown, unknown>([
    [IAgentLoopService, {
      enqueue: () => ({
        assigned: Promise.resolve({
          turn,
          step: {
            id: 'step',
            turnId: 1,
            state: 'completed',
            signal: new AbortController().signal,
            result: Promise.resolve({ type: 'completed' }),
            cancel: () => false,
          },
        }),
        abort: () => false,
      }),
      cancel: () => false,
    }],
    [IAgentUsageService, {
      snapshot: () => {
        usageReads += 1;
        return usageReads === 1
          ? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }
          : { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheCreationTokens: 1 };
      },
    }],
    [IWireService, {
      list: async () => {
        wireReads += 1;
        return wireReads === 1
          ? []
          : [{
              type: 'message',
              role: 'assistant',
              content: [{ type: 'text', text: 'structured evaluation result' }],
            }];
      },
    }],
    [IAgentTaskService, {
      exitGracefully: async () => {},
    }],
  ]);
  return {
    id,
    scope: 'Agent',
    accessor: {
      get: (identifier: unknown) => {
        const value = services.get(identifier);
        if (value === undefined) throw new Error('Unexpected service request.');
        return value;
      },
    },
    dispose() {},
  } as unknown as IAgentScopeHandle;
}

describe('SessionAgentBatchService', () => {
  it('creates ephemeral evaluator agents and removes them after evidence extraction', async () => {
    const lifecycle = new FakeLifecycle();
    const service = new SessionAgentBatchService(lifecycle);
    const result = await service.run({
      batchId: 'batch-1',
      concurrency: 1,
      timeoutMs: 10_000,
      items: [{ itemId: 'item-1', prompt: 'Evaluate the candidate.' }],
    });

    expect(lifecycle.created).toHaveLength(1);
    expect(lifecycle.created[0]).toMatchObject({
      persistence: 'ephemeral',
      labels: {
        'adaptive.evaluation': 'true',
        'adaptive.item_id': 'item-1',
      },
    });
    expect(lifecycle.removed).toEqual([lifecycle.created[0]?.agentId]);
    expect(result.results[0]).toMatchObject({
      itemId: 'item-1',
      status: 'completed',
      output: 'structured evaluation result',
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 2,
        cacheCreationTokens: 1,
      },
    });
  });
});
