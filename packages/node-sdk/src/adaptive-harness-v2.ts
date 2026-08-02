import {
  ScopeActivation,
  withScopedRegistrationActivation,
} from '@moonshot-ai/agent-core-v2/_base/di/scope';
import { withAdaptiveHostMode } from '@moonshot-ai/agent-core-v2/app/bootstrap/bootstrap';

await import('@moonshot-ai/agent-core-v2/agent/adaptiveRuntime/adaptiveRegistration');
await withScopedRegistrationActivation(ScopeActivation.OnDemand, async () => {
  await import('@moonshot-ai/program-evolution/register');
});

import { KimiHarness } from '#/kimi-harness';
import { SDKRpcClientV2 } from '#/sdk-rpc-client-v2';
import type { KimiHarnessOptions } from '#/types';

/**
 * Construct the v2 SDK harness while carrying the invocation-scoped adaptive
 * mode into the engine's frozen HostArgs snapshot. All adaptive registrations
 * are preloaded as on-demand descriptors, so disabled harnesses remain inert.
 */
export function createKimiHarnessV2(options: KimiHarnessOptions): KimiHarness {
  return withAdaptiveHostMode(options.adaptiveMode ?? 'disabled', () => {
    const rpc = new SDKRpcClientV2(options);
    return new KimiHarness(rpc, {
      identity: rpc.identity,
      uiMode: options.uiMode,
      homeDir: rpc.homeDir,
      configPath: rpc.configPath,
      auth: rpc.auth,
      telemetry: rpc.telemetry,
      ensureConfigFile: () => rpc.ensureConfigFile(),
      onClose: () => rpc.close(),
      imageLimits: undefined,
      sessionStartedProperties: options.sessionStartedProperties,
    });
  });
}
