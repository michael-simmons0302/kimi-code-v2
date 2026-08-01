import { createDecorator } from '#/_base/di/instantiation';

export type SandboxCapability =
  | 'workspace-read'
  | 'workspace-write'
  | 'temporary-write'
  | 'package-cache-read'
  | 'process-spawn'
  | 'network'
  | 'gpu'
  | 'additional-read-mount';

export interface SandboxMount {
  readonly source: string;
  readonly target: string;
  readonly writable: boolean;
}

export interface SandboxLimits {
  readonly wallMs: number;
  readonly cpuSeconds: number;
  readonly memoryBytes: number;
  readonly processCount: number;
  readonly outputBytes: number;
  readonly writtenBytes: number;
}

export interface SandboxExecutionRequest {
  readonly workspacePath: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly capabilities: readonly SandboxCapability[];
  readonly mounts?: readonly SandboxMount[];
  readonly limits: SandboxLimits;
  readonly signal?: AbortSignal;
}

export interface SandboxBackendInfo {
  readonly id: 'linux-bwrap' | 'windows-wsl2' | 'macos-oci';
  readonly available: boolean;
  readonly version?: string;
  readonly reason?: string;
  readonly supportedCapabilities: readonly SandboxCapability[];
}

export interface SandboxExecutionResult {
  readonly backend: SandboxBackendInfo['id'];
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly outputBytes: number;
}

export interface ISessionEvaluationSandbox {
  readonly _serviceBrand: undefined;
  ready(): Promise<void>;
  backend(): SandboxBackendInfo;
  execute(request: SandboxExecutionRequest): Promise<SandboxExecutionResult>;
}

export const ISessionEvaluationSandbox = createDecorator<ISessionEvaluationSandbox>(
  'sessionEvaluationSandbox',
);

export const DEFAULT_SANDBOX_LIMITS: SandboxLimits = Object.freeze({
  wallMs: 120_000,
  cpuSeconds: 120,
  memoryBytes: 2 * 1024 * 1024 * 1024,
  processCount: 128,
  outputBytes: 16 * 1024 * 1024,
  writtenBytes: 4 * 1024 * 1024 * 1024,
});
