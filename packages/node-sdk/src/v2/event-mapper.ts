/**
 * v2 → v1 event translation for the SDK event channel (pure mapping layer).
 */
import type { Event } from '@moonshot-ai/agent-core';
import type { DomainEvent } from '@moonshot-ai/agent-core-v2';

const DROPPED_DOMAIN_EVENT_TYPES: ReadonlySet<string> = new Set([
  'agent.activity.updated',
  'context.spliced',
  'task.notified',
  'plan.revision',
  'permission.approval.requested',
  'permission.approval.resolved',
  'prompt.submitted',
  'prompt.completed',
  'prompt.aborted',
  'prompt.steered',
  'adaptive.run.started',
  'adaptive.phase.changed',
  'adaptive.run.completed',
  'adaptive.run.cancelled',
  'adaptive.run.failed',
]);

const RENAMED_DOMAIN_EVENT_TYPES: Readonly<Record<string, string>> = {
  'task.started': 'background.task.started',
  'task.terminated': 'background.task.terminated',
};

export function translateDomainEvent(
  event: DomainEvent,
  sessionId: string,
  agentId: string,
): Event | undefined {
  if (event.type === 'adaptive.status.updated') {
    return {
      type: 'agent.status.updated',
      adaptive: {
        runId: event.status.runId,
        phase: event.status.phase,
        evaluationsCompleted: event.status.evaluationsCompleted,
        evaluationsActive: event.status.evaluationsActive,
        viableModels: event.status.viableModels,
        openConflicts: event.status.openConflicts,
        normalizedPosteriorEntropy: event.status.normalizedPosteriorEntropy,
        decisionWeightedUncertainty: event.status.decisionWeightedUncertainty,
        remainingBudgetFraction: event.status.remainingBudgetFraction,
        verifiedCandidates: event.status.verifiedCandidates,
      },
      sessionId,
      agentId,
    } as Event;
  }
  if (DROPPED_DOMAIN_EVENT_TYPES.has(event.type)) return undefined;
  const type = RENAMED_DOMAIN_EVENT_TYPES[event.type] ?? event.type;
  return { ...event, type, sessionId, agentId } as unknown as Event;
}

export function translateGlobalEvent(event: {
  readonly type: string;
  readonly payload: unknown;
}): Event | undefined {
  if (event.type !== 'session.meta.updated' || typeof event.payload !== 'object') {
    return undefined;
  }
  return { type: event.type, ...event.payload } as unknown as Event;
}
