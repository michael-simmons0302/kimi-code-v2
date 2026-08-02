import { createDecorator } from '#/_base/di/instantiation';

export interface IAgentAdaptiveLifecycleService {
  readonly _serviceBrand: undefined;
  reconcileFork(sourceSessionId: string): Promise<void>;
  flush(): Promise<void>;
}

export const IAgentAdaptiveLifecycleService =
  createDecorator<IAgentAdaptiveLifecycleService>('agentAdaptiveLifecycleService');

export interface ISessionAdaptiveLifecycleService {
  readonly _serviceBrand: undefined;
}

export const ISessionAdaptiveLifecycleService =
  createDecorator<ISessionAdaptiveLifecycleService>('sessionAdaptiveLifecycleService');
