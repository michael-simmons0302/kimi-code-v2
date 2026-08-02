import { describe, expect, it } from 'vitest';

import type { DomainEvent } from '@moonshot-ai/agent-core-v2';
import {
  translateDomainEvent,
  translateGlobalEvent,
} from '#/v2/event-mapper';

describe('translateDomainEvent', () => {
  it('maps bounded adaptive status onto agent.status.updated', () => {
    const event: DomainEvent = {
      type: 'adaptive.status.updated',
      status: {
        runId: 'run-1' as never,
        phase: 'evaluating',
        evaluationsCompleted: 12,
        evaluationsActive: 1,
        viableModels: 4,
        openConflicts: 2,
        normalizedPosteriorEntropy: 0.4,
        decisionWeightedUncertainty: 0.3,
        remainingBudgetFraction: 0.7,
        verifiedCandidates: 3,
      },
    };

    expect(translateDomainEvent(event, 'session-1', 'main')).toEqual({
      type: 'agent.status.updated',
      sessionId: 'session-1',
      agentId: 'main',
      adaptive: {
        runId: 'run-1',
        phase: 'evaluating',
        evaluationsCompleted: 12,
        evaluationsActive: 1,
        viableModels: 4,
        openConflicts: 2,
        normalizedPosteriorEntropy: 0.4,
        decisionWeightedUncertainty: 0.3,
        remainingBudgetFraction: 0.7,
        verifiedCandidates: 3,
      },
    });
  });

  it.each([
    'adaptive.run.started',
    'adaptive.phase.changed',
    'adaptive.run.completed',
    'adaptive.run.failed',
  ] as const)('does not expose internal adaptive event %s', (type) => {
    expect(translateDomainEvent({ type } as DomainEvent, 'session-1', 'main')).toBeUndefined();
  });

  it('preserves existing background task renames', () => {
    const event = {
      type: 'task.started',
      info: {
        kind: 'process',
        taskId: 'bash-1',
        description: 'test',
        status: 'running',
        startedAt: 1,
        endedAt: null,
        command: 'echo test',
        pid: 1,
        exitCode: null,
      },
    } as DomainEvent;
    expect(translateDomainEvent(event, 'session-1', 'main')).toMatchObject({
      type: 'background.task.started',
      sessionId: 'session-1',
      agentId: 'main',
    });
  });
});

describe('translateGlobalEvent', () => {
  it('unwraps session metadata only', () => {
    expect(translateGlobalEvent({
      type: 'session.meta.updated',
      payload: { sessionId: 'session-1', title: 'Title' },
    })).toMatchObject({
      type: 'session.meta.updated',
      sessionId: 'session-1',
      title: 'Title',
    });
    expect(translateGlobalEvent({ type: 'other', payload: {} })).toBeUndefined();
  });
});
