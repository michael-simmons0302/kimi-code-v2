import { lstat, readdir } from 'node:fs/promises';

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { ISessionProcessRunner, type SessionProcess } from '#/session/process/processRunner';
import { dirname, isAbsolute, join, normalize, relative } from 'pathe';
import {
  ISessionEvaluationSandbox,
  type SandboxBackendInfo,
  type SandboxCapability,
  type SandboxExecutionRequest,
  type SandboxExecutionResult,
  type SandboxMount,
} from './evaluationSandbox';

const BASE_ENVIRONMENT: Readonly<Record<string, string>> = Object.freeze({
  PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  HOME: '/tmp/home',
  TMPDIR: '/tmp',
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
  CI: '1',
  NO_COLOR: '1',
  TERM: 'dumb',
});

const LINUX_TOOLCHAIN_PATHS = [
  '/bin',
  '/sbin',
  '/usr',
  '/usr/local',
  '/lib',
  '/lib64',
  '/opt',
  '/nix/store',
] as const;

const COMMON_CAPABILITIES: readonly SandboxCapability[] = [
  'workspace-read',
  'workspace-write',
  'temporary-write',
  'package-cache-read',
  'process-spawn',
  'additional-read-mount',
  'network',
];

interface CapturedProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly outputBytes: number;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly durationMs: number;
}

export class SessionEvaluationSandboxService
  extends Disposable
  implements ISessionEvaluationSandbox
{
  declare readonly _serviceBrand: undefined;

  private readonly readyPromise: Promise<void>;
  private backendInfo: SandboxBackendInfo = {
    id: backendIdFor(process.platform),
    available: false,
    reason: 'Sandbox backend has not been probed.',
    supportedCapabilities: COMMON_CAPABILITIES,
  };
  private ociRuntime: 'docker' | 'podman' | undefined;
  private ociImage: string;

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @ISessionProcessRunner private readonly processes: ISessionProcessRunner,
  ) {
    super();
    this.ociImage = bootstrap.getEnv('KIMI_CODE_EVALUATION_IMAGE') ?? 'node:24-bookworm-slim';
    this.readyPromise = this.probe().then(() => {
      if (bootstrap.args.adaptiveMode === 'enabled' && !this.backendInfo.available) {
        throw new Error(
          `Evolve mode requires a secure evaluation sandbox: ${this.backendInfo.reason ?? 'backend unavailable'}`,
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
    validateRequest(request, this.backendInfo);
    const startedAt = Date.now();
    const command = await this.commandFor(request);
    const result = await this.runBounded(command.args, command.cwd, request);
    const writtenBytes = await directorySize(request.workspacePath, request.signal);
    if (writtenBytes > request.limits.writtenBytes) {
      throw new Error(
        `Sandbox workspace exceeds written-byte limit: ${writtenBytes} > ${request.limits.writtenBytes}`,
      );
    }
    return {
      backend: this.backendInfo.id,
      ...result,
      durationMs: Math.max(result.durationMs, Date.now() - startedAt),
    };
  }

  private async probe(): Promise<void> {
    switch (this.bootstrap.platform) {
      case 'linux':
        await this.probeLinux();
        return;
      case 'win32':
        await this.probeWindows();
        return;
      case 'darwin':
        await this.probeMacos();
        return;
      default:
        this.backendInfo = {
          id: backendIdFor(this.bootstrap.platform),
          available: false,
          reason: `Unsupported sandbox platform: ${this.bootstrap.platform}`,
          supportedCapabilities: COMMON_CAPABILITIES,
        };
    }
  }

  private async probeLinux(): Promise<void> {
    const bwrap = await this.runProbe(['bwrap', '--version']);
    const prlimit = await this.runProbe(['prlimit', '--version']);
    this.backendInfo = {
      id: 'linux-bwrap',
      available: bwrap.exitCode === 0 && prlimit.exitCode === 0,
      version: bwrap.exitCode === 0 ? bwrap.stdout.trim() : undefined,
      reason:
        bwrap.exitCode !== 0
          ? 'bubblewrap (bwrap) is not installed or executable.'
          : prlimit.exitCode !== 0
            ? 'prlimit is not installed or executable.'
            : undefined,
      supportedCapabilities: COMMON_CAPABILITIES,
    };
  }

  private async probeWindows(): Promise<void> {
    const status = await this.runProbe(['wsl.exe', '--status']);
    const tools = status.exitCode === 0
      ? await this.runProbe([
          'wsl.exe',
          '--exec',
          'sh',
          '-lc',
          'command -v bwrap >/dev/null && command -v prlimit >/dev/null',
        ])
      : { exitCode: 1, stdout: '', stderr: '' };
    this.backendInfo = {
      id: 'windows-wsl2',
      available: status.exitCode === 0 && tools.exitCode === 0,
      version: status.exitCode === 0 ? firstNonEmptyLine(status.stdout, status.stderr) : undefined,
      reason:
        status.exitCode !== 0
          ? 'WSL2 is unavailable.'
          : tools.exitCode !== 0
            ? 'The default WSL2 distribution must provide bwrap and prlimit.'
            : undefined,
      supportedCapabilities: COMMON_CAPABILITIES,
    };
  }

  private async probeMacos(): Promise<void> {
    for (const runtime of ['docker', 'podman'] as const) {
      const version = await this.runProbe([runtime, 'version', '--format', '{{.Server.Version}}']);
      if (version.exitCode !== 0) continue;
      const image = await this.runProbe([runtime, 'image', 'inspect', this.ociImage]);
      if (image.exitCode !== 0) {
        this.backendInfo = {
          id: 'macos-oci',
          available: false,
          version: version.stdout.trim(),
          reason: `OCI image ${this.ociImage} is not present locally. Evolve mode does not pull images implicitly.`,
          supportedCapabilities: COMMON_CAPABILITIES,
        };
        return;
      }
      this.ociRuntime = runtime;
      this.backendInfo = {
        id: 'macos-oci',
        available: true,
        version: version.stdout.trim(),
        supportedCapabilities: COMMON_CAPABILITIES,
      };
      return;
    }
    this.backendInfo = {
      id: 'macos-oci',
      available: false,
      reason: 'Neither Docker nor Podman is available.',
      supportedCapabilities: COMMON_CAPABILITIES,
    };
  }

  private commandFor(
    request: SandboxExecutionRequest,
  ): Promise<{ readonly args: readonly string[]; readonly cwd: string }> {
    switch (this.backendInfo.id) {
      case 'linux-bwrap':
        return this.linuxCommand(request, request.workspacePath, request.mounts ?? []);
      case 'windows-wsl2':
        return this.windowsCommand(request);
      case 'macos-oci':
        return Promise.resolve(this.macosCommand(request));
    }
  }

  private async linuxCommand(
    request: SandboxExecutionRequest,
    workspacePath: string,
    mounts: readonly SandboxMount[],
  ): Promise<{ readonly args: readonly string[]; readonly cwd: string }> {
    const sandboxArgs: string[] = [
      'bwrap',
      '--die-with-parent',
      '--new-session',
      '--unshare-all',
      '--clearenv',
      '--proc',
      '/proc',
      '--dev',
      '/dev',
      '--tmpfs',
      '/tmp',
      '--dir',
      '/tmp/home',
    ];
    if (request.capabilities.includes('network')) sandboxArgs.push('--share-net');
    for (const path of LINUX_TOOLCHAIN_PATHS) {
      if (await pathExists(path)) sandboxArgs.push('--ro-bind', path, path);
    }
    const writable = request.capabilities.includes('workspace-write');
    sandboxArgs.push(writable ? '--bind' : '--ro-bind', workspacePath, '/workspace');
    for (const mount of mounts) {
      validateMount(mount);
      sandboxArgs.push(mount.writable ? '--bind' : '--ro-bind', mount.source, mount.target);
    }
    for (const [name, value] of Object.entries(sandboxEnvironment(request.env))) {
      sandboxArgs.push('--setenv', name, value);
    }
    sandboxArgs.push('--chdir', sandboxCwd(request.cwd), '--', ...request.args);
    const limited = prlimitPrefix(request).concat(sandboxArgs);
    return { args: limited, cwd: request.workspacePath };
  }

  private async windowsCommand(
    request: SandboxExecutionRequest,
  ): Promise<{ readonly args: readonly string[]; readonly cwd: string }> {
    const workspace = await this.wslPath(request.workspacePath);
    const mounts = await Promise.all(
      (request.mounts ?? []).map(async (mount) => ({
        ...mount,
        source: await this.wslPath(mount.source),
      })),
    );
    const linux = await this.linuxCommand(request, workspace, mounts);
    return { args: ['wsl.exe', '--exec', ...linux.args], cwd: request.workspacePath };
  }

  private macosCommand(
    request: SandboxExecutionRequest,
  ): { readonly args: readonly string[]; readonly cwd: string } {
    const runtime = this.ociRuntime;
    if (runtime === undefined) throw new Error('OCI runtime was not resolved.');
    const writable = request.capabilities.includes('workspace-write');
    const args: string[] = [
      runtime,
      'run',
      '--rm',
      '--init',
      '--read-only',
      '--memory',
      String(request.limits.memoryBytes),
      '--pids-limit',
      String(request.limits.processCount),
      '--ulimit',
      `cpu=${request.limits.cpuSeconds}:${request.limits.cpuSeconds}`,
      '--ulimit',
      `fsize=${Math.max(1, Math.floor(request.limits.writtenBytes / 512))}`,
      '--tmpfs',
      '/tmp:rw,nosuid,nodev,noexec,size=512m',
      '--mount',
      `type=bind,src=${request.workspacePath},dst=/workspace,readonly=${String(!writable)}`,
      '--workdir',
      sandboxCwd(request.cwd),
    ];
    if (!request.capabilities.includes('network')) args.push('--network', 'none');
    for (const mount of request.mounts ?? []) {
      validateMount(mount);
      args.push(
        '--mount',
        `type=bind,src=${mount.source},dst=${mount.target},readonly=${String(!mount.writable)}`,
      );
    }
    for (const [name, value] of Object.entries(sandboxEnvironment(request.env))) {
      args.push('--env', `${name}=${value}`);
    }
    args.push(this.ociImage, ...request.args);
    return { args, cwd: request.workspacePath };
  }

  private async wslPath(path: string): Promise<string> {
    const result = await this.runProbe(['wsl.exe', '--exec', 'wslpath', '-a', '-u', path]);
    if (result.exitCode !== 0 || result.stdout.trim().length === 0) {
      throw new Error(`Unable to translate Windows path for WSL2: ${path}`);
    }
    return result.stdout.trim();
  }

  private async runBounded(
    args: readonly string[],
    cwd: string,
    request: SandboxExecutionRequest,
  ): Promise<CapturedProcessResult> {
    request.signal?.throwIfAborted();
    const startedAt = Date.now();
    const process = await this.processes.exec(args, { cwd, env: {} });
    const wallSignal = AbortSignal.timeout(request.limits.wallMs);
    const combined = request.signal === undefined
      ? wallSignal
      : AbortSignal.any([request.signal, wallSignal]);
    let outputLimitExceeded = false;
    const sharedOutput = { bytes: 0 };
    const kill = (): void => {
      void process.kill().catch(() => undefined);
    };
    combined.addEventListener('abort', kill, { once: true });
    const workspaceMonitor = monitorWrittenBytes(
      request.workspacePath,
      request.limits.writtenBytes,
      combined,
      kill,
    );
    try {
      const stdoutPromise = collectBounded(
        process.stdout,
        request.limits.outputBytes,
        sharedOutput,
        () => {
          outputLimitExceeded = true;
          kill();
        },
      );
      const stderrPromise = collectBounded(
        process.stderr,
        request.limits.outputBytes,
        sharedOutput,
        () => {
          outputLimitExceeded = true;
          kill();
        },
      );
      const exitCode = await process.wait();
      const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
      if (outputLimitExceeded) {
        throw new Error(`Sandbox output exceeded ${request.limits.outputBytes} bytes.`);
      }
      return {
        exitCode,
        stdout: stdout.text,
        stderr: stderr.text,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        outputBytes: sharedOutput.bytes,
        timedOut: wallSignal.aborted && request.signal?.aborted !== true,
        cancelled: request.signal?.aborted === true,
        durationMs: Date.now() - startedAt,
      };
    } finally {
      combined.removeEventListener('abort', kill);
      await workspaceMonitor;
      await process.dispose();
    }
  }

  private async runProbe(
    args: readonly string[],
  ): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
    let process: SessionProcess | undefined;
    try {
      process = await this.processes.exec(args, { cwd: this.bootstrap.cwd });
      const stdoutPromise = collectProbe(process.stdout);
      const stderrPromise = collectProbe(process.stderr);
      const exitCode = await process.wait();
      const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
      return { exitCode, stdout, stderr };
    } catch (error) {
      return { exitCode: 127, stdout: '', stderr: error instanceof Error ? error.message : String(error) };
    } finally {
      await process?.dispose();
    }
  }
}

function validateRequest(
  request: SandboxExecutionRequest,
  backend: SandboxBackendInfo,
): void {
  if (request.args.length === 0) throw new Error('Sandbox command cannot be empty.');
  if (!isAbsolute(request.workspacePath)) {
    throw new Error('Sandbox workspacePath must be absolute.');
  }
  if (!request.capabilities.includes('workspace-read')) {
    throw new Error('Sandbox execution requires workspace-read capability.');
  }
  const supported = new Set(backend.supportedCapabilities);
  for (const capability of request.capabilities) {
    if (!supported.has(capability)) {
      throw new Error(`Sandbox backend ${backend.id} does not support ${capability}.`);
    }
  }
  if (request.capabilities.includes('gpu')) {
    throw new Error(`Sandbox backend ${backend.id} does not expose GPU devices.`);
  }
  const limits = request.limits;
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`Sandbox limit ${name} must be a positive finite number.`);
    }
  }
  const cwd = request.cwd ?? '.';
  if (isAbsolute(cwd) || normalize(cwd) === '..' || normalize(cwd).startsWith('../')) {
    throw new Error('Sandbox cwd must remain inside the candidate workspace.');
  }
}

function validateMount(mount: SandboxMount): void {
  if (!isAbsolute(mount.source)) throw new Error(`Sandbox mount source must be absolute: ${mount.source}`);
  if (!isAbsolute(mount.target) || !normalize(mount.target).startsWith('/mnt/')) {
    throw new Error(`Additional sandbox mounts must target /mnt/: ${mount.target}`);
  }
  if (mount.writable) {
    throw new Error('Additional mounts are read-only in the first secure sandbox protocol.');
  }
}

function sandboxEnvironment(
  additions: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> {
  const environment: Record<string, string> = { ...BASE_ENVIRONMENT };
  for (const [name, value] of Object.entries(additions ?? {})) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
      throw new Error(`Sandbox environment variable is not allowlisted: ${name}`);
    }
    if (/TOKEN|SECRET|PASSWORD|CREDENTIAL|COOKIE|AUTH|KEY/i.test(name)) {
      throw new Error(`Sensitive sandbox environment variable is forbidden: ${name}`);
    }
    environment[name] = value;
  }
  return environment;
}

function sandboxCwd(cwd: string | undefined): string {
  const normalizedCwd = normalize(cwd ?? '.');
  return normalizedCwd === '.' ? '/workspace' : join('/workspace', normalizedCwd);
}

function prlimitPrefix(request: SandboxExecutionRequest): string[] {
  return [
    'prlimit',
    `--as=${Math.floor(request.limits.memoryBytes)}`,
    `--nproc=${Math.floor(request.limits.processCount)}`,
    `--cpu=${Math.ceil(request.limits.cpuSeconds)}`,
    `--fsize=${Math.floor(request.limits.writtenBytes)}`,
    '--',
  ];
}

async function collectProbe(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = 256 * 1024 - bytes;
    if (remaining <= 0) continue;
    chunks.push(buffer.subarray(0, remaining));
    bytes += Math.min(buffer.byteLength, remaining);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function collectBounded(
  stream: NodeJS.ReadableStream,
  maximumBytes: number,
  shared: { bytes: number },
  onLimit: () => void,
): Promise<{ readonly text: string; readonly truncated: boolean }> {
  const chunks: Buffer[] = [];
  let retained = 0;
  let truncated = false;
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    shared.bytes += buffer.byteLength;
    if (shared.bytes > maximumBytes) onLimit();
    const remaining = maximumBytes - retained;
    if (remaining <= 0) {
      truncated = true;
      continue;
    }
    const selected = buffer.subarray(0, Math.min(buffer.byteLength, remaining));
    chunks.push(selected);
    retained += selected.byteLength;
    if (selected.byteLength < buffer.byteLength) truncated = true;
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated };
}

async function monitorWrittenBytes(
  root: string,
  maximumBytes: number,
  signal: AbortSignal,
  onLimit: () => void,
): Promise<void> {
  while (!signal.aborted) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (signal.aborted) break;
    if (await directorySize(root, signal) > maximumBytes) {
      onLimit();
      return;
    }
  }
}

async function directorySize(root: string, signal?: AbortSignal): Promise<number> {
  let total = 0;
  const visit = async (directory: string): Promise<void> => {
    signal?.throwIfAborted();
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '.git' && entry.name !== 'node_modules') await visit(path);
      } else if (entry.isFile()) {
        total += (await lstat(path)).size;
      }
    }
  };
  await visit(root);
  return total;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

function firstNonEmptyLine(...values: readonly string[]): string | undefined {
  for (const value of values) {
    const line = value.split(/\r?\n/).map((part) => part.trim()).find(Boolean);
    if (line !== undefined) return line;
  }
  return undefined;
}

function backendIdFor(
  platform: NodeJS.Platform,
): SandboxBackendInfo['id'] {
  return platform === 'win32'
    ? 'windows-wsl2'
    : platform === 'darwin'
      ? 'macos-oci'
      : 'linux-bwrap';
}

registerScopedService(
  LifecycleScope.Session,
  ISessionEvaluationSandbox,
  SessionEvaluationSandboxService,
  ScopeActivation.OnScopeCreated,
  'evaluationSandbox',
);
