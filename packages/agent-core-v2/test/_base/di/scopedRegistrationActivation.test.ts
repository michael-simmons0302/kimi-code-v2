import { describe, expect, it } from 'vitest';

import { createDecorator } from '#/_base/di/instantiation';
import {
  LifecycleScope,
  ScopeActivation,
  getScopedServiceDescriptors,
  registerScopedService,
  withScopedRegistrationActivation,
} from '#/_base/di/scope';

interface ITestService { readonly _serviceBrand: undefined }
class TestService implements ITestService { declare readonly _serviceBrand: undefined }

function activationFor(id: ReturnType<typeof createDecorator<ITestService>>) {
  return getScopedServiceDescriptors(LifecycleScope.Agent)
    .find((entry) => entry.id === id)?.activation;
}

describe('withScopedRegistrationActivation', () => {
  it('forces registrations inside the callback to the requested activation', async () => {
    const id = createDecorator<ITestService>('scopedRegistrationActivationForced');
    await withScopedRegistrationActivation(ScopeActivation.OnDemand, async () => {
      registerScopedService(
        LifecycleScope.Agent,
        id,
        TestService,
        ScopeActivation.OnScopeCreated,
        'test',
      );
    });
    expect(activationFor(id)).toBe(ScopeActivation.OnDemand);
  });

  it('restores the original registration policy after the callback', async () => {
    const id = createDecorator<ITestService>('scopedRegistrationActivationRestored');
    await withScopedRegistrationActivation(ScopeActivation.OnDemand, async () => {});
    registerScopedService(
      LifecycleScope.Agent,
      id,
      TestService,
      ScopeActivation.OnScopeCreated,
      'test',
    );
    expect(activationFor(id)).toBe(ScopeActivation.OnScopeCreated);
  });

  it('applies the innermost nested override and restores the outer override', async () => {
    const outer = createDecorator<ITestService>('scopedRegistrationOuter');
    const inner = createDecorator<ITestService>('scopedRegistrationInner');
    await withScopedRegistrationActivation(ScopeActivation.OnDemand, async () => {
      await withScopedRegistrationActivation(ScopeActivation.OnScopeCreated, async () => {
        registerScopedService(
          LifecycleScope.Agent,
          inner,
          TestService,
          ScopeActivation.OnDemand,
          'inner',
        );
      });
      registerScopedService(
        LifecycleScope.Agent,
        outer,
        TestService,
        ScopeActivation.OnScopeCreated,
        'outer',
      );
    });
    expect(activationFor(inner)).toBe(ScopeActivation.OnScopeCreated);
    expect(activationFor(outer)).toBe(ScopeActivation.OnDemand);
  });
});
