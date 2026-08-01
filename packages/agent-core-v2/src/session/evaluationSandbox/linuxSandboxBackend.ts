import { lstat } from 'node:fs/promises';

import type { ISessionProcessRunner } from '#/session/process/processRunner';
import { isAbsolute, join, normalize } from 'pathe';
import type {
  SandboxBackendInfo,
  SandboxCapability,
  SandboxExecutionRequest,
  SandboxMount,
} from './evaluationSandbox';
import type { SandboxBackend, SandboxCommand } from './sandboxBackend';
import { runProbe } from './sandboxBackend';

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

const TOOLCHAIN_PATHS = [
  '/bin',
  '/sbin',
  '/usr',
  '/usr/local',
  '/lib',
  '/lib64',
  '/opt',
  '/nix/store',
] as const;

export const COMMON_SANDBOX_CAPABILITIES: readonly SandboxCapability[] = [
  'workspace-read',
  'workspace-write',
  'temporary-write',
  'package-cache-read',
  'process-spawn',
  'additional-read-mount',
  'network',
];

export class LinuxSandboxBackend implements SandboxBackend {
  constructor(
    private readonly processes: ISessionProcessRunner,
    private readonly probeCwd: string,
  ) {}

  async probe(): Promise<SandboxBackendInfo> {
    const bwrap = await runProbe(this.processes, ['bwrap', '--version'], this.probeCwd);
    const prlimit = await runProbe(this.processes, ['prlimit', '--version'], this.probeCwd);
    if (bwrap.exitCode !== 0) {
      return {
        id: 'linux-bwrap',
        available: false,
        reason: 'bubblewrap (bwrap) is not installed or executable.',
        supportedCapabilities: COMMON_SANDBOX_CAPABILITIES,
      };
    }
    if (prlimit.exitCode !== 0) {
      return {
        id: 'linux-bwrap',
        available: false,
        reason: 'prlimit is not installed or executable.',
        supportedCapabilities: COMMON_SANDBOX_CAPABILITIES,
      };
    }
    const functional = await runProbe(
      this.processes,
      [
        'prlimit',
        '--as=134217728',
        '--nproc=32',
        '--cpu=5',
        '--',
        'bwrap',
        '--die-with-parent',
        '--new-session',
        '--unshare-all',
        '--ro-bind',
        '/usr',
        '/usr',
        '--proc',
        '/proc',
        '--dev',
        '/dev',
        '--tmpfs',
        '/tmp',
        '--',
        '/usr/bin/true',
      ],
      this.probeCwd,
    );
    return {
      id: 'linux-bwrap',
      available: functional.exitCode === 0,
      version: bwrap.stdout.trim(),
      reason: functional.exitCode === 0
        ? undefined
        : `bubblewrap cannot create the required namespace sandbox: ${functional.stderr.trim()}`,
      supportedCapabilities: COMMON_SANDBOX_CAPABILITIES,
    };
  }

  async command(request: SandboxExecutionRequest): Promise<SandboxCommand> {
    validateRequestShape(request);
    const args = await buildBwrapArgs(request, request.workspacePath, request.mounts ?? []);
    return { args: prlimitPrefix(request).concat(args), cwd: request.workspacePath };
  }
}

export async function buildBwrapArgs(
  request: SandboxExecutionRequest,
  workspaceSource: string,
  mounts: readonly SandboxMount[],
): Promise<string[]> {
  const args: string[] = [
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
  if (request.capabilities.includes('network')) args.push('--share-net');
  for (const path of TOOLCHAIN_PATHS) {
    if (await pathExists(path)) args.push('--ro-bind', path, path);
  }
  args.push(
    request.capabilities.includes('workspace-write') ? '--bind' : '--ro-bind',
    workspaceSource,
    '/workspace',
  );
  for (const mount of mounts) {
    validateMount(mount);
    args.push('--ro-bind', mount.source, mount.target);
  }
  for (const [name, value] of Object.entries(sandboxEnvironment(request.env))) {
    args.push('--setenv', name, value);
  }
  args.push('--chdir', sandboxCwd(request.cwd), '--', ...request.args);
  return args;
}

export function validateRequestShape(request: SandboxExecutionRequest): void {
  if (request.args.length === 0) throw new Error('Sandbox command cannot be empty.');
  if (!isAbsolute(request.workspacePath)) {
    throw new Error('Sandbox workspacePath must be absolute.');
  }
  if (!request.capabilities.includes('workspace-read')) {
    throw new Error('Sandbox execution requires workspace-read capability.');
  }
  if (request.capabilities.includes('gpu')) {
    throw new Error('The secure sandbox protocol does not expose GPU devices.');
  }
  const cwd = normalize(request.cwd ?? '.');
  if (isAbsolute(cwd) || cwd === '..' || cwd.startsWith('../')) {
    throw new Error('Sandbox cwd must remain inside the candidate workspace.');
  }
  for (const [name, value] of Object.entries(request.limits)) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`Sandbox limit ${name} must be positive.`);
    }
  }
}

export function validateMount(mount: SandboxMount): void {
  if (!isAbsolute(mount.source)) {
    throw new Error(`Sandbox mount source must be absolute: ${mount.source}`);
  }
  if (!isAbsolute(mount.target) || !normalize(mount.target).startsWith('/mnt/')) {
    throw new Error(`Additional sandbox mounts must target /mnt/: ${mount.target}`);
  }
  if (mount.writable) {
    throw new Error('Additional sandbox mounts are read-only in sandbox protocol 1.');
  }
}

export function sandboxEnvironment(
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

export function sandboxCwd(cwd: string | undefined): string {
  const normalized = normalize(cwd ?? '.');
  return normalized === '.' ? '/workspace' : join('/workspace', normalized);
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}
