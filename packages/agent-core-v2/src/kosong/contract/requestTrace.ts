/**
 * `kosong/contract` domain — live request provenance contract.
 *
 * Exposes a stable host-owned request identifier and the optional provider
 * trace identifier of one logical LLM request while its result is pending.
 */

import { randomUUID } from 'node:crypto';

export interface LLMRequestTrace {
  readonly requestId?: string;
  readonly traceId: string | undefined;
}

const generatedRequestIds = new WeakMap<object, string>();

/**
 * Return the request's stable host identifier. Older trace implementations do
 * not carry the field directly, so a WeakMap assigns one for that trace object
 * without mutating provider-owned state.
 */
export function requestIdForTrace(trace: LLMRequestTrace): string {
  if (typeof trace.requestId === 'string' && trace.requestId.length > 0) {
    return trace.requestId;
  }
  const key = trace as object;
  const existing = generatedRequestIds.get(key);
  if (existing !== undefined) return existing;
  const generated = randomUUID();
  generatedRequestIds.set(key, generated);
  return generated;
}
