/**
 * `agentLifecycle` domain — `IAgentLifecycleService` implementation.
 */

import { IInstantiationService } from '#/_base/di/instantiation';
import { Disposable, type IDisposable } from '#/_base/di/lifecycle';
import { Emitter } from '#/_base/event';
import { join } from 'pathe';
import {
  createScopedChildHandle,
  type IAgentScopeHandle,
  LifecycleScope,
  ScopeActivation,
  registerScopedService,
} from '#/_base/di/scope';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IEventBus } from '#/app/event/eventBus';
import { DEFAULT_PERMISSION_MODE_SECTION } from '#/agent/permissionMode/configSection';
import { PermissionModeConfiguredModel } from '#/agent/permissionMode/permissionModeOps';
import type { PermissionMode } from '#/agent/permissionPolicy/types';
import { IAgentTaskService } from '#/agent/task/task';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionMcpHandle } from '#/session/mcp/sessionMcpHandle';
import { IAgentScopeContext, makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentProfileService } from '#/agent/profile/profile';
import { abortError } from '#/_base/utils/abort';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import { IAgentToolActivationService } from '#/agent/toolActivation/toolActivation';
import { ISessionInteractionService } from '#/session/interaction/interaction';
import { IWireService } from '#/wire/wire';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import {
  type AgentListFilter,
  type AgentPersistence,
  type CreateAgentOptions,
  type ForkAgentOptions,
  IAgentLifecycleService,
} from './agentLifecycle';

let nextAgentId = 0;

export class AgentLifecycleService extends Disposable implements IAgentLifecycleService {
  declare readonly _serviceBrand: undefined;
  private readonly handles = new Map<string, IAgentScopeHandle>();
  private readonly persistenceById = new Map<string, AgentPersistence>();
  private readonly scopeById = new Map<string, string>();
  private readonly onDidCreateEmitter = this._register(new Emitter<IAgentScopeHandle>());
  private readonly onDidDisposeEmitter = this._register(new Emitter<string>());
  private readonly interactionBusDisposables = new Map<string, IDisposable>();
  private readonly creating = new Map<string, Promise<IAgentScopeHandle>>();

  get onDidCreate() {
    return this.onDidCreateEmitter.event;
  }
  get onDidDispose() {
    return this.onDidDisposeEmitter.event;
  }

  constructor(
    @IInstantiationService private readonly instantiation: IInstantiationService,
    @ISessionContext private readonly ctx: ISessionContext,
    @ISessionMetadata private readonly sessionMetadata: ISessionMetadata,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IConfigService private readonly config: IConfigService,
    @ISessionMcpHandle private readonly mcpHandle: ISessionMcpHandle,
    @ISessionInteractionService private readonly interaction: ISessionInteractionService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IHostFileSystem private readonly hostFs: IHostFileSystem,
  ) {
    super();
    this._register(this.onDidCreate((handle) => this.subscribeInteractionBus(handle)));
    this._register(
      this.onDidDispose((agentId) => {
        const disposable = this.interactionBusDisposables.get(agentId);
        if (disposable !== undefined) {
          disposable.dispose();
          this.interactionBusDisposables.delete(agentId);
        }
      }),
    );
    this._register({
      dispose: () => {
        for (const disposable of this.interactionBusDisposables.values()) {
          disposable.dispose();
        }
        this.interactionBusDisposables.clear();
        for (const [agentId, persistence] of this.persistenceById) {
          if (persistence !== 'ephemeral') continue;
          const scope = this.scopeById.get(agentId);
          if (scope !== undefined) void this.removeScope(scope);
        }
      },
    });
  }

  private subscribeInteractionBus(handle: IAgentScopeHandle): void {
    if (this.interactionBusDisposables.has(handle.id)) return;
    const disposable = handle.accessor
      .get(IEventBus)
      .subscribe('turn.ended', (event) => this.interaction.cancelPendingForTurn(event.turnId));
    this.interactionBusDisposables.set(handle.id, disposable);
  }

  async create(opts: CreateAgentOptions = {}): Promise<IAgentScopeHandle> {
    const persistence = opts.persistence ?? 'durable';
    if (opts.agentId === 'main' && persistence === 'ephemeral') {
      throw new Error('The main agent cannot use ephemeral persistence.');
    }
    if (opts.agentId !== undefined) {
      const inflight = this.creating.get(opts.agentId);
      if (inflight !== undefined) return inflight;
      const existing = this.handles.get(opts.agentId);
      if (existing !== undefined) {
        const existingPersistence = this.persistenceById.get(opts.agentId);
        if (existingPersistence !== persistence) {
          throw new Error(
            `Agent ${opts.agentId} already exists with ${String(existingPersistence)} persistence.`,
          );
        }
        return existing;
      }
    }
    const agentId = opts.agentId ?? (await this.nextAvailableAgentId());
    const promise = this.doCreate(agentId, { ...opts, persistence });
    this.creating.set(agentId, promise);
    try {
      return await promise;
    } finally {
      this.creating.delete(agentId);
    }
  }

  private async nextAvailableAgentId(): Promise<string> {
    let maxSuffix = -1;
    const consider = (id: string): void => {
      const match = /^agent-(\d+)$/.exec(id);
      if (match !== null) maxSuffix = Math.max(maxSuffix, Number(match[1]));
    };
    for (const id of this.handles.keys()) consider(id);
    const persisted = (await this.sessionMetadata.read()).agents ?? {};
    for (const id of Object.keys(persisted)) consider(id);
    const candidate = Math.max(maxSuffix + 1, nextAgentId);
    nextAgentId = candidate + 1;
    return `agent-${String(candidate)}`;
  }

  private async doCreate(
    agentId: string,
    opts: CreateAgentOptions & { readonly persistence: AgentPersistence },
  ): Promise<IAgentScopeHandle> {
    const mcpReady = this.mcpHandle.ready;
    const agentScope = opts.persistence === 'durable'
      ? this.ctx.scope(`agents/${agentId}`)
      : this.ctx.scope(`adaptive/ephemeral-agents/${agentId}`);
    const agentHomedir = join(this.bootstrap.homeDir, agentScope);
    const labels = opts.persistence === 'ephemeral'
      ? { ...opts.labels, 'adaptive.persistence': 'ephemeral' }
      : opts.labels;
    const handle = createScopedChildHandle(
      this.instantiation,
      LifecycleScope.Agent,
      agentId,
      {
        extra: [
          [IAgentScopeContext, makeAgentScopeContext({ agentId, agentScope })],
          [ITelemetryService, this.telemetry.withContext({
            agent_id: agentId,
            agent_persistence: opts.persistence,
          })],
        ],
      },
    ) as IAgentScopeHandle;
    this.handles.set(agentId, handle);
    this.persistenceById.set(agentId, opts.persistence);
    this.scopeById.set(agentId, agentScope);
    try {
      const wire = handle.accessor.get(IWireService);
      await wire.seal();
      if (opts.persistence === 'durable') {
        await this.sessionMetadata.registerAgent(agentId, {
          homedir: agentHomedir,
          type: agentId === 'main' ? 'main' : 'sub',
          parentAgentId: agentId === 'main' ? undefined : 'main',
          forkedFrom: opts.forkedFrom,
          labels,
        });
      }
      this.onDidCreateEmitter.fire(handle);
      await mcpReady;
      if (opts.persistence === 'durable') await wire.restore();
      await this.bindBootstrap(handle, opts);
      await handle.accessor.get(IAgentToolActivationService).activate();
      return handle;
    } catch (error) {
      if (this.handles.get(agentId) === handle) this.handles.delete(agentId);
      this.persistenceById.delete(agentId);
      this.scopeById.delete(agentId);
      try {
        handle.dispose();
      } catch {}
      this.onDidDisposeEmitter.fire(agentId);
      if (opts.persistence === 'ephemeral') await this.removeScope(agentScope);
      throw error;
    }
  }

  private async bindBootstrap(
    handle: IAgentScopeHandle,
    opts: CreateAgentOptions,
  ): Promise<void> {
    if (opts.binding !== undefined) {
      await handle.accessor.get(IAgentProfileService).bind(opts.binding);
    }
    const wire = handle.accessor.get(IWireService);
    const permissionMode = this.config.get<PermissionMode>(DEFAULT_PERMISSION_MODE_SECTION);
    const hasRestoredPermissionMode = wire.getModel(PermissionModeConfiguredModel);
    if (permissionMode !== undefined && !hasRestoredPermissionMode) {
      handle.accessor.get(IAgentPermissionModeService).setMode(permissionMode);
    }
  }

  async fork(sourceAgentId: string, opts: ForkAgentOptions = {}): Promise<IAgentScopeHandle> {
    const source = this.handles.get(sourceAgentId);
    if (source === undefined) throw new Error(`Agent not found: ${sourceAgentId}`);
    const profile = source.accessor.get(IAgentProfileService).bound();
    if (profile === undefined) throw new Error(`Agent profile is not bound: ${sourceAgentId}`);
    const agentId = opts.agentId ?? (await this.nextAvailableAgentId());
    const binding = {
      ...profile,
      ...opts.binding,
      id: opts.binding?.id ?? profile.id,
    };
    const handle = await this.create({
      agentId,
      binding,
      forkedFrom: sourceAgentId,
      persistence: opts.persistence ?? 'durable',
    });
    const sourceContext = source.accessor.get(IAgentContextMemoryService).get();
    handle.accessor.get(IAgentContextMemoryService).append(...sourceContext);
    return handle;
  }

  get(agentId: string): IAgentScopeHandle | undefined {
    return this.handles.get(agentId);
  }

  list(filter: AgentListFilter = {}): readonly IAgentScopeHandle[] {
    return [...this.handles.values()].filter((handle) => {
      if (filter.prefix !== undefined && !handle.id.startsWith(filter.prefix)) return false;
      if (
        filter.persistence !== undefined &&
        this.persistenceById.get(handle.id) !== filter.persistence
      ) {
        return false;
      }
      return true;
    });
  }

  persistence(agentId: string): AgentPersistence | undefined {
    return this.persistenceById.get(agentId);
  }

  broadcastPermissionMode(mode: PermissionMode): void {
    for (const handle of this.handles.values()) {
      handle.accessor.get(IAgentPermissionModeService).setMode(mode);
    }
  }

  async remove(agentId: string): Promise<void> {
    const handle = this.handles.get(agentId);
    if (handle === undefined) return;
    const persistence = this.persistenceById.get(agentId) ?? 'durable';
    const scope = this.scopeById.get(agentId);
    const currentHandle = handle;
    try {
      const agentTask = currentHandle.accessor.get(IAgentTaskService);
      await agentTask.exitGracefully({ timeoutMs: 5_000, reason: 'agent removed' });
      currentHandle.accessor.get(IAgentLoopService).cancel(undefined, 'agent removed');
      await currentHandle.accessor.get(IAgentLoopService).settled();
      if (persistence === 'durable') {
        await currentHandle.accessor.get(IAgentFullCompactionService).compactFull();
      }
    } catch (error) {
      if (!abortError.is(error)) throw error;
    } finally {
      if (this.handles.get(agentId) === currentHandle) {
        this.handles.delete(agentId);
        this.persistenceById.delete(agentId);
        this.scopeById.delete(agentId);
        try {
          currentHandle.dispose();
        } finally {
          if (persistence === 'durable') {
            await this.sessionMetadata.removeAgent(agentId);
          } else if (scope !== undefined) {
            await this.removeScope(scope);
          }
          this.onDidDisposeEmitter.fire(agentId);
        }
      }
    }
  }

  private async removeScope(scope: string): Promise<void> {
    try {
      await this.hostFs.remove(join(this.bootstrap.homeDir, scope));
    } catch {
      // Ephemeral cleanup is best-effort after the scope has been disposed. The
      // private scope remains unreachable from session metadata even if the OS
      // retains a transient file handle.
    }
  }
}

registerScopedService(
  LifecycleScope.Session,
  IAgentLifecycleService,
  AgentLifecycleService,
  ScopeActivation.OnScopeCreated,
  'agentLifecycle',
);
