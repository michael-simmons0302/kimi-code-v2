import { createHash } from 'node:crypto';

import type { EvaluationSpec } from './evaluation';

export function createEvaluationSpecHash<TInput>(
  spec: EvaluationSpec<TInput>,
  evaluatorVersion: string,
): string {
  if (evaluatorVersion.trim().length === 0) {
    throw new Error('Evaluator version cannot be empty when hashing an evaluation specification.');
  }
  return hashCanonical({
    protocol: spec.protocol,
    evaluatorId: spec.evaluatorId,
    evaluatorVersion,
    input: spec.input,
    inputEvidenceRefs: [...(spec.inputEvidenceRefs ?? [])].sort(),
    budget: spec.budget,
    seed: spec.seed,
    tags: spec.tags ?? [],
  });
}

function hashCanonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, current: unknown) => {
    if (current instanceof Uint8Array) return Buffer.from(current).toString('base64');
    if (current !== null && typeof current === 'object' && !Array.isArray(current)) {
      const object = current as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(object)
          .sort()
          .filter((key) => object[key] !== undefined)
          .map((key) => [key, object[key]]),
      );
    }
    return current;
  });
}
