import { describe, expect, it } from 'vitest';

import type { IDisposable } from '#/_base/di/lifecycle';
import type { Event } from '#/_base/event';
import type { IBootstrapService } from '#/app/bootstrap/bootstrap';
import type { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import {
  WorldModelCalibrationService,
} from '#/agent/worldModel/worldModelCalibrationService';
import type {
  CalibrationObservationEnvelope,
} from '#/agent/worldModel/worldModelCalibration';

class Documents implements IAtomicDocumentStore {
  declare readonly _serviceBrand: undefined;
  readonly values = new Map<string, unknown>();
  async get<T>(scope: string, key: string): Promise<T | undefined> {
    return this.values.get(`${scope}/${key}`) as T | undefined;
  }
  async set<T>(scope: string, key: string, value: T): Promise<void> {
    this.values.set(`${scope}/${key}`, structuredClone(value));
  }
  async delete(scope: string, key: string): Promise<void> {
    this.values.delete(`${scope}/${key}`);
  }
  async list(scope: string, prefix = ''): Promise<readonly string[]> {
    const start = `${scope}/`;
    return [...this.values.keys()]
      .filter((key) => key.startsWith(start))
      .map((key) => key.slice(start.length))
      .filter((key) => key.startsWith(prefix));
  }
  watch(): Event<void> {
    return () => ({ dispose() {} });
  }
  acquire(): IDisposable {
    return { dispose() {} };
  }
}

const bootstrap = {
  _serviceBrand: undefined,
  scope: (name: string) => name,
} as unknown as IBootstrapService;

function service(documents = new Documents()) {
  return { calibration: new WorldModelCalibrationService(bootstrap, documents), documents };
}

function booleanObservation(
  sequence: number,
  probability: number,
  observed: boolean,
  overrides: Partial<CalibrationObservationEnvelope> = {},
): CalibrationObservationEnvelope {
  return {
    evaluatorFamily: 'typescript.typecheck',
    modelLineage: 'lineage-a',
    split: 'confirmation',
    sequence,
    observation: { kind: 'boolean', probability, observed },
    ...overrides,
  };
}

describe('WorldModelCalibrationService', () => {
  it('is uncalibrated before the minimum evidence count', async () => {
    const { calibration } = service();
    await calibration.record(booleanObservation(1, 0.9, true));
    expect(calibration.metrics('typescript.typecheck', 'lineage-a')).toMatchObject({
      observations: 1,
      status: 'uncalibrated',
      informationGainMultiplier: 0.75,
      promotionEligible: false,
    });
  });

  it('marks accurate predictions calibrated and promotion eligible', async () => {
    const { calibration } = service();
    await calibration.recordMany(
      Array.from({ length: 30 }, (_, index) =>
        booleanObservation(index, index % 2 === 0 ? 0.95 : 0.05, index % 2 === 0),
      ),
    );
    const metrics = calibration.metrics('typescript.typecheck', 'lineage-a');
    expect(metrics.status).toBe('calibrated');
    expect(metrics.promotionEligible).toBe(true);
    expect(metrics.informationGainMultiplier).toBe(1);
    expect(metrics.brierScore).toBeLessThan(0.01);
    expect(metrics.logLoss).toBeLessThan(0.1);
    expect(metrics.reliabilityBins.length).toBeGreaterThan(0);
  });

  it('halves information gain for miscalibrated predictions', async () => {
    const { calibration } = service();
    await calibration.recordMany(
      Array.from({ length: 30 }, (_, index) =>
        booleanObservation(index, 0.7, index % 2 === 0),
      ),
    );
    const metrics = calibration.metrics('typescript.typecheck', 'lineage-a');
    expect(metrics.status).toBe('miscalibrated');
    expect(metrics.informationGainMultiplier).toBe(0.5);
    expect(metrics.promotionEligible).toBe(false);
  });

  it('applies a stronger penalty to severely miscalibrated predictions', async () => {
    const { calibration } = service();
    await calibration.recordMany(
      Array.from({ length: 30 }, (_, index) =>
        booleanObservation(index, 0.99, false),
      ),
    );
    const metrics = calibration.metrics('typescript.typecheck', 'lineage-a');
    expect(metrics.status).toBe('severely-miscalibrated');
    expect(metrics.informationGainMultiplier).toBe(0.25);
    expect(metrics.promotionEligible).toBe(false);
  });

  it('tracks scalar interval coverage', async () => {
    const { calibration } = service();
    await calibration.recordMany(
      Array.from({ length: 20 }, (_, index) => ({
        evaluatorFamily: 'benchmark.scalar',
        modelLineage: 'lineage-a',
        split: 'confirmation' as const,
        sequence: index,
        observation: {
          kind: 'scalar-interval' as const,
          lower: 0,
          upper: 10,
          observed: index < 18 ? 5 : 20,
          confidenceLevel: 0.95,
        },
      })),
    );
    const metrics = calibration.metrics('benchmark.scalar', 'lineage-a');
    expect(metrics.intervalCoverage).toBe(0.9);
    expect(metrics.status).toBe('calibrated');
  });

  it('normalizes categorical predictions and scores the observed category', async () => {
    const { calibration } = service();
    await calibration.recordMany(
      Array.from({ length: 20 }, (_, index) => ({
        evaluatorFamily: 'runtime.category',
        modelLineage: 'lineage-a',
        split: 'confirmation' as const,
        sequence: index,
        observation: {
          kind: 'categorical' as const,
          probabilities: index % 2 === 0 ? { pass: 9, fail: 1 } : { pass: 1, fail: 9 },
          observedCategory: index % 2 === 0 ? 'pass' : 'fail',
        },
      })),
    );
    const metrics = calibration.metrics('runtime.category', 'lineage-a');
    expect(metrics.status).toBe('calibrated');
    expect(metrics.brierScore).toBeLessThan(0.02);
  });

  it('detects a recent calibration regime shift', async () => {
    const { calibration } = service();
    const stable = Array.from({ length: 20 }, (_, index) =>
      booleanObservation(index, 0.95, true),
    );
    const shifted = Array.from({ length: 20 }, (_, offset) =>
      booleanObservation(20 + offset, 0.95, false),
    );
    await calibration.recordMany([...stable, ...shifted]);
    const metrics = calibration.metrics('typescript.typecheck', 'lineage-a');
    expect(metrics.regimeShift).toBe(true);
    expect(metrics.informationGainMultiplier).toBeLessThanOrEqual(0.5);
    expect(metrics.promotionEligible).toBe(false);
  });

  it('replaces held-out calibration evidence for the selected key only', async () => {
    const { calibration } = service();
    await calibration.record(booleanObservation(1, 0.9, true, { split: 'adaptation' }));
    await calibration.recalibrateHeldOut(
      'typescript.typecheck',
      'lineage-a',
      Array.from({ length: 20 }, (_, index) =>
        booleanObservation(100 + index, 0.95, true, { split: 'held-out' }),
      ),
    );
    await calibration.recalibrateHeldOut(
      'typescript.typecheck',
      'lineage-a',
      Array.from({ length: 20 }, (_, index) =>
        booleanObservation(200 + index, 0.95, false, { split: 'held-out' }),
      ),
    );
    expect(calibration.snapshot().observations).toHaveLength(21);
    expect(calibration.metrics('typescript.typecheck', 'lineage-a').promotionEligible).toBe(false);
  });

  it('persists observations across service reconstruction', async () => {
    const first = service();
    await first.calibration.record(booleanObservation(1, 0.9, true));
    await first.calibration.flush();
    const second = service(first.documents);
    await second.calibration.ready();
    expect(second.calibration.metrics('typescript.typecheck', 'lineage-a').observations).toBe(1);
    expect(second.calibration.snapshot().hash).toBe(first.calibration.snapshot().hash);
  });

  it('rejects duplicate sequence identities and invalid distributions', async () => {
    const { calibration } = service();
    await calibration.record(booleanObservation(1, 0.9, true));
    await expect(calibration.record(booleanObservation(1, 0.8, true))).rejects.toThrow(
      'already exists',
    );
    await expect(
      calibration.record({
        evaluatorFamily: 'runtime.category',
        modelLineage: 'lineage-a',
        split: 'confirmation',
        sequence: 2,
        observation: {
          kind: 'categorical',
          probabilities: { pass: 1 },
          observedCategory: 'pass',
        },
      }),
    ).rejects.toThrow('at least two categories');
  });
});
