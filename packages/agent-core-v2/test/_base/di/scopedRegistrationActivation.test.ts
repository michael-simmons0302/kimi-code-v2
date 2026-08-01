import { describe, expect, it } from 'vitest';

import { createDecorator } from '#/_base/di/instantiation';
import {
  LifecycleScope,
  ScopeActivation,
  _clearScopedRegistryForTests,
  getScopedServiceDescriptors,
  registerScopedService,
  withScopedRegistrationActivation,
} from '#/_base/di/scope';

interface ITestService { readonly _serviceBrand: undefined }
const ITestService = createDecorator<ITestService>('scopedRegistrationActivationTest');
class TestService implements ITestService { declare readonly _serviceBrand: undefined }

describe('withScopedRegistrationActivation', () => {
  it('forces registrations inside the callback to the requested activation', async () => {
    _clearScopedRegistryForTests();
    await withScopedRegistrationActivation(ScopeActivation.OnDemand, async () => {
      registerScopedService(
        LifecycleScope.Agent,
        ITestService,
        TestService,
        ScopeActivation.OnScopeCreated,
        'test',
      );
    });
    expect(getScopedServiceDescriptors(LifecycleScope.Agent)).toEqual([
      expect.objectContaining({ activation: ScopeActivation.OnDemand }),
    ]);
  });

  it('restores the original registration policy after the callback', async () => {
    _clearScopedRegistryForTests();
    await withScopedRegistrationActivation(ScopeActivation.OnDemand, async () => {});
    registerScopedService(
      LifecycleScope.Agent,
      ITestService,
      TestService,
      ScopeActivation.OnScopeCreated,
      'test',
    );
    expect(getScopedServiceDescriptors(LifecycleScope.Agent)[0]?.activation).toBe(
      ScopeActivation.OnScopeCreated,
    );
  });

  it('applies the innermost nested override and restores the outer override', async () => {
    _clearScopedRegistryForTests();
    const IOuter = createDecorator<ITestService>('scopedRegistrationOuter');
    const IInner = createDecorator<ITestService>('scopedRegistrationInner');
    await withScopedRegistrationActivation(ScopeActivation.OnDemand, async () => {
      await withScopedRegistrationActivation(ScopeActivation.OnScopeCreated, async () => {
        registerScopedService(
          LifecycleScope.Agent,
          IInner,
          TestService,
          ScopeActivation.OnDemand,
          'inner',
        );
      });
      registerScopedService(
        LifecycleScope.Agent,
        IOuter,
        TestService,
        ScopeActivation.OnScopeCreated,
        'outer',
      );
    });
    const entries = getScopedServiceDescriptors(LifecycleScope.Agent);
    expect(entries.find((entry) => entry.id === IInner)?.activation).toBe(
      ScopeActivation.OnScopeCreated,
    );
    expect(entries.find((entry) => entry.id === IOuter)?.activation).toBe(
      ScopeActivation.OnDemand,
    );
  });
});
