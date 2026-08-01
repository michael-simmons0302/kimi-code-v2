import { describe, expect, it, vi } from 'vitest';

import type { IInstantiationService } from '#/_base/di/instantiation';
import {
  AgentAdaptiveCoordinatorFacade,
  type IAgentAdaptiveCoordinatorService,
} from '#/agent/adaptiveRuntime/adaptiveCoordinator';
import {
  AgentAdaptiveFinalResponseGateFacade,
  type IAgentAdaptiveFinalResponseGateService,
} from '#/agent/adaptiveRuntime/adaptiveFinalResponseGateService';
import {
  AgentAdaptiveRuntimeFacade,
  type IAgentAdaptiveRuntimeService,
} from '#/agent/adaptiveRuntime/adaptiveRuntime';
import type { IBootstrapService } from '#/app/bootstrap/bootstrap';

function bootstrap(mode: 'disabled' | 'enabled'): IBootstrapService {
  return {
    args: { adaptiveMode: mode },
  } as unknown as IBootstrapService;
}

function instantiation<T>(value: T) {
  const invokeFunction = vi.fn((callback: (accessor: { get(): T }) => T) =>
    callback({ get: () => value }),
  );
  return {
    service: { invokeFunction } as unknown as IInstantiationService,
    invokeFunction,
  };
}

describe('bootstrap-aware adaptive facades', () => {
  it('keeps disabled runtime completely inert without resolving implementation', () => {
    const actual = {
      _serviceBrand: undefined,
      enabled: () => true,
    } as unknown as IAgentAdaptiveRuntimeService;
    const di = instantiation(actual);
    const facade = new AgentAdaptiveRuntimeFacade(bootstrap('disabled'), di.service);
    expect(facade.enabled()).toBe(false);
    expect(facade.phase()).toBe('inactive');
    expect(facade.ensureRun()).toBeUndefined();
    expect(facade.status()).toBeUndefined();
    expect(di.invokeFunction).not.toHaveBeenCalled();
  });

  it('resolves enabled runtime once and delegates all subsequent reads', () => {
    const actual = {
      _serviceBrand: undefined,
      enabled: () => true,
      runId: () => 'run',
      ensureRun: () => 'run',
      phase: () => 'planning',
      promptPhase: () => 'evaluation-selection',
      status: () => ({ phase: 'planning' }),
      transition: vi.fn(),
      update: vi.fn(),
      complete: vi.fn(),
      fail: vi.fn(),
    } as unknown as IAgentAdaptiveRuntimeService;
    const di = instantiation(actual);
    const facade = new AgentAdaptiveRuntimeFacade(bootstrap('enabled'), di.service);
    expect(facade.enabled()).toBe(true);
    expect(facade.phase()).toBe('planning');
    expect(facade.runId()).toBe('run');
    expect(facade.promptPhase()).toBe('evaluation-selection');
    expect(di.invokeFunction).toHaveBeenCalledTimes(1);
  });

  it('keeps disabled coordinator inert and returns an ordinary continuation decision', async () => {
    const actual = {
      _serviceBrand: undefined,
      prepareStep: vi.fn(),
      observeStep: vi.fn(),
      flush: vi.fn(),
    } as unknown as IAgentAdaptiveCoordinatorService;
    const di = instantiation(actual);
    const facade = new AgentAdaptiveCoordinatorFacade(bootstrap('disabled'), di.service);
    await facade.prepareStep({} as never);
    await expect(facade.observeStep({} as never)).resolves.toEqual({
      stopTurn: false,
      continueTurn: false,
    });
    await facade.flush();
    expect(di.invokeFunction).not.toHaveBeenCalled();
  });

  it('resolves enabled coordinator once and delegates prepare, observe, and flush', async () => {
    const actual = {
      _serviceBrand: undefined,
      prepareStep: vi.fn(async () => {}),
      observeStep: vi.fn(async () => ({ stopTurn: false, continueTurn: true })),
      flush: vi.fn(async () => {}),
    } as unknown as IAgentAdaptiveCoordinatorService;
    const di = instantiation(actual);
    const facade = new AgentAdaptiveCoordinatorFacade(bootstrap('enabled'), di.service);
    await facade.prepareStep({} as never);
    await expect(facade.observeStep({} as never)).resolves.toEqual({
      stopTurn: false,
      continueTurn: true,
    });
    await facade.flush();
    expect(actual.prepareStep).toHaveBeenCalledTimes(1);
    expect(actual.observeStep).toHaveBeenCalledTimes(1);
    expect(actual.flush).toHaveBeenCalledTimes(1);
    expect(di.invokeFunction).toHaveBeenCalledTimes(1);
  });

  it('keeps disabled final-response verification inert', async () => {
    const actual = {
      _serviceBrand: undefined,
      allowCoordinatorPreparation: () => false,
      verifyAfterStep: vi.fn(),
    } as unknown as IAgentAdaptiveFinalResponseGateService;
    const di = instantiation(actual);
    const facade = new AgentAdaptiveFinalResponseGateFacade(
      bootstrap('disabled'),
      di.service,
    );
    expect(facade.allowCoordinatorPreparation()).toBe(true);
    await expect(facade.verifyAfterStep()).resolves.toEqual({
      kind: 'not-applicable',
    });
    expect(di.invokeFunction).not.toHaveBeenCalled();
  });

  it('resolves enabled final-response verifier once', async () => {
    const actual = {
      _serviceBrand: undefined,
      allowCoordinatorPreparation: () => false,
      verifyAfterStep: vi.fn(async () => ({ kind: 'verified', verification: {} })),
    } as unknown as IAgentAdaptiveFinalResponseGateService;
    const di = instantiation(actual);
    const facade = new AgentAdaptiveFinalResponseGateFacade(
      bootstrap('enabled'),
      di.service,
    );
    expect(facade.allowCoordinatorPreparation()).toBe(false);
    await expect(facade.verifyAfterStep()).resolves.toMatchObject({ kind: 'verified' });
    expect(di.invokeFunction).toHaveBeenCalledTimes(1);
  });
});
