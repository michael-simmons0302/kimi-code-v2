import { createDecorator } from '#/_base/di/instantiation';
import type { IDisposable } from '#/_base/di/lifecycle';
import type {
  AdaptiveArtifactReference,
  AdaptiveRunId,
  EvaluationId,
  EvaluationReplicateId,
} from '#/agent/adaptiveRuntime/adaptiveProtocol';

export type EvaluationMode = 'deterministic' | 'stochastic';
export type EvaluationSoundness = 'sound' | 'empirical';
export type EvaluationScale =
  | 'expression'
  | 'symbol'
  | 'file'
  | 'module'
  | 'package'
  | 'repository'
  | 'runtime'
  | 'trajectory'
  | 'task-family';
export type EvaluationLevel =
  | 'validity'
  | 'local-correctness'
  | 'composition'
  | 'behavior'
  | 'robustness'
  | 'causal-validity'
  | 'generalization'
  | 'meta-generalization';
export type EvaluationOutcomeFamily = 'boolean' | 'categorical' | 'scalar' | 'structured';
export type EvaluationStatus =
  | 'passed'
  | 'failed'
  | 'inconclusive'
  | 'cancelled'
  | 'budget-exhausted'
  | 'infrastructure-failed';

export interface EvaluationBudget {
  readonly timeoutMs: number;
  readonly maximumReplicates?: number;
  readonly maximumOutputBytes?: number;
}

export interface EvaluationSpec<TInput = unknown> {
  readonly protocol: 'evaluation/1';
  readonly evaluationId: EvaluationId;
  readonly adaptiveRunId?: AdaptiveRunId;
  readonly evaluatorId: string;
  readonly evaluatorVersion?: string;
  readonly input: TInput;
  readonly budget: EvaluationBudget;
  readonly seed?: string;
  readonly tags?: readonly string[];
}

export interface EvaluationAssertionResult {
  readonly assertionId: string;
  readonly passed: boolean;
  readonly message?: string;
  readonly expected?: unknown;
  readonly observed?: unknown;
}

export interface EvaluationReplicate {
  readonly replicateId: EvaluationReplicateId;
  readonly seed?: string;
  readonly status: EvaluationStatus;
  readonly value?: number;
  readonly category?: string;
  readonly artifactRefs: readonly AdaptiveArtifactReference[];
}

export interface EvaluationCost {
  readonly wallMs: number;
  readonly cpuMs?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly outputBytes?: number;
}

export interface EvaluationResult<TOutcome = unknown> {
  readonly protocol: 'evaluation/1';
  readonly evaluationId: EvaluationId;
  readonly evaluatorId: string;
  readonly evaluatorVersion: string;
  readonly mode: EvaluationMode;
  readonly soundness: EvaluationSoundness;
  readonly scale: EvaluationScale;
  readonly level: EvaluationLevel;
  readonly outcomeFamily: EvaluationOutcomeFamily;
  readonly status: EvaluationStatus;
  readonly outcome?: TOutcome;
  readonly assertions: readonly EvaluationAssertionResult[];
  readonly estimate?: number;
  readonly variance?: number;
  readonly confidenceInterval?: readonly [number, number];
  readonly tailFailureRate?: number;
  readonly replicates?: readonly EvaluationReplicate[];
  readonly counterexampleRefs: readonly AdaptiveArtifactReference[];
  readonly artifactRefs: readonly AdaptiveArtifactReference[];
  readonly environmentHash?: string;
  readonly targetHash?: string;
  readonly resultHash?: string;
  readonly cost: EvaluationCost;
  readonly infrastructureError?: string;
}

export interface EvaluationExecutionContext {
  readonly signal: AbortSignal;
  readonly evaluationId: EvaluationId;
  readonly seed?: string;
}

export interface EvaluatorDefinition<TInput = unknown, TOutcome = unknown> {
  readonly evaluatorId: string;
  readonly version: string;
  readonly mode: EvaluationMode;
  readonly soundness: EvaluationSoundness;
  readonly scale: EvaluationScale;
  readonly level: EvaluationLevel;
  readonly outcomeFamily: EvaluationOutcomeFamily;
  readonly defaultTimeoutMs: number;
  readonly cachePolicy: 'exact-environment' | 'never';
  execute(
    input: TInput,
    context: EvaluationExecutionContext,
  ): Promise<Omit<EvaluationResult<TOutcome>, 'protocol' | 'evaluationId' | 'evaluatorId' | 'evaluatorVersion' | 'mode' | 'soundness' | 'scale' | 'level' | 'outcomeFamily'>>;
}

export interface ISessionEvaluationRegistry {
  readonly _serviceBrand: undefined;
  register(definition: EvaluatorDefinition): IDisposable;
  get(evaluatorId: string): EvaluatorDefinition;
  list(): readonly EvaluatorDefinition[];
}

export const ISessionEvaluationRegistry = createDecorator<ISessionEvaluationRegistry>(
  'sessionEvaluationRegistry',
);

export interface ISessionEvaluationService {
  readonly _serviceBrand: undefined;
  evaluate<TInput, TOutcome = unknown>(
    spec: EvaluationSpec<TInput>,
    signal?: AbortSignal,
  ): Promise<EvaluationResult<TOutcome>>;
  evaluateBatch(
    specs: readonly EvaluationSpec[],
    signal?: AbortSignal,
  ): Promise<readonly EvaluationResult[]>;
  flush(): Promise<void>;
}

export const ISessionEvaluationService = createDecorator<ISessionEvaluationService>(
  'sessionEvaluationService',
);
