import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  ADAPTIVE_PROTOCOL_REGISTRY,
  createAdaptiveRunId,
} from '#/agent/adaptiveRuntime/adaptiveProtocol';
import {
  AdaptiveBudgetSchema,
  AdaptiveCostSchema,
  AdaptivePhaseSchema,
  AdaptiveStatusSnapshotSchema,
  adaptiveSchemaRegistry,
  assertAdaptiveProtocolCoverage,
  registerAdaptiveSchema,
} from '#/agent/adaptiveRuntime/adaptiveSchemaRegistry';

describe('adaptive protocol schema registry', () => {
  it('registers a runtime schema for every locked protocol', () => {
    expect(() => assertAdaptiveProtocolCoverage()).not.toThrow();
    const registered = new Set(
      adaptiveSchemaRegistry.list().map((registration) => registration.protocol),
    );
    expect(registered).toEqual(new Set(Object.values(ADAPTIVE_PROTOCOL_REGISTRY)));
  });

  it('records persistence and RPC visibility metadata', () => {
    const result = adaptiveSchemaRegistry.get('evaluation-result/1');
    expect(result).toMatchObject({
      persisted: true,
      rpcVisible: true,
    });
    expect(result.description.length).toBeGreaterThan(0);
  });

  it('rejects duplicate protocol registration', () => {
    expect(() =>
      registerAdaptiveSchema({
        protocol: 'evaluation-result/1',
        schema: z.object({ protocol: z.literal('evaluation-result/1') }),
        description: 'duplicate',
        persisted: true,
        rpcVisible: true,
      }),
    ).toThrow('already registered');
  });

  it('rejects unknown protocols during parse', () => {
    expect(() => adaptiveSchemaRegistry.parse('unknown/1', {})).toThrow(
      'not registered',
    );
  });

  it('rejects a payload with the wrong protocol header', () => {
    expect(
      adaptiveSchemaRegistry.safeParse('evaluation-result/1', {
        protocol: 'evaluation-spec/1',
      }).success,
    ).toBe(false);
  });

  it('round-trips valid protocol payload headers without deleting fields', () => {
    const value = {
      protocol: 'adaptive-search-checkpoint/1',
      nodeCount: 42,
      rootNodeId: 'root',
    };
    expect(
      adaptiveSchemaRegistry.parse<typeof value>('adaptive-search-checkpoint/1', value),
    ).toEqual(value);
  });
});

describe('shared adaptive runtime schemas', () => {
  it('accepts every legal adaptive phase and rejects invented phases', () => {
    expect(AdaptivePhaseSchema.parse('reconciling')).toBe('reconciling');
    expect(() => AdaptivePhaseSchema.parse('thinking')).toThrow();
  });

  it('validates positive budgets and non-negative costs', () => {
    const budget = AdaptiveBudgetSchema.parse({
      maxInputTokens: 1,
      maxOutputTokens: 1,
      maxToolCalls: 1,
      maxEvaluationRuns: 1,
      maxModelProposalCount: 1,
      maxWallMs: 1,
      maxCpuMs: 1,
      maxDiskBytes: 1,
      maxCandidates: 1,
    });
    expect(budget.maxCandidates).toBe(1);
    expect(() => AdaptiveBudgetSchema.parse({ ...budget, maxCandidates: 0 })).toThrow();

    const cost = AdaptiveCostSchema.parse({
      inputTokens: 0,
      outputTokens: 0,
      toolCalls: 0,
      evaluationRuns: 0,
      modelProposalCount: 0,
      wallMs: 0,
      cpuMs: 0,
      diskBytes: 0,
    });
    expect(cost.diskBytes).toBe(0);
    expect(() => AdaptiveCostSchema.parse({ ...cost, diskBytes: -1 })).toThrow();
  });

  it('validates bounded public status snapshots', () => {
    const status = AdaptiveStatusSnapshotSchema.parse({
      runId: createAdaptiveRunId(),
      phase: 'planning',
      evaluationsCompleted: 2,
      evaluationsActive: 1,
      viableModels: 3,
      openConflicts: 0,
      normalizedPosteriorEntropy: 0.5,
      decisionWeightedUncertainty: 0.25,
      remainingBudgetFraction: 0.75,
      verifiedCandidates: 1,
    });
    expect(status.phase).toBe('planning');
    expect(() =>
      AdaptiveStatusSnapshotSchema.parse({
        ...status,
        normalizedPosteriorEntropy: 2,
      }),
    ).toThrow();
  });
});
