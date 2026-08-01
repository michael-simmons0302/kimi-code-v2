import { createHash } from 'node:crypto';

import type { EvidenceId } from '#/agent/adaptiveRuntime/adaptiveProtocol';

export function toolCallEvidenceId(
  toolCallId: string,
  providerTraceId?: string,
): EvidenceId {
  return evidenceId('tool-call', toolCallId, providerTraceId);
}

export function toolResultEvidenceId(
  toolCallId: string,
  providerTraceId?: string,
): EvidenceId {
  return evidenceId('tool-result', toolCallId, providerTraceId);
}

export function processExecutionEvidenceId(
  toolCallId: string,
  providerTraceId?: string,
): EvidenceId {
  return evidenceId('process-execution', toolCallId, providerTraceId);
}

function evidenceId(
  kind: 'tool-call' | 'tool-result' | 'process-execution',
  toolCallId: string,
  providerTraceId?: string,
): EvidenceId {
  if (toolCallId.trim().length === 0) {
    throw new Error('Tool evidence requires a non-empty toolCallId.');
  }
  const hash = createHash('sha256')
    .update(kind)
    .update('\u0000')
    .update(providerTraceId ?? '')
    .update('\u0000')
    .update(toolCallId)
    .digest('hex');
  return `${kind}:${hash}` as EvidenceId;
}
