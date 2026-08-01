/**
 * Agent-core-v2 engine gate for the CLI surfaces.
 *
 * The master switch `KIMI_CODE_EXPERIMENTAL_FLAG` keeps its existing behavior:
 * it routes the CLI through v2 and enables the engine's experimental features.
 * `--evolve` also requires v2, but it must not enable unrelated experiments.
 */

import type { CLIOptions } from './options';

export const KIMI_V2_ENV = 'KIMI_CODE_EXPERIMENTAL_FLAG';
export const ADAPTIVE_HOST_MODE_GLOBAL = '__KIMI_CODE_ADAPTIVE_HOST_MODE__';

const TRUTHY_VALUES = new Set(['1', 'true', 'yes', 'on']);
let invocationOverride = false;
let adaptiveRegistrations: Promise<void> | undefined;

function isTruthyEnv(
  key: string,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return TRUTHY_VALUES.has((env[key] ?? '').trim().toLowerCase());
}

/** Set once by the CLI entrypoint after option validation. */
export function setKimiV2InvocationOverride(enabled: boolean): void {
  invocationOverride = enabled;
  Object.defineProperty(globalThis, ADAPTIVE_HOST_MODE_GLOBAL, {
    value: enabled ? 'enabled' : 'disabled',
    configurable: true,
    enumerable: false,
    writable: true,
  });
}

/** Load the trusted and mutable adaptive registrations before v2 scope creation. */
export function loadAdaptiveRegistrations(): Promise<void> {
  adaptiveRegistrations ??= Promise.all([
    import('@moonshot-ai/agent-core-v2/agent/adaptiveRuntime/adaptiveRegistration'),
    import('@moonshot-ai/program-evolution/register'),
  ]).then(() => undefined);
  return adaptiveRegistrations;
}

export function isKimiV2Enabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return invocationOverride || isTruthyEnv(KIMI_V2_ENV, env);
}

export function shouldUseKimiV2(
  options: Pick<CLIOptions, 'evolve'>,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return options.evolve || isTruthyEnv(KIMI_V2_ENV, env);
}
