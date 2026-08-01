import { describe, expect, it } from 'vitest';

import {
  AdaptiveConfigSchema,
  DEFAULT_ADAPTIVE_CONFIG,
  adaptiveConfigFromToml,
  adaptiveConfigToToml,
  resolveAdaptiveModelRoles,
} from '#/agent/adaptiveRuntime/configSection';

describe('AdaptiveConfigSchema', () => {
  it('materializes the complete nested default configuration', () => {
    expect(DEFAULT_ADAPTIVE_CONFIG).toMatchObject({
      enabledByDefault: false,
      budget: {
        maxInternalRequests: 128,
        maxEvaluations: 128,
        maxStochasticReplicates: 32,
        maxCandidates: 256,
      },
      evaluation: {
        minimumReplicates: 3,
        maximumReplicates: 32,
        confidenceLevel: 0.95,
      },
      worldModel: {
        minimumPopulation: 3,
        maximumPopulation: 64,
      },
      search: {
        cPuct: 1.5,
        minimumDiscoveryTemperature: 0.5,
        defaultDiscoveryTemperature: 0.75,
        maximumDiscoveryTemperature: 1,
        minimumDiscoveryWeight: 0.05,
        initialDiscoveryWeight: 0.3,
        maximumDiscoveryWeight: 0.6,
      },
      evolution: {
        maximumCandidatesPerRequest: 16,
        maximumParseRepairAttempts: 1,
      },
      sandbox: {
        backend: 'auto',
        retainFailedWorkspaces: true,
      },
      memory: {
        activeContextTokens: 16_384,
        maximumSummaryTokens: 2_048,
      },
      signals: {
        queueCapacity: 10_000,
        fileDebounceMs: 100,
      },
    });
  });

  it('does not permit configuration to enable Evolve mode by default', () => {
    expect(() => AdaptiveConfigSchema.parse({ enabledByDefault: true })).toThrow();
  });

  it('rejects unknown dead configuration', () => {
    expect(() => AdaptiveConfigSchema.parse({ unknownFeature: true })).toThrow();
    expect(() =>
      AdaptiveConfigSchema.parse({ search: { cPuct: 1.5, unusedKnob: 3 } }),
    ).toThrow();
  });

  it.each([
    [
      { evaluation: { minimumReplicates: 8, maximumReplicates: 4 } },
      'maximumReplicates',
    ],
    [
      { worldModel: { minimumPopulation: 2 } },
      'minimumPopulation',
    ],
    [
      { worldModel: { minimumPopulation: 8, maximumPopulation: 4 } },
      'maximumPopulation',
    ],
    [
      {
        search: {
          minimumDiscoveryTemperature: 0.8,
          defaultDiscoveryTemperature: 0.7,
          maximumDiscoveryTemperature: 1,
        },
      },
      'Discovery temperatures',
    ],
    [
      {
        search: {
          minimumDiscoveryWeight: 0.4,
          initialDiscoveryWeight: 0.3,
          maximumDiscoveryWeight: 0.6,
        },
      },
      'Discovery weights',
    ],
    [
      { search: { maximumDepth: 16, maximumNodes: 8 } },
      'maximumNodes',
    ],
    [
      {
        budget: { maxStochasticReplicates: 4 },
        evaluation: { maximumReplicates: 8 },
      },
      'stochastic replicate budget',
    ],
    [
      {
        budget: { maxDiskBytes: 1024 },
        sandbox: { writtenBytes: 2048 },
      },
      'writtenBytes',
    ],
    [
      {
        budget: { maxCandidates: 4 },
        evolution: { maximumCandidatesPerRequest: 8 },
      },
      'maximumCandidatesPerRequest',
    ],
    [
      {
        memory: { activeContextTokens: 1000, maximumSummaryTokens: 2000 },
      },
      'maximumSummaryTokens',
    ],
  ])('rejects invalid cross-field configuration %#', (input, message) => {
    expect(() => AdaptiveConfigSchema.parse(input)).toThrow(String(message));
  });

  it('accepts a valid bounded custom configuration', () => {
    const parsed = AdaptiveConfigSchema.parse({
      budget: {
        maxStochasticReplicates: 16,
        maxCandidates: 32,
        maxDiskBytes: 4 * 1024 * 1024,
      },
      evaluation: {
        minimumReplicates: 4,
        maximumReplicates: 16,
      },
      worldModel: {
        minimumPopulation: 4,
        maximumPopulation: 16,
      },
      search: {
        minimumDiscoveryTemperature: 0.6,
        defaultDiscoveryTemperature: 0.7,
        maximumDiscoveryTemperature: 0.9,
        minimumDiscoveryWeight: 0.1,
        initialDiscoveryWeight: 0.2,
        maximumDiscoveryWeight: 0.4,
      },
      evolution: { maximumCandidatesPerRequest: 8 },
      sandbox: { writtenBytes: 2 * 1024 * 1024 },
      memory: { activeContextTokens: 4096, maximumSummaryTokens: 1024 },
    });
    expect(parsed.worldModel.minimumPopulation).toBe(4);
    expect(parsed.evaluation.maximumReplicates).toBe(16);
  });
});

describe('adaptive model roles', () => {
  it('falls back every unspecified role to the bound primary model', () => {
    expect(resolveAdaptiveModelRoles({}, 'kimi-primary')).toEqual({
      proposal: 'kimi-primary',
      repair: 'kimi-primary',
      evaluationDesign: 'kimi-primary',
      actionProposal: 'kimi-primary',
      trajectoryCompression: 'kimi-primary',
      policyValue: 'kimi-primary',
      finalResponsePlanning: 'kimi-primary',
      finalClaimVerification: 'kimi-primary',
    });
  });

  it('preserves explicit role overrides', () => {
    expect(
      resolveAdaptiveModelRoles(
        { proposal: 'proposal-model', finalClaimVerification: 'verifier-model' },
        'primary',
      ),
    ).toMatchObject({
      proposal: 'proposal-model',
      repair: 'primary',
      finalClaimVerification: 'verifier-model',
    });
  });

  it('rejects an empty primary model identifier', () => {
    expect(() => resolveAdaptiveModelRoles({}, '   ')).toThrow('cannot be empty');
  });
});

describe('adaptive TOML mapping', () => {
  it('maps snake_case TOML input to the typed camelCase schema', () => {
    const camel = adaptiveConfigFromToml({
      enabled_by_default: false,
      world_model: { minimum_population: 4, maximum_population: 12 },
      search: { c_puct: 2, maximum_nodes: 1024 },
    });
    const parsed = AdaptiveConfigSchema.parse(camel);
    expect(parsed.worldModel.minimumPopulation).toBe(4);
    expect(parsed.worldModel.maximumPopulation).toBe(12);
    expect(parsed.search.cPuct).toBe(2);
    expect(parsed.search.maximumNodes).toBe(1024);
  });

  it('maps typed values back to snake_case TOML keys', () => {
    const output = adaptiveConfigToToml(
      AdaptiveConfigSchema.parse({ worldModel: { minimumPopulation: 4 } }),
      {},
    ) as Record<string, unknown>;
    expect(output).toHaveProperty('world_model');
    expect(output).toHaveProperty('enabled_by_default', false);
  });
});
