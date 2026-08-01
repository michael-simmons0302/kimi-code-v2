/**
 * Agent-core-v2 engine gate for the CLI surfaces.
 *
 * The master switch `KIMI_CODE_EXPERIMENTAL_FLAG` keeps its existing behavior:
 * it routes the CLI through v2 and enables the engine's experimental features.
 * `--evolve` also requires v2, but it must not enable unrelated experiments, so
 * callers pass the invocation-scoped option explicitly through `shouldUseKimiV2`.
 *
 * Note: `kimi web` always boots kap-server (the agent-core-v2 engine server).
 */

import type { CLIOptions } from './options';

export const KIMI_V2_ENV = 'KIMI_CODE_EXPERIMENTAL_FLAG';

const TRUTHY_VALUES = new Set(['1', 'true', 'yes', 'on']);

function isTruthyEnv(
  key: string,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return TRUTHY_VALUES.has((env[key] ?? '').trim().toLowerCase());
}

export function isKimiV2Enabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return isTruthyEnv(KIMI_V2_ENV, env);
}

export function shouldUseKimiV2(
  options: Pick<CLIOptions, 'evolve'>,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return options.evolve || isKimiV2Enabled(env);
}
