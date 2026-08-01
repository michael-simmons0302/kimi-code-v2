import type { AdaptivePhase, AdaptiveRunId, AdaptiveStatusSnapshot } from './adaptiveProtocol';

declare module '#/app/event/eventBus' {
  interface DomainEventMap {
    'adaptive.run.started': {
      readonly runId: AdaptiveRunId;
    };
    'adaptive.phase.changed': {
      readonly runId: AdaptiveRunId;
      readonly from: AdaptivePhase;
      readonly to: AdaptivePhase;
      readonly reason: string;
    };
    'adaptive.status.updated': {
      readonly status: AdaptiveStatusSnapshot;
    };
    'adaptive.run.completed': {
      readonly runId: AdaptiveRunId;
      readonly reason: string;
    };
    'adaptive.run.failed': {
      readonly runId: AdaptiveRunId;
      readonly phase: AdaptivePhase;
      readonly reason: string;
    };
  }
}

export {};
