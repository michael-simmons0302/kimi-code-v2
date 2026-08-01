import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { ISessionProcessRunner } from '#/session/process/processRunner';
import {
  ISessionEvaluationSandbox,
  type SandboxBackendInfo,
  type SandboxExecutionRequest,
  type SandboxExecutionResult,
} from './evaluationSandbox';
import { LinuxSandboxBackend } from './linuxSandboxBackend';
import { MacOciSandboxBackend } from './macOciSandboxBackend';
import type { SandboxBackend } from './sandboxBackend';
import { runSandboxCommand } from './sandboxBackend';
import { WindowsWslSandboxBackend } from './windowsWslSandboxBackend';

export class SessionEvaluationSandboxService
  extends Disposable
  implements ISessionEvaluationSandbox
{
  declare readonly _serviceBrand: undefined;

  private readonly implementation: SandboxBackend;
  private readonly readyPromise: Promise<void>;
  private backendInfo: SandboxBackendInfo;

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @ISessionProcessRunner private readonly processes: ISessionProcessRunner,
  ) {
    super();
    this.implementation = createBackend(bootstrap, processes);
    this.backendInfo = unavailableInfo(bootstrap.platform, 'Sandbox backend has not been probed.');
    this.readyPromise = this.implementation.probe().then((info) => {
      this.backendInfo = info;
      if (bootstrap.args.adaptiveMode === 'enabled' && !info.available) {
        throw new Error(
          `Evolve mode requires a secure evaluation sandbox: ${info.reason ?? 'backend unavailable'}`,
        );
      }
    });
  }

  ready(): Promise<void> {
    return this.readyPromise;
  }

  backend(): SandboxBackendInfo {
    return this.backendInfo;
  }

  async execute(request: SandboxExecutionRequest): Promise<SandboxExecutionResult> {
    await this.readyPromise;
    if (!this.backendInfo.available) {
      throw new Error(this.backendInfo.reason ?? 'Secure evaluation sandbox is unavailable.');
    }
    const supported = new Set(this.backendInfo.supportedCapabilities);
    for (const capability of request.capabilities) {
      if (!supported.has(capability)) {
        throw new Error(
          `Sandbox backend ${this.backendInfo.id} does not support capability ${capability}.`,
        );
      }
    }
    const command = await this.implementation.command(request);
    return runSandboxCommand(
      this.processes,
      command,
      request,
      this.backendInfo.id,
    );
  }
}

function createBackend(
  bootstrap: IBootstrapService,
  processes: ISessionProcessRunner,
): SandboxBackend {
  switch (bootstrap.platform) {
    case 'linux':
      return new LinuxSandboxBackend(processes, bootstrap.cwd);
    case 'win32':
      return new WindowsWslSandboxBackend(processes, bootstrap.cwd);
    case 'darwin':
      return new MacOciSandboxBackend(
        processes,
        bootstrap.cwd,
        bootstrap.getEnv('KIMI_CODE_EVALUATION_IMAGE') ?? 'node:24-bookworm-slim',
      );
    default:
      return {
        probe: async () => unavailableInfo(
          bootstrap.platform,
          `Unsupported sandbox platform: ${bootstrap.platform}`,
        ),
        command: async () => {
          throw new Error(`Unsupported sandbox platform: ${bootstrap.platform}`);
        },
      };
  }
}

function unavailableInfo(
  platform: NodeJS.Platform,
  reason: string,
): SandboxBackendInfo {
  return {
    id: platform === 'win32'
      ? 'windows-wsl2'
      : platform === 'darwin'
        ? 'macos-oci'
        : 'linux-bwrap',
    available: false,
    reason,
    supportedCapabilities: [],
  };
}

registerScopedService(
  LifecycleScope.Session,
  ISessionEvaluationSandbox,
  SessionEvaluationSandboxService,
  ScopeActivation.OnScopeCreated,
  'evaluationSandbox',
);
