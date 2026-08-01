import { randomUUID } from 'node:crypto';

import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { type ContentPart } from '#/kosong/contract/message';
import { USER_PROMPT_ORIGIN } from '#/agent/contextMemory/types';
import { MessageStepRequest } from '#/agent/loop/stepRequest';
import type { AgentLoopStatus } from '#/agent/loop/loop';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentProfileService, type BindAgentInput } from '#/agent/profile/profile';
import { IAgentTaskService } from '#/agent/task/task';
import { IAgentUsageService } from '#/agent/usage/usage';
import { IWireService } from '#/wire/wire';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import {
  ISessionAgentBatchService,
  type AgentBatchItem,
  type AgentBatchItemResult,
  type AgentBatchRequest,
  type AgentBatchResult,
  type AgentBatchUsage,
} from './agentBatch';

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_RETRIES = 2;

export class SessionAgentBatchService implements ISessionAgentBatchService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentLifecycleService private readonly agents: IAgentLifecycleService,
  ) {}

  async run(
    request: AgentBatchRequest,
    signal?: AbortSignal,
  ): Promise<AgentBatchResult> {
    validateRequest(request);
    signal?.throwIfAborted();
    const startedAt = Date.now();
    const controller = new AbortController();
    const batchSignal = signal === undefined
      ? controller.signal
      : AbortSignal.any([signal, controller.signal]);
    const concurrency = Math.max(1, Math.min(request.concurrency ?? DEFAULT_CONCURRENCY, request.items.length));
    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const results = new Array<AgentBatchItemResult>(request.items.length);
    let nextIndex = 0;

    const workers = Array.from({ length: concurrency }, async () => {
      while (!batchSignal.aborted) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= request.items.length) return;
        const item = request.items[index];
        if (item === undefined) return;
        results[index] = await this.runItem(
          request.batchId,
          item,
          index,
          timeoutMs,
          batchSignal,
        );
      }
    });

    await Promise.all(workers);
    controller.abort('batch complete');
    return {
      batchId: request.batchId,
      status: batchSignal.aborted && signal?.aborted === true ? 'cancelled' : 'completed',
      results: results.filter((result): result is AgentBatchItemResult => result !== undefined),
      usage: aggregateUsage(results),
      durationMs: Date.now() - startedAt,
    };
  }

  private async runItem(
    batchId: string,
    item: AgentBatchItem,
    index: number,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<AgentBatchItemResult> {
    const startedAt = Date.now();
    const agentId = `adaptive-eval-${sanitizeId(batchId)}-${String(index)}-${randomUUID()}`;
    let attempts = 0;
    let lastError: unknown;
    while (attempts <= MAX_RETRIES) {
      attempts += 1;
      signal.throwIfAborted();
      try {
        const result = await this.runAttempt(
          agentId,
          item,
          timeoutMs,
          signal,
        );
        return {
          ...result,
          attempts,
          durationMs: Date.now() - startedAt,
        };
      } catch (error) {
        lastError = error;
        if (!retryable(error) || attempts > MAX_RETRIES) break;
        await delay(Math.min(5_000, 250 * 2 ** (attempts - 1)), signal);
      } finally {
        await this.agents.remove(agentId);
      }
    }
    return {
      itemId: item.itemId,
      status: signal.aborted ? 'cancelled' : 'failed',
      output: '',
      usage: emptyUsage(),
      attempts,
      durationMs: Date.now() - startedAt,
      error: lastError instanceof Error ? lastError.message : String(lastError),
      evidence: [],
    };
  }

  private async runAttempt(
    agentId: string,
    item: AgentBatchItem,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<Omit<AgentBatchItemResult, 'attempts' | 'durationMs'>> {
    const handle = await this.agents.create({
      agentId,
      binding: bindingFor(item),
      persistence: 'ephemeral',
      labels: {
        'adaptive.evaluation': 'true',
        'adaptive.item_id': item.itemId,
      },
    });
    const loop = handle.accessor.get(IAgentLoopService);
    const usage = handle.accessor.get(IAgentUsageService);
    const wire = handle.accessor.get(IWireService);
    const taskService = handle.accessor.get(IAgentTaskService);
    const timeout = AbortSignal.timeout(timeoutMs);
    const attemptSignal = AbortSignal.any([signal, timeout]);
    const initialUsage = usage.snapshot();
    const before = await wire.list();
    const beforeCount = before.length;
    const receipt = loop.enqueue(
      new MessageStepRequest(
        {
          role: 'user',
          content: promptContent(item),
          origin: USER_PROMPT_ORIGIN,
        },
        { admission: 'newTurn', mergeable: false, turnScoped: true },
      ),
    );
    const assignment = await receipt.assigned;
    const result = await Promise.race([
      assignment.turn.result,
      waitForAbort(attemptSignal),
    ]);
    if (attemptSignal.aborted) {
      loop.cancel(assignment.turn.id, attemptSignal.reason);
      throw attemptSignal.reason ?? new Error('Evaluation agent cancelled.');
    }
    if (result.type !== 'completed') {
      throw result.type === 'failed'
        ? result.error
        : result.reason;
    }
    await taskService.exitGracefully({ timeoutMs: 5_000, reason: 'evaluation complete' });
    const records = (await wire.list()).slice(beforeCount);
    const output = extractAssistantOutput(records);
    const finalUsage = usage.snapshot();
    return {
      itemId: item.itemId,
      status: 'completed',
      output,
      usage: usageDelta(initialUsage, finalUsage),
      evidence: records,
    };
  }
}

function validateRequest(request: AgentBatchRequest): void {
  if (request.batchId.trim().length === 0) throw new Error('Agent batch ID cannot be empty.');
  if (request.items.length === 0) throw new Error('Agent batch requires at least one item.');
  const ids = new Set<string>();
  for (const item of request.items) {
    if (item.itemId.trim().length === 0) throw new Error('Agent batch item ID cannot be empty.');
    if (ids.has(item.itemId)) throw new Error(`Duplicate agent batch item ID: ${item.itemId}`);
    ids.add(item.itemId);
    if (item.prompt.length === 0) throw new Error(`Agent batch item ${item.itemId} has no prompt.`);
  }
}

function bindingFor(item: AgentBatchItem): BindAgentInput {
  return {
    id: item.profileId ?? 'default',
    model: item.model,
    systemPrompt: item.systemPrompt,
  };
}

function promptContent(item: AgentBatchItem): readonly ContentPart[] {
  return typeof item.prompt === 'string'
    ? [{ type: 'text', text: item.prompt }]
    : item.prompt;
}

function extractAssistantOutput(records: readonly unknown[]): string {
  const texts: string[] = [];
  for (const record of records) {
    if (record === null || typeof record !== 'object') continue;
    const object = record as Record<string, unknown>;
    if (object['type'] !== 'message' && object['role'] !== 'assistant') continue;
    const content = object['content'];
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (
        part !== null &&
        typeof part === 'object' &&
        (part as Record<string, unknown>)['type'] === 'text' &&
        typeof (part as Record<string, unknown>)['text'] === 'string'
      ) {
        texts.push((part as Record<string, unknown>)['text'] as string);
      }
    }
  }
  return texts.join('');
}

function emptyUsage(): AgentBatchUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
}

function aggregateUsage(
  results: readonly (AgentBatchItemResult | undefined)[],
): AgentBatchUsage {
  return results.reduce<AgentBatchUsage>(
    (total, result) => {
      if (result === undefined) return total;
      return {
        inputTokens: total.inputTokens + result.usage.inputTokens,
        outputTokens: total.outputTokens + result.usage.outputTokens,
        cacheReadTokens: total.cacheReadTokens + result.usage.cacheReadTokens,
        cacheCreationTokens: total.cacheCreationTokens + result.usage.cacheCreationTokens,
      };
    },
    emptyUsage(),
  );
}

function usageDelta(
  before: ReturnType<IAgentUsageService['snapshot']>,
  after: ReturnType<IAgentUsageService['snapshot']>,
): AgentBatchUsage {
  return {
    inputTokens: Math.max(0, after.inputTokens - before.inputTokens),
    outputTokens: Math.max(0, after.outputTokens - before.outputTokens),
    cacheReadTokens: Math.max(0, after.cacheReadTokens - before.cacheReadTokens),
    cacheCreationTokens: Math.max(0, after.cacheCreationTokens - before.cacheCreationTokens),
  };
}

function retryable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /rate.?limit|temporar|timeout|overload|unavailable|reset|ECONNRESET|ETIMEDOUT/i.test(message);
}

function sanitizeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 64);
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

registerScopedService(
  LifecycleScope.Session,
  ISessionAgentBatchService,
  SessionAgentBatchService,
  ScopeActivation.OnScopeCreated,
  'agentBatch',
);
