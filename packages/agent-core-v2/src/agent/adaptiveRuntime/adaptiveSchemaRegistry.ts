import { z } from 'zod';

import {
  ADAPTIVE_ARCHITECTURE_VERSION,
  ADAPTIVE_EVIDENCE_GRAPH_PROTOCOL,
  ADAPTIVE_LEDGER_PROTOCOL,
  ADAPTIVE_PROMPT_PROTOCOL,
  ADAPTIVE_PROTOCOL_REGISTRY,
  BENCHMARK_MANIFEST_PROTOCOL,
  CANDIDATE_WORKSPACE_PROTOCOL,
  CAUSAL_RULE_PROTOCOL,
  CODE_STRUCTURE_GRAPH_PROTOCOL,
  EVALUATION_RESULT_PROTOCOL,
  EVALUATION_SANDBOX_PROTOCOL,
  EVALUATION_SPEC_PROTOCOL,
  PROGRAM_ARCHIVE_PROTOCOL,
  SEARCH_CHECKPOINT_PROTOCOL,
  STRUCTURAL_SIGNALS_PROTOCOL,
  WORLD_MODEL_PROTOCOL,
  WORLD_MODEL_STORE_PROTOCOL,
} from './adaptiveProtocol';

export type AdaptiveProtocolName = keyof typeof ADAPTIVE_PROTOCOL_REGISTRY;
export type AdaptiveProtocolValue = (typeof ADAPTIVE_PROTOCOL_REGISTRY)[AdaptiveProtocolName];

export const AdaptiveUuidSchema = z.string().uuid();
export const AdaptiveHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const AdaptiveIdentifierSchema = z.string().min(1).max(512);
export const AdaptiveSequenceSchema = z.number().int().nonnegative();

export const AdaptivePhaseSchema = z.enum([
  'inactive',
  'initializing',
  'indexing',
  'discovering',
  'modeling',
  'evaluating',
  'planning',
  'acting',
  'reconciling',
  'committing',
  'completed',
  'blocked',
  'cancelled',
  'budget-exhausted',
  'infrastructure-failed',
  'evidence-corrupted',
  'no-viable-model',
  'commit-rejected',
]);

export const AdaptiveCostSchema = z.object({
  internalRequests: z.number().int().nonnegative(),
  evaluations: z.number().int().nonnegative(),
  stochasticReplicates: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  wallMs: z.number().nonnegative(),
  cpuMs: z.number().nonnegative(),
  diskBytes: z.number().int().nonnegative(),
}).strict();

export const AdaptiveBudgetSchema = z.object({
  maxInternalRequests: z.number().int().positive(),
  maxEvaluations: z.number().int().positive(),
  maxStochasticReplicates: z.number().int().positive(),
  maxToolCalls: z.number().int().positive(),
  maxInputTokens: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  maxWallMs: z.number().positive(),
  maxCpuMs: z.number().positive(),
  maxDiskBytes: z.number().int().positive(),
  maxCandidates: z.number().int().positive(),
}).strict();

export const AdaptiveStatusSnapshotSchema = z.object({
  runId: AdaptiveUuidSchema,
  phase: AdaptivePhaseSchema,
  evaluationsCompleted: z.number().int().nonnegative(),
  evaluationsActive: z.number().int().nonnegative(),
  viableModels: z.number().int().nonnegative(),
  openConflicts: z.number().int().nonnegative(),
  normalizedPosteriorEntropy: z.number().min(0).max(1),
  decisionWeightedUncertainty: z.number().nonnegative(),
  remainingBudgetFraction: z.number().min(0).max(1),
  verifiedCandidates: z.number().int().nonnegative(),
}).strict();

export interface AdaptiveSchemaRegistration<TOutput = unknown> {
  readonly protocol: AdaptiveProtocolValue | string;
  readonly schema: z.ZodType<TOutput>;
  readonly description: string;
  readonly persisted: boolean;
  readonly rpcVisible: boolean;
}

class AdaptiveSchemaRegistry {
  private readonly registrations = new Map<string, AdaptiveSchemaRegistration>();

  register<TOutput>(registration: AdaptiveSchemaRegistration<TOutput>): void {
    if (registration.protocol.trim().length === 0) {
      throw new Error('Adaptive schema protocol cannot be empty.');
    }
    if (registration.description.trim().length === 0) {
      throw new Error(`Adaptive schema description cannot be empty: ${registration.protocol}`);
    }
    if (this.registrations.has(registration.protocol)) {
      throw new Error(`Adaptive schema is already registered: ${registration.protocol}`);
    }
    this.registrations.set(registration.protocol, registration);
  }

  get(protocol: string): AdaptiveSchemaRegistration {
    const registration = this.registrations.get(protocol);
    if (registration === undefined) {
      throw new Error(`Adaptive schema is not registered: ${protocol}`);
    }
    return registration;
  }

  parse<TOutput>(protocol: string, value: unknown): TOutput {
    return this.get(protocol).schema.parse(value) as TOutput;
  }

  safeParse(protocol: string, value: unknown): z.SafeParseReturnType<unknown, unknown> {
    return this.get(protocol).schema.safeParse(value);
  }

  list(): readonly AdaptiveSchemaRegistration[] {
    return [...this.registrations.values()].sort((left, right) =>
      left.protocol.localeCompare(right.protocol),
    );
  }
}

export const adaptiveSchemaRegistry = new AdaptiveSchemaRegistry();

export function registerAdaptiveSchema<TOutput>(
  registration: AdaptiveSchemaRegistration<TOutput>,
): void {
  adaptiveSchemaRegistry.register(registration);
}

const ProtocolHeader = <TProtocol extends string>(protocol: TProtocol) =>
  z.object({ protocol: z.literal(protocol) }).passthrough();

const registrations = [
  {
    protocol: ADAPTIVE_ARCHITECTURE_VERSION,
    description: 'Adaptive architecture version marker.',
    persisted: true,
    rpcVisible: true,
  },
  {
    protocol: ADAPTIVE_LEDGER_PROTOCOL,
    description: 'Immutable adaptive evidence ledger record or head.',
    persisted: true,
    rpcVisible: false,
  },
  {
    protocol: ADAPTIVE_EVIDENCE_GRAPH_PROTOCOL,
    description: 'Evidence graph snapshot, node, or link.',
    persisted: true,
    rpcVisible: true,
  },
  {
    protocol: EVALUATION_SPEC_PROTOCOL,
    description: 'Evaluation request specification.',
    persisted: true,
    rpcVisible: true,
  },
  {
    protocol: EVALUATION_RESULT_PROTOCOL,
    description: 'Evaluation result and evidence summary.',
    persisted: true,
    rpcVisible: true,
  },
  {
    protocol: CODE_STRUCTURE_GRAPH_PROTOCOL,
    description: 'Code-structure graph snapshot.',
    persisted: true,
    rpcVisible: true,
  },
  {
    protocol: STRUCTURAL_SIGNALS_PROTOCOL,
    description: 'Structural signal and reducer state.',
    persisted: true,
    rpcVisible: true,
  },
  {
    protocol: CAUSAL_RULE_PROTOCOL,
    description: 'Causal-rule graph record or snapshot.',
    persisted: true,
    rpcVisible: true,
  },
  {
    protocol: WORLD_MODEL_PROTOCOL,
    description: 'Executable world-model manifest.',
    persisted: true,
    rpcVisible: true,
  },
  {
    protocol: WORLD_MODEL_STORE_PROTOCOL,
    description: 'Executable world-model population and belief store.',
    persisted: true,
    rpcVisible: true,
  },
  {
    protocol: SEARCH_CHECKPOINT_PROTOCOL,
    description: 'Belief-state search checkpoint.',
    persisted: true,
    rpcVisible: true,
  },
  {
    protocol: ADAPTIVE_PROMPT_PROTOCOL,
    description: 'Adaptive prompt trace and immutable prompt identity.',
    persisted: true,
    rpcVisible: true,
  },
  {
    protocol: CANDIDATE_WORKSPACE_PROTOCOL,
    description: 'Frozen candidate workspace baseline and materialization.',
    persisted: true,
    rpcVisible: false,
  },
  {
    protocol: EVALUATION_SANDBOX_PROTOCOL,
    description: 'Secure sandbox request and result.',
    persisted: true,
    rpcVisible: false,
  },
  {
    protocol: PROGRAM_ARCHIVE_PROTOCOL,
    description: 'Program-evolution archive and lineage state.',
    persisted: true,
    rpcVisible: true,
  },
  {
    protocol: BENCHMARK_MANIFEST_PROTOCOL,
    description: 'Locked benchmark and promotion manifest.',
    persisted: true,
    rpcVisible: true,
  },
] as const;

for (const registration of registrations) {
  registerAdaptiveSchema({
    ...registration,
    schema: ProtocolHeader(registration.protocol),
  });
}

export function assertAdaptiveProtocolCoverage(): void {
  const registered = new Set(
    adaptiveSchemaRegistry.list().map((registration) => registration.protocol),
  );
  const missing = Object.values(ADAPTIVE_PROTOCOL_REGISTRY).filter(
    (protocol) => !registered.has(protocol),
  );
  if (missing.length > 0) {
    throw new Error(`Adaptive protocols lack runtime schemas: ${missing.join(', ')}`);
  }
}

assertAdaptiveProtocolCoverage();
