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
import { firstNonEmptyLine, runProbe } from './sandboxBackend';

export class WindowsWslSandboxBackend implements SandboxBackend {
  constructor(
    private readonly processes: ISessionProcessRunner,
    private readonly probeCwd: string,
  ) {}

  async probe(): Promise<SandboxBackendInfo> {
    const status = await runProbe(this.processes, ['wsl.exe', '--status'], this.probeCwd);
    if (status.exitCode !== 0) {
      return {
        id: 'windows-wsl2',
        available: false,
        reason: 'WSL2 is unavailable.',
        supportedCapabilities: COMMON_SANDBOX_CAPABILITIES,
      };
    }
    const functional = await runProbe(
      this.processes,
      [
        'wsl.exe',
        '--exec',
        'sh',
        '-lc',
        'command -v bwrap >/dev/null && command -v prlimit >/dev/null && exec prlimit --as=134217728 --nproc=32 --cpu=5 -- bwrap --die-with-parent --new-session --unshare-all --ro-bind /usr /usr --proc /proc --dev /dev --tmpfs /tmp -- /usr/bin/true',
      ],
      this.probeCwd,
    );
    return {
      id: 'windows-wsl2',
      available: functional.exitCode === 0,
      version: firstNonEmptyLine(status.stdout, status.stderr),
      reason: functional.exitCode === 0
        ? undefined
        : `The default WSL2 distribution must provide working bwrap and prlimit: ${functional.stderr.trim()}`,
      supportedCapabilities: COMMON_SANDBOX_CAPABILITIES,
    };
  }

  async command(request: SandboxExecutionRequest): Promise<SandboxCommand> {
    validateRequestShape(request);
    const workspace = await this.wslPath(request.workspacePath);
    const mounts = await Promise.all(
      (request.mounts ?? []).map(async (mount) => {
        validateMount(mount);
        return { ...mount, source: await this.wslPath(mount.source) };
      }),
    );
    const script: string[] = [
      'set -eu',
      'set -- bwrap --die-with-parent --new-session --unshare-all --clearenv --proc /proc --dev /dev --tmpfs /tmp --dir /tmp/home',
      request.capabilities.includes('network') ? 'set -- "$@" --share-net' : '',
      'for p in /bin /sbin /usr /usr/local /lib /lib64 /opt /nix/store; do [ ! -e "$p" ] || set -- "$@" --ro-bind "$p" "$p"; done',
      `set -- "$@" ${request.capabilities.includes('workspace-write') ? '--bind' : '--ro-bind'} ${shellQuote(workspace)} /workspace`,
      ...mounts.map((mount) => `set -- "$@" --ro-bind ${shellQuote(mount.source)} ${shellQuote(mount.target)}`),
      ...Object.entries(sandboxEnvironment(request.env)).map(
        ([name, value]) => `set -- "$@" --setenv ${shellQuote(name)} ${shellQuote(value)}`,
      ),
      `set -- "$@" --chdir ${shellQuote(sandboxCwd(request.cwd))} -- ${request.args.map(shellQuote).join(' ')}`,
      `exec prlimit --as=${Math.floor(request.limits.memoryBytes)} --nproc=${Math.floor(request.limits.processCount)} --cpu=${Math.ceil(request.limits.cpuSeconds)} --fsize=${Math.floor(request.limits.writtenBytes)} -- "$@"`,
    ].filter(Boolean);
    return {
      args: ['wsl.exe', '--exec', 'sh', '-lc', script.join('; ')],
      cwd: request.workspacePath,
    };
  }

  private async wslPath(path: string): Promise<string> {
    const result = await runProbe(
      this.processes,
      ['wsl.exe', '--exec', 'wslpath', '-a', '-u', path],
      this.probeCwd,
    );
    if (result.exitCode !== 0 || result.stdout.trim().length === 0) {
      throw new Error(`Unable to translate Windows path for WSL2: ${path}`);
    }
    return result.stdout.trim();
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
