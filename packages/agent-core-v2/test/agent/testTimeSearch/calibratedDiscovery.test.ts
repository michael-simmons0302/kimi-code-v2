import { describe, expect, it } from 'vitest';

import { calibratedDiscoveryInformationGain } from '#/agent/testTimeSearch/calibratedDiscovery';

describe('calibratedDiscoveryInformationGain', () => {
  it('weights finite-ensemble information gain by posterior and calibration', () => {
    const calibration = {
      informationGainMultiplier: (_family: string, lineage: string) =>
        lineage === 'accurate' ? 1 : 0.5,
      promotionEligible: (_family: string, lineage: string) => lineage === 'accurate',
    };
    const result = calibratedDiscoveryInformationGain(
      [
        {
          evaluatorFamily: 'typecheck',
          modelLineage: 'accurate',
          posteriorWeight: 0.75,
          informationGain: 1,
          effectiveSampleSize: 4,
        },
        {
          evaluatorFamily: 'typecheck',
          modelLineage: 'shifted',
          posteriorWeight: 0.25,
          informationGain: 1,
          effectiveSampleSize: 4,
        },
      ],
      calibration,
    );
    expect(result.contributions[0]).toMatchObject({
      posteriorWeight: 0.75,
      finiteEnsembleInformationGain: 0.5,
      calibrationMultiplier: 1,
      calibratedInformationGain: 0.375,
      promotionEligible: true,
    });
    expect(result.contributions[1]).toMatchObject({
      posteriorWeight: 0.25,
      finiteEnsembleInformationGain: 0.5,
      calibrationMultiplier: 0.5,
      calibratedInformationGain: 0.0625,
      promotionEligible: false,
    });
    expect(result.informationGain).toBeCloseTo(0.4375);
    expect(result.promotionEligible).toBe(false);
  });

  it('uses uniform posterior weights when all supplied weights are invalid', () => {
    const result = calibratedDiscoveryInformationGain(
      [
        {
          evaluatorFamily: 'typecheck',
          modelLineage: 'a',
          posteriorWeight: 0,
          informationGain: 1,
          effectiveSampleSize: 4,
        },
        {
          evaluatorFamily: 'typecheck',
          modelLineage: 'b',
          posteriorWeight: Number.NaN,
          informationGain: 1,
          effectiveSampleSize: 4,
        },
      ],
      {
        informationGainMultiplier: () => 1,
        promotionEligible: () => true,
      },
    );
    expect(result.contributions.map((entry) => entry.posteriorWeight)).toEqual([0.5, 0.5]);
    expect(result.informationGain).toBeCloseTo(0.5);
    expect(result.promotionEligible).toBe(true);
  });

  it('returns an ineligible zero result for an empty ensemble', () => {
    expect(
      calibratedDiscoveryInformationGain([], {
        informationGainMultiplier: () => 1,
        promotionEligible: () => true,
      }),
    ).toEqual({ informationGain: 0, promotionEligible: false, contributions: [] });
  });

  it('rejects invalid information-gain inputs', () => {
    expect(() =>
      calibratedDiscoveryInformationGain(
        [
          {
            evaluatorFamily: 'typecheck',
            modelLineage: 'lineage',
            posteriorWeight: 1,
            informationGain: -1,
            effectiveSampleSize: 4,
          },
        ],
        {
          informationGainMultiplier: () => 1,
          promotionEligible: () => true,
        },
      ),
    ).toThrow('non-negative');
  });
});
