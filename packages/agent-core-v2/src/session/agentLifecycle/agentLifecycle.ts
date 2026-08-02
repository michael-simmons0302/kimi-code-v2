/**
 * `agentLifecycle` domain — flat registry of the session's agents.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import type { Event } from '#/_base/event';
import type { PermissionMode } from '#/agent/permissionPolicy/types';
import type { BindAgentInput } from '#/agent/profile/profile';

export const MAIN_AGENT_ID = 'main';

export type AgentPersistence = 'durable' | 'ephemeral';

export interface CreateAgentOptions {
  readonly agentId?: string;
  readonly binding?: BindAgentInput;
  readonly forkedFrom?: string;
  readonly labels?: Readonly<Record<string, string>>;
  readonly persistence?: AgentPersistence;
}

export interface ForkAgentOptions {
  readonly agentId?: string;
  readonly binding?: Partial<BindAgentInput>;
  readonly persistence?: AgentPersistence;
}

export interface AgentListFilter {
  readonly prefix?: string;
  readonly persistence?: AgentPersistence;
}

export interface IAgentLifecycleService {
  readonly _serviceBrand: undefined;

  readonly onDidCreate: Event<IAgentScopeHandle>;
  readonly onDidDispose: Event<string>;

  create(opts?: CreateAgentOptions): Promise<IAgentScopeHandle>;

  fork(sourceAgentId: string, opts?: ForkAgentOptions): Promise<IAgentScopeHandle>;

  get(agentId: string): IAgentScopeHandle | undefined;
  list(filter?: AgentListFilter): readonly IAgentScopeHandle[];
  persistence(agentId: string): AgentPersistence | undefined;
  broadcastPermissionMode(mode: PermissionMode): void;
  remove(agentId: string): Promise<void>;
}

export const IAgentLifecycleService: ServiceIdentifier<IAgentLifecycleService> =
  createDecorator<IAgentLifecycleService>('agentLifecycleService');
