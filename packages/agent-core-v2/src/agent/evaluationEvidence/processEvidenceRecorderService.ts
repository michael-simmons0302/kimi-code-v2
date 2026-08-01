import { createDecorator } from '#/_base/di/instantiation';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { createEvidenceId, type EvidenceId } from '#/agent/adaptiveRuntime/adaptiveProtocol';
import { IAgentAdaptiveRuntimeService } from '#/agent/adaptiveRuntime/adaptiveRuntime';
import type { LLMRequestTrace } from '#/kosong/contract/requestTrace';
import { requestIdForTrace } from '#/kosong/contract/requestTrace';
import { IBlobStore } from '#/persistence/interface/blobStore';
import {
  createProcessEvidence,
  type MaterializedProcessEvidence,
  type ProcessEvidenceEnvelope,
} from '#/session/process/processEvidence';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionEvaluationLedgerService } from '#/session/evaluationLedger/evaluationLedger';
import type { ToolEvidenceEnvelope } from '#/tool/toolContract';

export interface ProcessEvidenceStart {
  readonly command: readonly string[] | string;
  readonly shell: boolean;
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly background: boolean;
  readonly toolCallId: string;
  readonly trace?: LLMRequestTrace;
}

export interface ProcessEvidenceSettlement {
  readonly exitCode: number | null;
  readonly terminationSignal?: string;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly modelOutputBytes?: number;
}

export interface ProcessEvidenceRecorder {
  setTaskId(taskId: string): void;
  append(kind: 'stdout' | 'stderr', bytes: Uint8Array): void;
  settle(settlement: ProcessEvidenceSettlement): Promise<ToolEvidenceEnvelope | undefined>;
}

export interface IAgentProcessEvidenceRecorderService {
  readonly _serviceBrand: undefined;
  start(input: ProcessEvidenceStart): ProcessEvidenceRecorder;
}

export const IAgentProcessEvidenceRecorderService =
  createDecorator<IAgentProcessEvidenceRecorderService>(
    'agentProcessEvidenceRecorderService',
  );

export class AgentProcessEvidenceRecorderService
  implements IAgentProcessEvidenceRecorderService
{
  declare readonly _serviceBrand: undefined;

  private readonly artifactScope: string;

  constructor(
    @IAgentAdaptiveRuntimeService private readonly runtime: IAgentAdaptiveRuntimeService,
    @ISessionContext session: ISessionContext,
    @IBlobStore private readonly blobs: IBlobStore,
    @ISessionEvaluationLedgerService private readonly ledger: ISessionEvaluationLedgerService,
  ) {
    this.artifactScope = session.scope('adaptive/artifacts');
  }

  start(input: ProcessEvidenceStart): ProcessEvidenceRecorder {
    const startedAtMonotonicMs = performance.now();
    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    const combined: Uint8Array[] = [];
    let taskId: string | undefined;
    let settled = false;

    return {
      setTaskId: (value) => {
        if (settled) throw new Error('Cannot assign a task ID after process evidence settled.');
        if (value.trim().length === 0) throw new Error('Process evidence task ID cannot be empty.');
        if (taskId !== undefined && taskId !== value) {
          throw new Error(`Process evidence task ID changed from ${taskId} to ${value}.`);
        }
        taskId = value;
      },
      append: (kind, bytes) => {
        if (settled || bytes.byteLength === 0) return;
        const copy = bytes.slice();
        (kind === 'stdout' ? stdout : stderr).push(copy);
        combined.push(copy);
      },
      settle: async (settlement) => {
        if (settled) throw new Error('Process evidence can only settle once.');
        settled = true;
        if (!this.runtime.enabled()) return undefined;
        if (input.background && taskId === undefined) {
          throw new Error('Background process evidence settled without a task ID.');
        }
        const materialized = createProcessEvidence({
          command: input.command,
          shell: input.shell,
          cwd: input.cwd,
          environment: input.environment,
          startedAtMonotonicMs,
          endedAtMonotonicMs: performance.now(),
          exitCode: settlement.exitCode,
          terminationSignal: settlement.terminationSignal,
          timedOut: settlement.timedOut,
          cancelled: settlement.cancelled,
          background: input.background,
          taskId,
          stdout: concatenate(stdout),
          stderr: concatenate(stderr),
          combined: concatenate(combined),
          modelOutputBytes: settlement.modelOutputBytes,
        });
        const evidenceId = createEvidenceId();
        const artifactRefs = await this.persistArtifacts(materialized);
        await this.ledger.append({
          recordType: 'process.execution.recorded',
          adaptiveRunId: this.runtime.ensureRun(),
          evidenceId,
          payload: {
            requestId: input.trace === undefined ? undefined : requestIdForTrace(input.trace),
            providerTraceId: input.trace?.traceId,
            toolCallId: input.toolCallId,
            envelope: materialized.envelope,
            artifactRefs,
          },
        });
        return toolEvidence(evidenceId, materialized.envelope, artifactRefs);
      },
    };
  }

  private async persistArtifacts(
    materialized: MaterializedProcessEvidence,
  ): Promise<readonly string[]> {
    const values = [
      [materialized.envelope.stdout.artifactHash, materialized.artifacts.stdout],
      [materialized.envelope.stderr.artifactHash, materialized.artifacts.stderr],
      [materialized.envelope.combined.artifactHash, materialized.artifacts.combined],
    ] as const;
    const refs: string[] = [];
    for (const [hash, bytes] of values) {
      const key = `process/${hash}`;
      if (await this.blobs.has(this.artifactScope, key)) {
        const existing = await this.blobs.get(this.artifactScope, key);
        if (existing === undefined || !equalBytes(existing, bytes)) {
          throw new Error(`Content-addressed process artifact mismatch: ${hash}`);
        }
      } else {
        await this.blobs.put(this.artifactScope, key, bytes);
      }
      refs.push(`${this.artifactScope}/${key}`);
    }
    return Object.freeze(refs);
  }
}

function toolEvidence(
  evidenceId: EvidenceId,
  envelope: ProcessEvidenceEnvelope,
  artifactRefs: readonly string[],
): ToolEvidenceEnvelope {
  return {
    kind: 'process-execution',
    schemaVersion: 1,
    sensitivity: 'sensitive',
    payload: { evidenceId, envelope },
    artifactRefs,
  };
}

function concatenate(chunks: readonly Uint8Array[]): Uint8Array {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentProcessEvidenceRecorderService,
  AgentProcessEvidenceRecorderService,
  ScopeActivation.OnDemand,
  'processEvidenceRecorder',
);
