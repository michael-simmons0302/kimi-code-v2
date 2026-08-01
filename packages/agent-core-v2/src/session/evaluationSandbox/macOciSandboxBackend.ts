import type { ISessionProcessRunner } from '#/session/process/processRunner';
import type {
  SandboxBackendInfo,
  SandboxExecutionRequest,
} from './evaluationSandbox';
import {
  COMMON_SANDBOX_CAPABILITIES,
  sandboxCwd,
  sandboxEnvironment,
  validateMount,
  validateRequestShape,
} from './linuxSandboxBackend';
import type { SandboxBackend, SandboxCommand } from './sandboxBackend';
import { runProbe } from './sandboxBackend';

export class MacOciSandboxBackend implements SandboxBackend {
  private runtime: 'docker' | 'podman' | undefined;

  constructor(
    private readonly processes: ISessionProcessRunner,
    private readonly probeCwd: string,
    private readonly image: string,
  ) {}

  async probe(): Promise<SandboxBackendInfo> {
    for (const runtime of ['docker', 'podman'] as const) {
      const version = await runProbe(
        this.processes,
        [runtime, 'version', '--format', '{{.Server.Version}}'],
        this.probeCwd,
      );
      if (version.exitCode !== 0) continue;
      const image = await runProbe(
        this.processes,
        [runtime, 'image', 'inspect', this.image],
        this.probeCwd,
      );
      if (image.exitCode !== 0) {
        return {
          id: 'macos-oci',
          available: false,
          version: version.stdout.trim(),
          reason: `OCI image ${this.image} is not present locally. Evolve mode does not pull images implicitly.`,
          supportedCapabilities: COMMON_SANDBOX_CAPABILITIES,
        };
      }
      const functional = await runProbe(
        this.processes,
        [
          runtime,
          'run',
          '--rm',
          '--network',
          'none',
          '--read-only',
          '--tmpfs',
          '/tmp:rw,nosuid,nodev,noexec,size=64m',
          this.image,
          '/bin/sh',
          '-lc',
          'true',
        ],
        this.probeCwd,
      );
      if (functional.exitCode !== 0) {
        return {
          id: 'macos-oci',
          available: false,
          version: version.stdout.trim(),
          reason: `OCI runtime cannot start the configured evaluation image: ${functional.stderr.trim()}`,
          supportedCapabilities: COMMON_SANDBOX_CAPABILITIES,
        };
      }
      this.runtime = runtime;
      return {
        id: 'macos-oci',
        available: true,
        version: version.stdout.trim(),
        supportedCapabilities: COMMON_SANDBOX_CAPABILITIES,
      };
    }
    return {
      id: 'macos-oci',
      available: false,
      reason: 'Neither Docker nor Podman is available.',
      supportedCapabilities: COMMON_SANDBOX_CAPABILITIES,
    };
  }

  async command(request: SandboxExecutionRequest): Promise<SandboxCommand> {
    validateRequestShape(request);
    const runtime = this.runtime;
    if (runtime === undefined) throw new Error('OCI sandbox backend has not been probed successfully.');
    const workspaceMount = [
      'type=bind',
      `src=${request.workspacePath}`,
      'dst=/workspace',
      request.capabilities.includes('workspace-write') ? '' : 'readonly',
    ].filter(Boolean).join(',');
    const args: string[] = [
      runtime,
      'run',
      '--rm',
      '--init',
      '--read-only',
      '--memory',
      String(Math.floor(request.limits.memoryBytes)),
      '--pids-limit',
      String(Math.floor(request.limits.processCount)),
      '--ulimit',
      `cpu=${Math.ceil(request.limits.cpuSeconds)}:${Math.ceil(request.limits.cpuSeconds)}`,
      '--ulimit',
      `fsize=${Math.max(1, Math.floor(request.limits.writtenBytes / 512))}`,
      '--tmpfs',
      '/tmp:rw,nosuid,nodev,noexec,size=512m',
      '--mount',
      workspaceMount,
      '--workdir',
      sandboxCwd(request.cwd),
    ];
    if (!request.capabilities.includes('network')) args.push('--network', 'none');
    for (const mount of request.mounts ?? []) {
      validateMount(mount);
      args.push(
        '--mount',
        `type=bind,src=${mount.source},dst=${mount.target},readonly`,
      );
    }
    for (const [name, value] of Object.entries(sandboxEnvironment(request.env))) {
      args.push('--env', `${name}=${value}`);
    }
    args.push(this.image, ...request.args);
    return { args, cwd: request.workspacePath };
  }
}
