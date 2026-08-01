import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { abortError } from '#/_base/utils/abort';
import { IAgentLoopService } from '#/agent/loop/loop';
import { ContinuationStepRequest } from '#/agent/loop/stepRequest';
import {
  IAgentAdaptiveCoordinatorService,
  type AdaptiveObserveStepDecision,
} from './adaptiveCoordinator';
import { IAgentAdaptiveRuntimeService } from './adaptiveRuntime';

const PREPARE_PRIORITY = -1_000_000;
const RECONCILE_PRIORITY = 1_000_000;

/**
 * Ordered bridge used until the loop owns the coordinator calls directly.
 *
 * Preparation runs after ordinary pre-step hooks. Reconciliation runs before
 * ordinary post-step hooks. Coordinator failures are converted to abort errors
 * because the legacy post-step runner only propagates abort-class failures.
 */
export class AgentAdaptiveLoopBridgeService extends Disposable {
  constructor(
    @IAgentLoopService loop: IAgentLoopService,
    @IAgentAdaptiveCoordinatorService coordinator: IAgentAdaptiveCoordinatorService,
    @IAgentAdaptiveRuntimeService runtime: IAgentAdaptiveRuntimeService,
  ) {
    super();
    this._register(
      loop.hooks.onWillBeginStep.register(
        'adaptive-authoritative-prepare',
        async (context, next) => {
          await next();
          if (!runtime.enabled()) return;
          try {
            await coordinator.prepareStep({
              turnId: context.turnId,
              step: context.step,
              stepId: `${String(context.turnId)}:${String(context.step)}`,
              signal: context.signal,
            });
          } catch (error) {
            runtime.fail(
              'infrastructure-failed',
              error instanceof Error ? error.message : String(error),
            );
            throw failClosedAbort(error);
          }
        },
        { priority: PREPARE_PRIORITY },
      ),
    );
    this._register(
      loop.hooks.onDidFinishStep.register(
        'adaptive-authoritative-reconcile',
        async (context, next) => {
          if (!runtime.enabled()) {
            await next();
            return;
          }
          let decision: AdaptiveObserveStepDecision;
          try {
            decision = await coordinator.observeStep({
              turnId: context.turnId,
              step: context.step,
              stepId: `${String(context.turnId)}:${String(context.step)}`,
              signal: context.signal,
              usage: context.usage,
              finishReason: context.finishReason,
            });
          } catch (error) {
            runtime.fail(
              'infrastructure-failed',
              error instanceof Error ? error.message : String(error),
            );
            throw failClosedAbort(error);
          }
          if (decision.continueTurn) {
            loop.enqueue(
              new ContinuationStepRequest({
                kind: 'adaptive.continue',
                admission: 'activeTurnOnly',
                mergeable: false,
                turnScoped: true,
              }),
            );
          }
          if (decision.stopTurn) context.stopTurn = true;
          await next();
        },
        { priority: RECONCILE_PRIORITY },
      ),
    );
  }
}

function failClosedAbort(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return abortError(`Adaptive loop coordination failed closed: ${message}`);
}

registerScopedService(
  LifecycleScope.Agent,
  AgentAdaptiveLoopBridgeService,
  AgentAdaptiveLoopBridgeService,
  ScopeActivation.OnScopeCreated,
  'adaptiveLoopBridge',
);
