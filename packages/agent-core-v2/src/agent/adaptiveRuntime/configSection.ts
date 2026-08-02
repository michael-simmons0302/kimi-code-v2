import { z } from 'zod';

import { registerConfigSection } from '#/app/config/configSectionContributions';
import { plainObjectToToml, transformPlainObject } from '#/app/config/toml';

export const ADAPTIVE_SECTION = 'adaptive';

const PositiveInteger = z.number().int().positive();
const NonNegativeInteger = z.number().int().min(0);
const Probability = z.number().min(0).max(1);

export const AdaptiveModelRolesSchema = z.object({
  proposal: z.string().min(1).optional(),
  repair: z.string().min(1).optional(),
  evaluationDesign: z.string().min(1).optional(),
  actionProposal: z.string().min(1).optional(),
  trajectoryCompression: z.string().min(1).optional(),
  policyValue: z.string().min(1).optional(),
  finalResponsePlanning: z.string().min(1).optional(),
  finalClaimVerification: z.string().min(1).optional(),
}).strict().prefault({});

export const AdaptiveBudgetSchema = z.object({
  maxInternalRequests: PositiveInteger.default(128),
  maxEvaluations: PositiveInteger.default(128),
  maxStochasticReplicates: PositiveInteger.default(32),
  maxToolCalls: PositiveInteger.default(256),
  maxInputTokens: PositiveInteger.default(2_000_000),
  maxOutputTokens: PositiveInteger.default(500_000),
  maxWallMs: PositiveInteger.default(3_600_000),
  maxCpuMs: PositiveInteger.default(14_400_000),
  maxDiskBytes: PositiveInteger.default(20 * 1024 * 1024 * 1024),
  maxCandidates: PositiveInteger.default(256),
}).strict().prefault({});

export const AdaptiveEvaluationSchema = z.object({
  maximumParallel: PositiveInteger.default(4),
  minimumReplicates: PositiveInteger.default(3),
  maximumReplicates: PositiveInteger.default(32),
  confidenceLevel: z.number().gt(0.5).lt(1).default(0.95),
  targetBooleanHalfWidth: z.number().gt(0).lt(0.5).default(0.08),
  targetScalarRelativeHalfWidth: z.number().gt(0).default(0.08),
  deterministicCache: z.boolean().default(true),
  confirmationReserveFraction: z.number().min(0.05).max(0.5).default(0.2),
  timeoutOverridesMs: z.record(z.string().min(1), PositiveInteger).default({}),
}).strict().prefault({});

export const AdaptiveWorldModelSchema = z.object({
  minimumPopulation: PositiveInteger.default(3),
  maximumPopulation: PositiveInteger.default(64),
  memoryLimitMb: PositiveInteger.default(512),
  cpuMs: PositiveInteger.default(5_000),
  wallMs: PositiveInteger.default(10_000),
  outputBytes: PositiveInteger.default(4 * 1024 * 1024),
  maximumSimulationDepth: PositiveInteger.default(64),
  minimumPosteriorWeightForFrontier: Probability.default(0.005),
  minimumEffectiveSampleSize: z.number().min(1).default(2.5),
}).strict().prefault({});

export const AdaptiveSearchSchema = z.object({
  cPuct: z.number().positive().default(1.5),
  maximumDepth: PositiveInteger.default(16),
  maximumNodes: PositiveInteger.default(512),
  maximumChanceOutcomes: PositiveInteger.max(64).default(16),
  budgetBucketPercent: PositiveInteger.max(100).default(2),
  progressiveWideningK: z.number().positive().default(2),
  progressiveWideningAlpha: z.number().gt(0).lte(1).default(0.5),
  minimumDiscoveryTemperature: z.number().gt(0).lte(1).default(0.5),
  defaultDiscoveryTemperature: z.number().gt(0).lte(1).default(0.75),
  maximumDiscoveryTemperature: z.number().gt(0).lte(1).default(1),
  minimumDiscoveryWeight: Probability.default(0.05),
  initialDiscoveryWeight: Probability.default(0.3),
  maximumDiscoveryWeight: Probability.default(0.6),
  discoveryBonusCapFraction: Probability.default(0.3),
  actionCategoryMaximumFraction: z.number().gt(0).lte(1).default(0.5),
}).strict().prefault({});

export const AdaptiveEvolutionSchema = z.object({
  maximumCandidatesPerRequest: PositiveInteger.default(16),
  maximumParseRepairAttempts: z.number().int().min(0).max(3).default(1),
  maximumSourceBytes: PositiveInteger.default(1024 * 1024),
  archiveMaximumCandidates: PositiveInteger.default(10_000),
  islandCount: PositiveInteger.default(8),
  migrationInterval: PositiveInteger.default(50),
  protectedPromotionWindows: PositiveInteger.default(2),
}).strict().prefault({});

export const AdaptiveSandboxSchema = z.object({
  backend: z.enum(['auto', 'linux-bwrap', 'windows-wsl-bwrap', 'mac-oci']).default('auto'),
  wallMs: PositiveInteger.default(10 * 60 * 1000),
  cpuSeconds: PositiveInteger.default(300),
  memoryBytes: PositiveInteger.default(2 * 1024 * 1024 * 1024),
  processCount: PositiveInteger.default(128),
  fileBytes: PositiveInteger.default(512 * 1024 * 1024),
  writtenBytes: PositiveInteger.default(2 * 1024 * 1024 * 1024),
  outputBytes: PositiveInteger.default(64 * 1024 * 1024),
  networkBytes: PositiveInteger.default(64 * 1024 * 1024),
  retainFailedWorkspaces: z.boolean().default(true),
}).strict().prefault({});

export const AdaptiveMemorySchema = z.object({
  activeContextTokens: PositiveInteger.default(16_384),
  maximumActiveSummaries: PositiveInteger.default(64),
  preserveExactDiagnostics: z.boolean().default(true),
  preserveDecisiveCounterexamples: z.boolean().default(true),
  maximumSummaryTokens: PositiveInteger.default(2_048),
}).strict().prefault({});

export const AdaptiveSignalsSchema = z.object({
  queueCapacity: PositiveInteger.default(10_000),
  coalesceThresholdFraction: z.number().gt(0).lt(1).default(0.8),
  fileDebounceMs: NonNegativeInteger.default(100),
  maximumConflictSuggestions: PositiveInteger.default(16),
}).strict().prefault({});

export const AdaptiveConfigSchema = z.object({
  enabledByDefault: z.literal(false).default(false),
  models: AdaptiveModelRolesSchema,
  budget: AdaptiveBudgetSchema,
  evaluation: AdaptiveEvaluationSchema,
  worldModel: AdaptiveWorldModelSchema,
  search: AdaptiveSearchSchema,
  evolution: AdaptiveEvolutionSchema,
  sandbox: AdaptiveSandboxSchema,
  memory: AdaptiveMemorySchema,
  signals: AdaptiveSignalsSchema,
}).strict().superRefine((value, context) => {
  if (value.evaluation.maximumReplicates < value.evaluation.minimumReplicates) {
    context.addIssue({
      code: 'custom',
      path: ['evaluation', 'maximumReplicates'],
      message: 'maximumReplicates must be greater than or equal to minimumReplicates.',
    });
  }
  if (value.worldModel.minimumPopulation < 3) {
    context.addIssue({
      code: 'custom',
      path: ['worldModel', 'minimumPopulation'],
      message: 'minimumPopulation must be at least 3 for epistemic discovery.',
    });
  }
  if (value.worldModel.maximumPopulation < value.worldModel.minimumPopulation) {
    context.addIssue({
      code: 'custom',
      path: ['worldModel', 'maximumPopulation'],
      message: 'maximumPopulation must be greater than or equal to minimumPopulation.',
    });
  }
  if (
    value.search.minimumDiscoveryTemperature > value.search.defaultDiscoveryTemperature ||
    value.search.defaultDiscoveryTemperature > value.search.maximumDiscoveryTemperature
  ) {
    context.addIssue({
      code: 'custom',
      path: ['search', 'defaultDiscoveryTemperature'],
      message: 'Discovery temperatures must satisfy minimum <= default <= maximum.',
    });
  }
  if (
    value.search.minimumDiscoveryWeight > value.search.initialDiscoveryWeight ||
    value.search.initialDiscoveryWeight > value.search.maximumDiscoveryWeight
  ) {
    context.addIssue({
      code: 'custom',
      path: ['search', 'initialDiscoveryWeight'],
      message: 'Discovery weights must satisfy minimum <= initial <= maximum.',
    });
  }
  if (value.search.maximumNodes < value.search.maximumDepth + 1) {
    context.addIssue({
      code: 'custom',
      path: ['search', 'maximumNodes'],
      message: 'maximumNodes must be large enough to represent one complete search path.',
    });
  }
  if (value.budget.maxStochasticReplicates < value.evaluation.maximumReplicates) {
    context.addIssue({
      code: 'custom',
      path: ['budget', 'maxStochasticReplicates'],
      message: 'The global stochastic replicate budget must cover one maximum-size evaluation.',
    });
  }
  if (value.sandbox.writtenBytes > value.budget.maxDiskBytes) {
    context.addIssue({
      code: 'custom',
      path: ['sandbox', 'writtenBytes'],
      message: 'Sandbox writtenBytes cannot exceed the global adaptive disk budget.',
    });
  }
  if (value.evolution.maximumCandidatesPerRequest > value.budget.maxCandidates) {
    context.addIssue({
      code: 'custom',
      path: ['evolution', 'maximumCandidatesPerRequest'],
      message: 'maximumCandidatesPerRequest cannot exceed the global candidate budget.',
    });
  }
  if (value.memory.maximumSummaryTokens > value.memory.activeContextTokens) {
    context.addIssue({
      code: 'custom',
      path: ['memory', 'maximumSummaryTokens'],
      message: 'maximumSummaryTokens cannot exceed activeContextTokens.',
    });
  }
});

export type AdaptiveConfig = z.infer<typeof AdaptiveConfigSchema>;
export type AdaptiveModelRoles = z.infer<typeof AdaptiveModelRolesSchema>;

export const DEFAULT_ADAPTIVE_CONFIG: AdaptiveConfig = AdaptiveConfigSchema.parse({});

export interface ResolvedAdaptiveModelRoles {
  readonly proposal: string;
  readonly repair: string;
  readonly evaluationDesign: string;
  readonly actionProposal: string;
  readonly trajectoryCompression: string;
  readonly policyValue: string;
  readonly finalResponsePlanning: string;
  readonly finalClaimVerification: string;
}

export function resolveAdaptiveModelRoles(
  roles: AdaptiveModelRoles,
  primaryModel: string,
): ResolvedAdaptiveModelRoles {
  if (primaryModel.trim().length === 0) {
    throw new Error('The primary model identifier cannot be empty.');
  }
  return {
    proposal: roles.proposal ?? primaryModel,
    repair: roles.repair ?? primaryModel,
    evaluationDesign: roles.evaluationDesign ?? primaryModel,
    actionProposal: roles.actionProposal ?? primaryModel,
    trajectoryCompression: roles.trajectoryCompression ?? primaryModel,
    policyValue: roles.policyValue ?? primaryModel,
    finalResponsePlanning: roles.finalResponsePlanning ?? primaryModel,
    finalClaimVerification: roles.finalClaimVerification ?? primaryModel,
  };
}

export const adaptiveConfigFromToml = (rawSnake: unknown): unknown =>
  transformPlainObject(rawSnake);

export const adaptiveConfigToToml = (value: unknown, rawSnake: unknown): unknown => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  return plainObjectToToml(value as Record<string, unknown>, rawSnake);
};

registerConfigSection(ADAPTIVE_SECTION, AdaptiveConfigSchema, {
  fromToml: adaptiveConfigFromToml,
  toToml: adaptiveConfigToToml,
});
