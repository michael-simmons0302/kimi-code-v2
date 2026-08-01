import { createDecorator } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import {
  DEFAULT_SANDBOX_LIMITS,
  ISessionEvaluationSandbox,
  type SandboxCapability,
  type SandboxLimits,
  type SandboxMount,
} from '#/session/evaluationSandbox/evaluationSandbox';
import {
  ISessionEvaluationRegistry,
  type EvaluationResult,
} from './evaluation';

export interface SandboxCommandEvaluationInput {
  readonly workspacePath: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly capabilities?: readonly SandboxCapability[];
  readonly mounts?: readonly SandboxMount[];
  readonly limits?: Partial<SandboxLimits>;
  readonly expectedExitCodes?: readonly number[];
}

export interface SandboxCommandEvaluationOutcome {
  readonly backend: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
}

export interface ISessionSandboxCommandEvaluatorService {
  readonly _serviceBrand: undefined;
}

export const ISessionSandboxCommandEvaluatorService =
  createDecorator<ISessionSandboxCommandEvaluatorService>(
    'sessionSandboxCommandEvaluatorService',
  );

export class SessionSandboxCommandEvaluatorService
  extends Disposable
  implements ISessionSandboxCommandEvaluatorService
{
  declare readonly _serviceBrand: undefined;

  constructor(
    @ISessionEvaluationRegistry registry: ISessionEvaluationRegistry,
    @ISessionEvaluationSandbox sandbox: ISessionEvaluationSandbox,
  ) {
    super();
    this._register(
      registry.register({
        evaluatorId: 'sandbox.command',
        version: '1',
        mode: 'deterministic',
        soundness: 'sound',
        scale: 'repository',
        level: 'behavior',
        outcomeFamily: 'structured',
        cachePolicy: 'exact-environment',
        defaultTimeoutMs: DEFAULT_SANDBOX_LIMITS.wallMs,
        execute: async (input: SandboxCommandEvaluationInput, context) => {
          const expectedExitCodes = input.expectedExitCodes ?? [0];
          const limits: SandboxLimits = {
            ...DEFAULT_SANDBOX_LIMITS,
            ...input.limits,
          };
          const result = await sandbox.execute({
            workspacePath: input.workspacePath,
            args: input.args,
            cwd: input.cwd,
            env: input.env,
            capabilities: input.capabilities ?? [
              'workspace-read',
              'workspace-write',
              'temporary-write',
              'process-spawn',
            ],
            mounts: input.mounts,
            limits,
            signal: context.signal,
          });
          const passed = expectedExitCodes.includes(result.exitCode) && !result.timedOut && !result.cancelled;
          const outcome: SandboxCommandEvaluationOutcome = {
            backend: result.backend,
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
            stdoutTruncated: result.stdoutTruncated,
            stderrTruncated: result.stderrTruncated,
            timedOut: result.timedOut,
            cancelled: result.cancelled,
          };
          return {
            status: result.cancelled
              ? 'cancelled'
              : passed
                ? 'passed'
                : 'failed',
            outcome,
            assertions: [
              {
                assertionId: 'sandbox-exit-code',
                passed,
                expected: expectedExitCodes,
                observed: result.exitCode,
                message: passed
                  ? undefined
                  : `Sandbox command exited with ${result.exitCode}; expected ${expectedExitCodes.join(' or ')}.`,
              },
            ],
            counterexampleRefs: [],
            artifactRefs: [],
            cost: {
              wallMs: result.durationMs,
              outputBytes: result.outputBytes,
            },
          } satisfies Omit<
            EvaluationResult<SandboxCommandEvaluationOutcome>,
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
        },
      }),
    );
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionSandboxCommandEvaluatorService,
  SessionSandboxCommandEvaluatorService,
  ScopeActivation.OnScopeCreated,
  'sandboxCommandEvaluator',
);
