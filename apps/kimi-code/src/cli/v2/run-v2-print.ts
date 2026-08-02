/**
 * Native v2 `kimi -p` (print mode) runner.
 */

import { readFile } from 'node:fs/promises';

import {
  IAgentGoalService,
  IAgentLifecycleService,
  IAgentPermissionModeService,
  IAgentProfileService,
  IAgentPromptService,
  IAgentTaskService,
  IAuthSummaryService,
  IBootstrapService,
  IConfigService,
  IEventBus,
  IOAuthToolkit,
  ISessionCronService,
  ISessionIndex,
  ISessionLifecycleService,
  IWorkspaceLifecycleService,
  ITelemetryService,
  PRINT_MAX_TURNS_DEFAULT,
  PRINT_WAIT_CEILING_S_DEFAULT,
  applyPrintModeConfigDefaults,
  bootstrap,
  createCloudAppender,
  ensureMainAgent,
  resumeSessionById,
  logSeed,
  parseAgentFileText,
  resolveAgentPath,
  resolveAgentTaskConfig,
  resolveKimiHome,
  resolveLoggingConfig,
  resolvePrintBackgroundMode,
  type DomainEvent,
  type IAgentScopeHandle,
  type ISessionScopeHandle,
  type LoopRunResult,
  type PrintBackgroundMode,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import { createKimiDefaultHeaders, createKimiDeviceId } from '@moonshot-ai/kimi-code-oauth';
import { resolve } from 'pathe';

import {
  CLI_SHUTDOWN_TIMEOUT_MS,
  CLI_USER_AGENT_PRODUCT,
  PROMPT_CLEANUP_TIMEOUT_MS,
} from '#/constant/app';

import {
  formatGoalSummaryText,
  goalExitCode,
  goalSummaryJson,
  parseHeadlessGoalCreate,
  type HeadlessGoalCreate,
} from '../goal-prompt';
import {
  type PromptRunIO,
  configuredModel,
  installPromptTerminationCleanup,
  raceWithTimeout,
  requireConfiguredModel,
} from '../run-prompt';
import { createKimiCodeHostIdentity } from '../version';

import { resolveOutputFormat } from '../options';
import type { CLIOptions, PromptOutputFormat } from '../options';
import {
  type PromptOutput,
  PromptJsonWriter,
  type PromptTurnWriter,
  PromptTranscriptWriter,
  writeExperimentalVersion,
  writeResumeHint,
} from '../prompt-render';

const PROMPT_UI_MODE = 'print';
const GOAL_WAIT_POLL_MS = 250;
const CRON_FIRE_GRACE_MS = 5_000;

export async function runV2Print(
  opts: CLIOptions,
  version: string,
  io: PromptRunIO = {},
): Promise<void> {
  const startedAt = Date.now();
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const promptProcess = io.process ?? process;
  const outputFormat = resolveOutputFormat(opts);
  const workDir = process.cwd();

  writeExperimentalVersion(version, outputFormat, stdout, stderr);

  const homeDir = resolveKimiHome();
  let firstLaunch = false;
  const deviceId = createKimiDeviceId(homeDir, {
    onFirstLaunch: () => {
      firstLaunch = true;
    },
  });
  const logging = resolveLoggingConfig({ homeDir, env: process.env });
  const identity = createKimiCodeHostIdentity(version);
  const hostHeaders = createKimiDefaultHeaders({ homeDir, ...identity });

  const { app } = bootstrap(
    {
      homeDir,
      clientIdentity: identity,
      args: {
        requestHeaders: hostHeaders,
        skillDirs: opts.skillsDirs,
        agentFiles: opts.agentFiles,
        adaptiveMode: opts.evolve ? 'enabled' : 'disabled',
      },
    },
    [...logSeed(logging)],
  );
  const auth = app.accessor.get(IOAuthToolkit);

  const configService = app.accessor.get(IConfigService);
  await configService.ready;
  await applyPrintModeConfigDefaults(configService);
  const defaultModel = configService.get<string>('defaultModel') ?? undefined;
  let telemetryEnabled = true;
  try {
    telemetryEnabled = configService.get('telemetry') !== false;
  } catch {
    telemetryEnabled = true;
  }
  for (const diagnostic of configService.diagnostics()) {
    if (diagnostic.severity === 'warning') {
      stderr.write(`Warning: ${diagnostic.message}\n`);
    }
  }

  let restorePermission = async (): Promise<void> => {};
  let removeTerminationCleanup: (() => void) | undefined;
  let cleanupPromise: Promise<void> | undefined;
  let telemetryService: ITelemetryService | undefined;
  const cleanup = async (): Promise<void> => {
    const pending = (cleanupPromise ??= (async () => {
      removeTerminationCleanup?.();
      try {
        await restorePermission();
      } finally {
        if (telemetryService !== undefined) {
          await raceWithTimeout(telemetryService.shutdown(), CLI_SHUTDOWN_TIMEOUT_MS);
        }
        app.dispose();
      }
    })());
    await raceWithTimeout(pending, PROMPT_CLEANUP_TIMEOUT_MS);
  };
  removeTerminationCleanup = installPromptTerminationCleanup(promptProcess, cleanup);

  try {
    telemetryService = app.accessor.get(ITelemetryService);
    if (telemetryEnabled) {
      telemetryService.setAppender(
        createCloudAppender(app.accessor, {
          deviceId,
          appName: CLI_USER_AGENT_PRODUCT,
          uiMode: PROMPT_UI_MODE,
          model: opts.model ?? defaultModel,
          getAccessToken: async () => (await auth.getCachedAccessToken()) ?? null,
        }),
      );
    }

    const resolved = await resolveNativeSession(app, opts, workDir, defaultModel, stderr);
    restorePermission = resolved.restorePermission;

    telemetryService.setContext({ sessionId: resolved.session.id, model: resolved.telemetryModel });
    if (firstLaunch) telemetryService.track2('first_launch');

    const goalCreate = parseHeadlessGoalCreate(opts.prompt!);
    if (goalCreate !== undefined) {
      await runNativeGoal(
        app,
        resolved.session,
        resolved.agent,
        goalCreate,
        resolved.goalModel,
        outputFormat,
        stdout,
        stderr,
      );
    } else {
      await runNativeTurn(
        app,
        resolved.session,
        resolved.agent,
        opts.prompt!,
        outputFormat,
        stdout,
        stderr,
      );
    }
    writeResumeHint(resolved.session.id, outputFormat, stdout, stderr);

    telemetryService.withContext({ sessionId: resolved.session.id }).track2('exit', {
      duration_ms: Date.now() - startedAt,
    });
  } finally {
    await cleanup();
  }
}

interface ResolvedNativeSession {
  readonly session: ISessionScopeHandle;
  readonly agent: IAgentScopeHandle;
  readonly restorePermission: () => Promise<void>;
  readonly telemetryModel: string | undefined;
  readonly goalModel: string | undefined;
}

async function resolveNativeSession(
  app: Scope,
  opts: CLIOptions,
  workDir: string,
  defaultModel: string | undefined,
  stderr: PromptOutput,
): Promise<ResolvedNativeSession> {
  const workspaceLifecycle = app.accessor.get(IWorkspaceLifecycleService);
  const index = app.accessor.get(ISessionIndex);

  let agentProfileName = opts.agent;
  const agentFile = opts.agentFiles[0];
  if (agentProfileName === undefined && agentFile !== undefined) {
    const agentFilePath = resolveAgentPath(
      agentFile,
      workDir,
      app.accessor.get(IBootstrapService).osHomeDir,
    );
    let agentFileText: string;
    try {
      agentFileText = await readFile(agentFilePath, 'utf8');
    } catch (error) {
      throw new Error(
        `Failed to read agent file "${agentFilePath}": ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    try {
      agentProfileName = parseAgentFileText({
        path: agentFilePath,
        source: 'explicit',
        text: agentFileText,
      }).name;
    } catch (error) {
      throw new Error(
        `Invalid agent file "${agentFilePath}": ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  const applyModelOverride = async (
    profile: IAgentProfileService,
    model: string | undefined,
  ): Promise<void> => {
    if (model !== undefined) await profile.setModel(model);
  };

  const resumeById = async (id: string): Promise<ISessionScopeHandle> => {
    const session = await resumeSessionById(app.accessor, id);
    if (session === undefined) throw new Error(`Session "${id}" not found.`);
    return session;
  };

  const forceAuto = (
    agent: IAgentScopeHandle,
  ): { readonly restorePermission: () => Promise<void> } => {
    const permissionMode = agent.accessor.get(IAgentPermissionModeService);
    const previous = permissionMode.mode;
    permissionMode.setMode('auto');
    return {
      restorePermission: async () => {
        permissionMode.setMode(previous);
      },
    };
  };

  if (opts.session !== undefined) {
    const page = await index.list({});
    const target = page.items.find((summary) => summary.id === opts.session);
    if (target === undefined) throw new Error(`Session "${opts.session}" not found.`);
    if (target.cwd !== undefined && resolve(target.cwd) !== resolve(workDir)) {
      stderr.write(
        `Session "${opts.session}" was created under a different directory.\n` +
          `  cd "${target.cwd}" && kimi -r ${opts.session}\n\n`,
      );
      throw new Error(`Session "${opts.session}" was created under a different directory.`);
    }
    const session = await resumeById(opts.session);
    const agent = await ensureMainAgent(session);
    const profile = agent.accessor.get(IAgentProfileService);
    await applyModelOverride(profile, opts.model);
    const currentModel = profile.getModel();
    const { restorePermission } = forceAuto(agent);
    return {
      session,
      agent,
      restorePermission,
      telemetryModel: configuredModel(opts.model, currentModel, defaultModel),
      goalModel: configuredModel(opts.model, currentModel),
    };
  }

  if (opts.continue) {
    const page = await index.list({});
    const previous = page.items.find((summary) => summary.cwd === workDir);
    if (previous !== undefined) {
      const session = await resumeById(previous.id);
      const agent = await ensureMainAgent(session);
      const profile = agent.accessor.get(IAgentProfileService);
      await applyModelOverride(profile, opts.model);
      const currentModel = profile.getModel();
      const { restorePermission } = forceAuto(agent);
      return {
        session,
        agent,
        restorePermission,
        telemetryModel: configuredModel(opts.model, currentModel, defaultModel),
        goalModel: configuredModel(opts.model, currentModel),
      };
    }
    stderr.write(`No sessions to continue under "${workDir}"; starting a fresh session.\n`);
  }

  const model = requireConfiguredModel(opts.model, defaultModel);
  const handler = await workspaceLifecycle.handlerFor({ root: workDir });
  const session = await handler.accessor.get(ISessionLifecycleService).create({
    workDir,
    additionalDirs: opts.addDirs?.length ? opts.addDirs : undefined,
    mainAgentBinding: {
      profile: agentProfileName ?? 'agent',
      model,
    },
  });
  const agent = await ensureMainAgent(session);
  agent.accessor.get(IAgentPermissionModeService).setMode('auto');
  return {
    session,
    agent,
    restorePermission: async () => {},
    telemetryModel: model,
    goalModel: model,
  };
}

async function runNativeTurn(
  app: Scope,
  session: ISessionScopeHandle,
  agent: IAgentScopeHandle,
  prompt: string,
  outputFormat: PromptOutputFormat,
  stdout: PromptOutput,
  stderr: PromptOutput,
): Promise<void> {
  const writer: PromptTurnWriter =
    outputFormat === 'stream-json'
      ? new PromptJsonWriter(stdout)
      : new PromptTranscriptWriter(stdout, stderr);

  await agent.accessor.get(IAuthSummaryService).ensureReady();

  const turnEndings = createPrintTurnEndings();
  const subscription = agent.accessor.get(IEventBus).subscribe((event: DomainEvent) => {
    dispatchNativeEvent(writer, event, stderr);
    if (event.type === 'turn.ended') turnEndings.push(event);
  });
  try {
    const handle = await agent.accessor.get(IAgentPromptService).enqueue({
      message: {
        role: 'user',
        content: [{ type: 'text', text: prompt }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
    });
    const turn = await handle.launched;
    if (turn === undefined) {
      writer.finish();
      const completion = await handle.completion;
      throw new Error(
        completion.state === 'blocked'
          ? 'Prompt hook blocked the request.'
          : 'Prompt turn could not be started',
      );
    }
    const result = await turn.result;

    writer.flushAssistant();
    if (result.type === 'completed') {
      const configService = app.accessor.get(IConfigService);
      const taskConfig = resolveAgentTaskConfig(configService);
      const goalService = agent.accessor.get(IAgentGoalService);
      const cronService = session.accessor.get(ISessionCronService);
      try {
        await applyPrintBackgroundPolicy({
          mode: resolvePrintBackgroundMode(configService),
          ceilingS: taskConfig?.printWaitCeilingS ?? PRINT_WAIT_CEILING_S_DEFAULT,
          maxTurns: taskConfig?.printMaxTurns ?? PRINT_MAX_TURNS_DEFAULT,
          countPending: () => countPendingBackgroundTasks(session),
          drain: () => drainBackgroundTasks(session, taskConfig?.printWaitCeilingS),
          turnEndings,
          skipTurnId: turn.id,
          warn: (message) => stderr.write(`Warning: ${message}\n`),
          now: () => Date.now(),
          goalActive: () => goalService.getGoal().goal?.status === 'active',
          cronNextFireAt: () => cronService.getNextFireTime(),
        });
      } catch (error) {
        if (error instanceof PrintSteeredTurnFailedError) {
          writer.finish();
          throw error;
        }
        stderr.write(
          `Warning: print background policy failed: ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        );
      }
      writer.finish();
      return;
    }
    writer.finish();
    throw new Error(formatNativeTurnFailure(result));
  } catch (error) {
    writer.finish();
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    subscription.dispose();
  }
}

async function runNativeGoal(
  app: Scope,
  session: ISessionScopeHandle,
  agent: IAgentScopeHandle,
  goal: HeadlessGoalCreate,
  model: string | undefined,
  outputFormat: PromptOutputFormat,
  stdout: PromptOutput,
  stderr: PromptOutput,
): Promise<void> {
  requireConfiguredModel(model);
  const goalService = agent.accessor.get(IAgentGoalService);
  await goalService.createGoal({
    objective: goal.objective,
    replace: goal.replace,
  });
  let completedSnapshot: { readonly status: string } | null = null;
  const subscription = agent.accessor.get(IEventBus).subscribe((event: DomainEvent) => {
    if (
      event.type === 'goal.updated' &&
      event.change?.kind === 'completion' &&
      event.snapshot !== null
    ) {
      completedSnapshot = event.snapshot;
    }
  });
  try {
    await runNativeTurn(app, session, agent, goal.objective, outputFormat, stdout, stderr);
  } finally {
    subscription.dispose();
    const snapshot = completedSnapshot ?? goalService.getGoal().goal;
    if (outputFormat === 'stream-json') {
      stdout.write(`${JSON.stringify(goalSummaryJson(snapshot))}\n`);
    } else {
      stderr.write(`${formatGoalSummaryText(snapshot)}\n`);
    }
    if (snapshot !== null && snapshot.status !== 'complete') {
      process.exitCode = goalExitCode(snapshot.status);
    }
  }
}

function dispatchNativeEvent(
  writer: PromptTurnWriter,
  event: DomainEvent,
  stderr: PromptOutput,
): void {
  switch (event.type) {
    case 'adaptive.status.updated':
      writer.writeAdaptiveStatus(event.status);
      return;
    case 'turn.step.started':
    case 'turn.step.interrupted':
      writer.flushAssistant();
      return;
    case 'turn.step.retrying':
      writer.discardAssistant();
      writer.writeRetrying(event);
      return;
    case 'assistant.delta':
      writer.writeAssistantDelta(event.delta);
      return;
    case 'hook.result':
      writer.writeHookResult(event);
      return;
    case 'thinking.delta':
      writer.writeThinkingDelta(event.delta);
      return;
    case 'tool.call.started':
      writer.writeToolCall(event.toolCallId, event.name, event.args);
      return;
    case 'tool.call.delta':
      writer.writeToolCallDelta(event.toolCallId, event.name, event.argumentsPart);
      return;
    case 'tool.result':
      writer.writeToolResult(event.toolCallId, event.output);
      return;
    case 'tool.progress':
      if (event.update.text !== undefined && event.update.text.length > 0) {
        stderr.write(event.update.text.endsWith('\n') ? event.update.text : `${event.update.text}\n`);
      }
      return;
  }
}

export type PrintTurnEnding = Extract<DomainEvent, { type: 'turn.ended' }>;

export interface PrintTurnEndings {
  next(remainingMs: number, skipTurnId: number): Promise<PrintTurnEnding | null>;
}

export function createPrintTurnEndings(): PrintTurnEndings & {
  push: (event: PrintTurnEnding) => void;
} {
  const buffer: PrintTurnEnding[] = [];
  let waiter: ((ending: PrintTurnEnding | null) => void) | undefined;
  return {
    push: (event) => {
      const resolve = waiter;
      if (resolve !== undefined) {
        waiter = undefined;
        resolve(event);
        return;
      }
      buffer.push(event);
    },
    next: async (remainingMs, skipTurnId) => {
      const deadlineAt = Date.now() + remainingMs;
      const waitOnce = (ms: number): Promise<PrintTurnEnding | null> =>
        new Promise((resolve) => {
          let settled = false;
          const settle = (value: PrintTurnEnding | null): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            waiter = undefined;
            resolve(value);
          };
          const timer = Number.isFinite(ms)
            ? setTimeout(() => {
                settle(null);
              }, ms)
            : undefined;
          waiter = settle;
        });
      for (;;) {
        while (buffer.length > 0) {
          const ending = buffer.shift()!;
          if (ending.turnId !== skipTurnId) return ending;
        }
        const ms = deadlineAt - Date.now();
        if (ms <= 0) return null;
        const ending = await waitOnce(ms);
        if (ending === null) return null;
        if (ending.turnId !== skipTurnId) return ending;
      }
    },
  };
}

export class PrintSteeredTurnFailedError extends Error {}

export interface PrintBackgroundPolicyInput {
  readonly mode: PrintBackgroundMode;
  readonly ceilingS: number;
  readonly maxTurns: number;
  readonly countPending: () => number;
  readonly drain: () => Promise<void>;
  readonly turnEndings: PrintTurnEndings;
  readonly skipTurnId: number;
  readonly warn: (message: string) => void;
  readonly now: () => number;
  readonly goalActive?: () => boolean;
  readonly cronNextFireAt?: () => number | null;
}

export async function applyPrintBackgroundPolicy(
  input: PrintBackgroundPolicyInput,
): Promise<void> {
  const deadline = input.now() + input.ceilingS * 1000;
  let turns = 0;
  let lastPastFireAt: number | undefined;
  let cronWedged = false;
  for (;;) {
    while (input.goalActive?.() === true) {
      const ended = await input.turnEndings.next(
        Math.min(deadline - input.now(), GOAL_WAIT_POLL_MS),
        input.skipTurnId,
      );
      if (ended === null && input.now() >= deadline) {
        input.warn(`print goal wait ceiling reached (${input.ceilingS}s), finishing`);
        return;
      }
    }

    if (!cronWedged && input.cronNextFireAt !== undefined) {
      const fireAt = input.cronNextFireAt();
      if (fireAt !== null) {
        if (fireAt <= input.now() && lastPastFireAt === fireAt) {
          cronWedged = true;
          input.warn(
            'print cron wait: next fire time stuck in the past; cron tick appears wedged, giving up on cron',
          );
        } else {
          if (fireAt <= input.now()) lastPastFireAt = fireAt;
          const ended = await input.turnEndings.next(
            Math.max(fireAt - input.now(), 0) + CRON_FIRE_GRACE_MS,
            input.skipTurnId,
          );
          if (ended !== null && ended.reason !== 'completed') {
            throw new PrintSteeredTurnFailedError(formatTurnEndingFailure(ended));
          }
          continue;
        }
      }
    }

    if (input.mode === 'exit') return;
    if (input.mode === 'drain') {
      await input.drain();
      return;
    }

    turns += 1;
    if (input.now() >= deadline) {
      input.warn(`print steer ceiling reached (${input.ceilingS}s), finishing`);
      return;
    }
    if (turns > input.maxTurns) {
      input.warn(`print steer max turns reached (${input.maxTurns}), finishing`);
      return;
    }
    if (input.countPending() === 0) return;
    const ended = await input.turnEndings.next(deadline - input.now(), input.skipTurnId);
    if (ended === null) return;
    if (ended.reason !== 'completed') {
      throw new PrintSteeredTurnFailedError(formatTurnEndingFailure(ended));
    }
  }
}

function formatTurnEndingFailure(ending: PrintTurnEnding): string {
  if (ending.error?.code === 'provider.filtered') {
    return 'Provider safety policy blocked the response.';
  }
  if (ending.error !== undefined) return `${ending.error.code}: ${ending.error.message}`;
  if (ending.reason === 'blocked') return 'Prompt hook blocked the request.';
  return `Prompt turn ended with reason: ${ending.reason}`;
}

function countPendingBackgroundTasks(session: ISessionScopeHandle): number {
  let count = 0;
  for (const handle of session.accessor.get(IAgentLifecycleService).list()) {
    count += handle.accessor.get(IAgentTaskService).list(true).length;
  }
  return count;
}

async function drainBackgroundTasks(
  session: ISessionScopeHandle,
  ceilingS: number | undefined,
): Promise<void> {
  const ceilingMs =
    typeof ceilingS === 'number' && Number.isFinite(ceilingS) && ceilingS > 0
      ? ceilingS * 1000
      : PRINT_WAIT_CEILING_S_DEFAULT * 1000;

  const deadline = Date.now() + ceilingMs;
  const seen = new Set<string>();
  const allWaiters: Promise<unknown>[] = [];
  while (Date.now() < deadline) {
    const batch: Promise<unknown>[] = [];
    const suppressions: Promise<void>[] = [];
    let activeCount = 0;
    for (const handle of session.accessor.get(IAgentLifecycleService).list()) {
      const taskService = handle.accessor.get(IAgentTaskService);
      for (const task of taskService.list(true)) {
        activeCount++;
        if (seen.has(task.taskId)) continue;
        seen.add(task.taskId);
        suppressions.push(taskService.suppressTerminalNotification(task.taskId));
        const remaining = Math.max(1, deadline - Date.now());
        const waiter = taskService.wait(task.taskId, remaining);
        batch.push(waiter);
        allWaiters.push(waiter);
      }
    }
    if (suppressions.length > 0) await Promise.all(suppressions);
    if (activeCount === 0 || batch.length === 0) break;
    await Promise.all(batch);
  }
  if (allWaiters.length > 0) await Promise.all(allWaiters);
}

function formatNativeTurnFailure(result: LoopRunResult): string {
  if (result.type === 'failed') {
    const error = result.error as { readonly code?: string; readonly message?: string } | undefined;
    if (error?.code === 'provider.filtered') {
      return 'Provider safety policy blocked the response.';
    }
    if (error?.code !== undefined) {
      return `${error.code}: ${error.message ?? ''}`.trimEnd();
    }
    if (result.error instanceof Error) return result.error.message;
  }
  return `Prompt turn ended with reason: ${result.type}`;
}
