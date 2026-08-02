import { createHash } from 'node:crypto';

import { createDecorator } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import type { EvidenceId } from '#/agent/adaptiveRuntime/adaptiveProtocol';
import { IAgentAdaptiveRuntimeService } from '#/agent/adaptiveRuntime/adaptiveRuntime';
import {
  toolCallEvidenceId,
  toolResultEvidenceId,
} from '#/agent/evaluationEvidence/toolEvidenceIds';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import type { ToolDidExecuteContext } from '#/agent/toolExecutor/toolHooks';
import { requestIdForTrace } from '#/kosong/contract/requestTrace';
import { ISessionEvaluationLedgerService } from '#/session/evaluationLedger/evaluationLedger';
import { ISessionEvidenceGraphService } from '#/session/evaluationLedger/evidenceGraph';
import type { ToolEvidenceEnvelope } from '#/tool/toolContract';

export interface IAgentEvaluationEvidenceService {
  readonly _serviceBrand: undefined;
}

export const IAgentEvaluationEvidenceService =
  createDecorator<IAgentEvaluationEvidenceService>('agentEvaluationEvidenceService');

export class AgentEvaluationEvidenceService
  extends Disposable
  implements IAgentEvaluationEvidenceService
{
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentAdaptiveRuntimeService private readonly runtime: IAgentAdaptiveRuntimeService,
    @IAgentToolExecutorService toolExecutor: IAgentToolExecutorService,
    @ISessionEvaluationLedgerService private readonly ledger: ISessionEvaluationLedgerService,
    @ISessionEvidenceGraphService private readonly graph: ISessionEvidenceGraphService,
  ) {
    super();
    this._register(
      toolExecutor.hooks.onDidExecuteTool.register(
        'adaptive-evidence-capture',
        async (context, next) => {
          await next();
          await this.capture(context);
        },
      ),
    );
  }

  private async capture(context: ToolDidExecuteContext): Promise<void> {
    if (!this.runtime.enabled()) return;
    const adaptiveRunId = this.runtime.ensureRun();
    if (adaptiveRunId === undefined) return;

    const providerTraceId = context.trace?.traceId;
    const callEvidenceId = toolCallEvidenceId(context.toolCall.id, providerTraceId);
    const resultEvidenceId = toolResultEvidenceId(context.toolCall.id, providerTraceId);
    const explicitEvidence = context.result.evidence;
    const secret = explicitEvidence?.sensitivity === 'secret';

    await this.ledger.append({
      recordType: 'tool.call.recorded',
      adaptiveRunId,
      evidenceId: callEvidenceId,
      payload: {
        requestId: context.trace === undefined ? undefined : requestIdForTrace(context.trace),
        providerTraceId,
        turnId: context.turnId,
        toolCallId: context.toolCall.id,
        toolName: context.toolCall.name,
        argsHash: hashValue(context.args),
      },
    });
    await this.ledger.append({
      recordType: 'tool.result.recorded',
      adaptiveRunId,
      evidenceId: resultEvidenceId,
      payload: {
        requestId: context.trace === undefined ? undefined : requestIdForTrace(context.trace),
        providerTraceId,
        turnId: context.turnId,
        toolCallId: context.toolCall.id,
        toolName: context.toolCall.name,
        argsHash: hashValue(context.args),
        isError: context.result.isError === true,
        stopTurn: context.result.stopTurn === true,
        truncatedBeforeModel: context.result.truncated === true,
        note: context.result.note,
        output: secret ? undefined : context.result.output,
        evidence: secret
          ? {
              kind: explicitEvidence.kind,
              schemaVersion: explicitEvidence.schemaVersion,
              sensitivity: explicitEvidence.sensitivity,
              artifactRefs: explicitEvidence.artifactRefs ?? [],
              redacted: true,
            }
          : explicitEvidence,
      },
    });

    await this.graph.ready();
    await this.graph.appendLink({
      fromEvidenceId: callEvidenceId,
      toEvidenceId: resultEvidenceId,
      relation: 'caused',
    });

    const processEvidenceId = processIdFrom(explicitEvidence);
    if (processEvidenceId === undefined) return;
    const processNode = await this.graph.getNode(processEvidenceId);
    if (processNode === undefined) {
      throw new Error(
        `Tool result references missing process evidence: ${processEvidenceId}`,
      );
    }
    await this.graph.appendLink({
      fromEvidenceId: callEvidenceId,
      toEvidenceId: processEvidenceId,
      relation: 'caused',
    });
    await this.graph.appendLink({
      fromEvidenceId: processEvidenceId,
      toEvidenceId: resultEvidenceId,
      relation: 'derived-from',
    });
  }
}

function processIdFrom(
  evidence: ToolEvidenceEnvelope | undefined,
): EvidenceId | undefined {
  if (evidence?.kind !== 'process-execution') return undefined;
  if (evidence.payload === null || typeof evidence.payload !== 'object') {
    throw new Error('Process tool evidence payload must be an object.');
  }
  const evidenceId = (evidence.payload as Record<string, unknown>)['evidenceId'];
  if (typeof evidenceId !== 'string' || evidenceId.length === 0) {
    throw new Error('Process tool evidence payload is missing evidenceId.');
  }
  return evidenceId as EvidenceId;
}

function hashValue(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, current: unknown) => {
    if (
      current !== null &&
      typeof current === 'object' &&
      !Array.isArray(current) &&
      !(current instanceof Uint8Array)
    ) {
      const source = current as Record<string, unknown>;
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(source).sort()) {
        if (source[key] !== undefined) sorted[key] = source[key];
      }
      return sorted;
    }
    return current;
  });
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentEvaluationEvidenceService,
  AgentEvaluationEvidenceService,
  ScopeActivation.OnScopeCreated,
  'evaluationEvidence',
);
