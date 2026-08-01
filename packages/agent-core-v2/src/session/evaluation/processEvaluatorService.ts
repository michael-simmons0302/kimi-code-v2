import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ISessionProcessRunner } from '#/session/process/processRunner';
import { ISessionEvaluationRegistry, type EvaluationResult } from './evaluation';

export interface ProcessEvaluationInput {
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly expectedExitCodes?: readonly number[];
  readonly maximumOutputBytes?: number;
}

export interface ProcessEvaluationOutcome {
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

export class SessionProcessEvaluatorService extends Disposable {
  constructor(
    @ISessionEvaluationRegistry registry: ISessionEvaluationRegistry,
    @ISessionProcessRunner processRunner: ISessionProcessRunner,
  ) {
    super();
    this._register(
      registry.register({
        evaluatorId: 'process.exit-code',
        version: '1',
        mode: 'deterministic',
        soundness: 'sound',
        scale: 'runtime',
        level: 'validity',
        outcomeFamily: 'structured',
        cachePolicy: 'exact-environment',
        defaultTimeoutMs: 120_000,
        execute: async (input: ProcessEvaluationInput, context) => {
          if (!Array.isArray(input.args) || input.args.length === 0) {
            throw new Error('process.exit-code requires a non-empty args array.');
          }
          context.signal.throwIfAborted();
          const startedAt = Date.now();
          const process = await processRunner.exec(input.args, {
            cwd: input.cwd,
            env: input.env,
          });
          const maximumOutputBytes = normalizeMaximumBytes(input.maximumOutputBytes);
          const stdoutPromise = collectText(process.stdout, maximumOutputBytes);
          const stderrPromise = collectText(process.stderr, maximumOutputBytes);
          const abort = (): void => {
            void process.kill().catch(() => undefined);
          };
          context.signal.addEventListener('abort', abort, { once: true });
          try {
            const exitCode = await process.wait();
            const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
            const expected = input.expectedExitCodes ?? [0];
            const passed = expected.includes(exitCode);
            const outcome: ProcessEvaluationOutcome = {
              args: input.args,
              cwd: input.cwd,
              exitCode,
              stdout: stdout.text,
              stderr: stderr.text,
              stdoutTruncated: stdout.truncated,
              stderrTruncated: stderr.truncated,
            };
            return {
              status: passed ? 'passed' : 'failed',
              outcome,
              assertions: [
                {
                  assertionId: 'exit-code',
                  passed,
                  expected,
                  observed: exitCode,
                  message: passed
                    ? undefined
                    : `Expected exit code ${expected.join(' or ')}, observed ${exitCode}.`,
                },
              ],
              counterexampleRefs: [],
              artifactRefs: [],
              cost: {
                wallMs: Date.now() - startedAt,
                outputBytes: stdout.bytes + stderr.bytes,
              },
            } satisfies Omit<
              EvaluationResult<ProcessEvaluationOutcome>,
              | 'protocol'
              | 'evaluationId'
              | 'evaluatorId'
              | 'evaluatorVersion'
              | 'mode'
              | 'soundness'
              | 'scale'
              | 'level'
              | 'outcomeFamily'
            >;
          } finally {
            context.signal.removeEventListener('abort', abort);
            await process.dispose();
          }
        },
      }),
    );
  }
}

async function collectText(
  stream: NodeJS.ReadableStream,
  maximumBytes: number,
): Promise<{ readonly text: string; readonly bytes: number; readonly truncated: boolean }> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let retained = 0;
  let truncated = false;
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    const remaining = maximumBytes - retained;
    if (remaining <= 0) {
      truncated = true;
      continue;
    }
    const selected = buffer.byteLength <= remaining ? buffer : buffer.subarray(0, remaining);
    chunks.push(selected);
    retained += selected.byteLength;
    if (selected.byteLength !== buffer.byteLength) truncated = true;
  }
  return { text: Buffer.concat(chunks).toString('utf8'), bytes, truncated };
}

function normalizeMaximumBytes(value: number | undefined): number {
  if (value === undefined) return 4 * 1024 * 1024;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('maximumOutputBytes must be a positive finite number.');
  }
  return Math.floor(value);
}

registerScopedService(
  LifecycleScope.Session,
  SessionProcessEvaluatorService,
  SessionProcessEvaluatorService,
  ScopeActivation.OnScopeCreated,
  'processEvaluator',
);
