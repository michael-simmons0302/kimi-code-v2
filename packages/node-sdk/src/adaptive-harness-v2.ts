import { withAdaptiveHostMode } from '@moonshot-ai/agent-core-v2/app/bootstrap/bootstrap';

import { KimiHarness } from '#/kimi-harness';
import { SDKRpcClientV2 } from '#/sdk-rpc-client-v2';
import type { KimiHarnessOptions } from '#/types';

/**
 * Construct the v2 SDK harness while carrying the invocation-scoped adaptive
 * mode into the engine's frozen HostArgs snapshot. The override exists only
 * for the synchronous bootstrap performed by the SDK client constructor.
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
