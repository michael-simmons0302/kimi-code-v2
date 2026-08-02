import type { ISessionProcessRunner } from '#/session/process/processRunner';
import type {
  SandboxBackendInfo,
  SandboxExecutionRequest,
  SandboxExecutionResult,
} from './evaluationSandbox';

export interface SandboxCommand {
  readonly args: readonly string[];
  readonly cwd: string;
}

export interface SandboxBackend {
  probe(): Promise<SandboxBackendInfo>;
  command(request: SandboxExecutionRequest): Promise<SandboxCommand>;
}

export interface ProbeResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export async function runProbe(
  processes: ISessionProcessRunner,
  args: readonly string[],
  cwd: string,
): Promise<ProbeResult> {
  let process: Awaited<ReturnType<ISessionProcessRunner['exec']>> | undefined;
  try {
    process = await processes.exec(args, { cwd });
    const stdoutPromise = collectProbe(process.stdout);
    const stderrPromise = collectProbe(process.stderr);
    const exitCode = await process.wait();
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
    return { exitCode, stdout, stderr };
  } catch (error) {
    return {
      exitCode: 127,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await process?.dispose();
  }
}

export async function runSandboxCommand(
  processes: ISessionProcessRunner,
  command: SandboxCommand,
  request: SandboxExecutionRequest,
  backend: SandboxBackendInfo['id'],
): Promise<SandboxExecutionResult> {
  request.signal?.throwIfAborted();
  const initialWorkspaceBytes = await directorySize(request.workspacePath, request.signal);
  const startedAt = Date.now();
  const process = await processes.exec(command.args, { cwd: command.cwd });
  const timeoutSignal = AbortSignal.timeout(request.limits.wallMs);
  const executionController = new AbortController();
  const combined = request.signal === undefined
    ? AbortSignal.any([timeoutSignal, executionController.signal])
    : AbortSignal.any([request.signal, timeoutSignal, executionController.signal]);
  let outputLimitExceeded = false;
  let diskLimitExceeded = false;
  const outputCounter = { bytes: 0 };
  const kill = (): void => {
    void process.kill().catch(() => undefined);
  };
  combined.addEventListener('abort', kill, { once: true });
  const monitor = monitorWorkspaceGrowth(
    request.workspacePath,
    initialWorkspaceBytes,
    request.limits.writtenBytes,
    executionController.signal,
    () => {
      diskLimitExceeded = true;
      kill();
    },
  );
  try {
    const stdoutPromise = collectBounded(
      process.stdout,
      request.limits.outputBytes,
      outputCounter,
      () => {
        outputLimitExceeded = true;
        kill();
      },
    );
    const stderrPromise = collectBounded(
      process.stderr,
      request.limits.outputBytes,
      outputCounter,
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
    if (diskLimitExceeded) {
      throw new Error(`Sandbox writes exceeded ${request.limits.writtenBytes} bytes.`);
    }
    const finalWorkspaceBytes = await directorySize(request.workspacePath, request.signal);
    if (Math.max(0, finalWorkspaceBytes - initialWorkspaceBytes) > request.limits.writtenBytes) {
      throw new Error(`Sandbox writes exceeded ${request.limits.writtenBytes} bytes.`);
    }
    return {
      backend,
      exitCode,
      stdout: stdout.text,
      stderr: stderr.text,
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
      durationMs: Date.now() - startedAt,
      timedOut: timeoutSignal.aborted && request.signal?.aborted !== true,
      cancelled: request.signal?.aborted === true,
      outputBytes: outputCounter.bytes,
    };
  } finally {
    executionController.abort();
    combined.removeEventListener('abort', kill);
    await monitor;
    await process.dispose();
  }
}

export function firstNonEmptyLine(...values: readonly string[]): string | undefined {
  for (const value of values) {
    const line = value.split(/\r?\n/).map((part) => part.trim()).find(Boolean);
    if (line !== undefined) return line;
  }
  return undefined;
}

async function collectProbe(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  let retained = 0;
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = 256 * 1024 - retained;
    if (remaining <= 0) continue;
    const selected = buffer.subarray(0, remaining);
    chunks.push(selected);
    retained += selected.byteLength;
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
    const selected = buffer.subarray(0, Math.min(remaining, buffer.byteLength));
    chunks.push(selected);
    retained += selected.byteLength;
    if (selected.byteLength < buffer.byteLength) truncated = true;
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated };
}

async function monitorWorkspaceGrowth(
  root: string,
  initialBytes: number,
  maximumGrowth: number,
  stopSignal: AbortSignal,
  onLimit: () => void,
): Promise<void> {
  while (!stopSignal.aborted) {
    await sleep(500, stopSignal);
    if (stopSignal.aborted) return;
    const current = await directorySize(root, stopSignal);
    if (Math.max(0, current - initialBytes) > maximumGrowth) {
      onLimit();
      return;
    }
  }
}

async function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

async function directorySize(root: string, signal?: AbortSignal): Promise<number> {
  const { lstat, readdir } = await import('node:fs/promises');
  const { join } = await import('pathe');
  let total = 0;
  const visit = async (directory: string): Promise<void> => {
    signal?.throwIfAborted();
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '.git') await visit(path);
      } else if (entry.isFile()) {
        total += (await lstat(path)).size;
      }
    }
  };
  await visit(root);
  return total;
}
