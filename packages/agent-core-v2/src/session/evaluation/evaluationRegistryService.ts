import { toDisposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import {
  ISessionEvaluationRegistry,
  type EvaluatorDefinition,
} from './evaluation';

export class SessionEvaluationRegistry implements ISessionEvaluationRegistry {
  declare readonly _serviceBrand: undefined;

  private readonly definitions = new Map<string, EvaluatorDefinition>();

  register(definition: EvaluatorDefinition) {
    validateDefinition(definition);
    if (this.definitions.has(definition.evaluatorId)) {
      throw new Error(`Evaluator is already registered: ${definition.evaluatorId}`);
    }
    this.definitions.set(definition.evaluatorId, definition);
    return toDisposable(() => {
      if (this.definitions.get(definition.evaluatorId) === definition) {
        this.definitions.delete(definition.evaluatorId);
      }
    });
  }

  get(evaluatorId: string): EvaluatorDefinition {
    const definition = this.definitions.get(evaluatorId);
    if (definition === undefined) {
      throw new Error(`Evaluator is not registered: ${evaluatorId}`);
    }
    return definition;
  }

  list(): readonly EvaluatorDefinition[] {
    return [...this.definitions.values()].sort((left, right) =>
      left.evaluatorId.localeCompare(right.evaluatorId),
    );
  }
}

function validateDefinition(definition: EvaluatorDefinition): void {
  if (definition.evaluatorId.trim().length === 0) {
    throw new Error('Evaluator ID cannot be empty.');
  }
  if (definition.version.trim().length === 0) {
    throw new Error(`Evaluator version cannot be empty: ${definition.evaluatorId}`);
  }
  if (!Number.isFinite(definition.defaultTimeoutMs) || definition.defaultTimeoutMs <= 0) {
    throw new Error(`Evaluator timeout must be positive: ${definition.evaluatorId}`);
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionEvaluationRegistry,
  SessionEvaluationRegistry,
  ScopeActivation.OnScopeCreated,
  'evaluationRegistry',
);
