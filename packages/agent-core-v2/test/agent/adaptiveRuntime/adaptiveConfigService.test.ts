import { describe, expect, it } from 'vitest';

import { SessionAdaptiveConfigService } from '#/agent/adaptiveRuntime/adaptiveConfigService';
import type { IConfigService } from '#/app/config/config';

function configService(value: unknown): IConfigService {
  return {
    _serviceBrand: undefined,
    get: () => value,
  } as unknown as IConfigService;
}

describe('SessionAdaptiveConfigService', () => {
  it('resolves one deeply frozen default snapshot', () => {
    const service = new SessionAdaptiveConfigService(configService({}));
    const snapshot = service.snapshot();

    expect(snapshot.config.enabledByDefault).toBe(false);
    expect(snapshot.config.worldModel.minimumPopulation).toBe(3);
    expect(snapshot.config.search.defaultDiscoveryTemperature).toBe(0.75);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.config)).toBe(true);
    expect(Object.isFrozen(snapshot.config.search)).toBe(true);
    expect(Object.isFrozen(snapshot.config.evaluation.timeoutOverridesMs)).toBe(true);
  });

  it('returns the same immutable snapshot identity to every consumer', () => {
    const service = new SessionAdaptiveConfigService(
      configService({ search: { cPuct: 2 } }),
    );
    expect(service.snapshot()).toBe(service.snapshot());
    expect(service.snapshot().config.search.cPuct).toBe(2);
  });

  it('produces a deterministic hash independent of input property order', () => {
    const first = new SessionAdaptiveConfigService(
      configService({
        search: { cPuct: 2, maximumNodes: 1024 },
        worldModel: { maximumPopulation: 12, minimumPopulation: 4 },
      }),
    );
    const second = new SessionAdaptiveConfigService(
      configService({
        worldModel: { minimumPopulation: 4, maximumPopulation: 12 },
        search: { maximumNodes: 1024, cPuct: 2 },
      }),
    );
    expect(first.snapshot().hash).toBe(second.snapshot().hash);
  });

  it('changes the snapshot hash when behaviorally relevant configuration changes', () => {
    const first = new SessionAdaptiveConfigService(
      configService({ search: { cPuct: 1.5 } }),
    );
    const second = new SessionAdaptiveConfigService(
      configService({ search: { cPuct: 2 } }),
    );
    expect(first.snapshot().hash).not.toBe(second.snapshot().hash);
  });

  it('resolves all model roles from the same frozen snapshot', () => {
    const service = new SessionAdaptiveConfigService(
      configService({
        models: {
          proposal: 'proposal-model',
          finalClaimVerification: 'verifier-model',
        },
      }),
    );
    const roles = service.modelRoles('primary-model');
    expect(roles).toEqual({
      proposal: 'proposal-model',
      repair: 'primary-model',
      evaluationDesign: 'primary-model',
      actionProposal: 'primary-model',
      trajectoryCompression: 'primary-model',
      policyValue: 'primary-model',
      finalResponsePlanning: 'primary-model',
      finalClaimVerification: 'verifier-model',
    });
    expect(Object.isFrozen(roles)).toBe(true);
  });

  it('rejects invalid cross-field configuration during service construction', () => {
    expect(
      () =>
        new SessionAdaptiveConfigService(
          configService({
            evaluation: { minimumReplicates: 16, maximumReplicates: 4 },
          }),
        ),
    ).toThrow('maximumReplicates');
  });

  it('rejects unknown configuration instead of accepting dead knobs', () => {
    expect(
      () =>
        new SessionAdaptiveConfigService(
          configService({ search: { cPuct: 1.5, inventedOption: true } }),
        ),
    ).toThrow();
  });
});
