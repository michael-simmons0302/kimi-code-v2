import {
  createDecorator,
  IInstantiationService,
  type ServiceIdentifier,
} from '#/_base/di/instantiation';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import type { LLMRequestTrace } from '#/kosong/contract/requestTrace';
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

export const IAgentProcessEvidenceRecorderImplementation:
  ServiceIdentifier<IAgentProcessEvidenceRecorderService> =
  createDecorator<IAgentProcessEvidenceRecorderService>(
    'agentProcessEvidenceRecorderImplementation',
  );

export class AgentProcessEvidenceRecorderFacade
  implements IAgentProcessEvidenceRecorderService
{
  declare readonly _serviceBrand: undefined;
  private implementationValue: IAgentProcessEvidenceRecorderService | undefined;

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IInstantiationService private readonly instantiation: IInstantiationService,
  ) {}

  start(input: ProcessEvidenceStart): ProcessEvidenceRecorder {
    return this.implementation()?.start(input) ?? NOOP_RECORDER;
  }

  private implementation(): IAgentProcessEvidenceRecorderService | undefined {
    if (this.bootstrap.args.adaptiveMode !== 'enabled') return undefined;
    this.implementationValue ??= this.instantiation.invokeFunction(
      (accessor) => accessor.get(IAgentProcessEvidenceRecorderImplementation),
    );
    return this.implementationValue;
  }
}

const NOOP_RECORDER: ProcessEvidenceRecorder = Object.freeze({
  setTaskId: () => {},
  append: () => {},
  settle: async () => undefined,
});

registerScopedService(
  LifecycleScope.Agent,
  IAgentProcessEvidenceRecorderService,
  AgentProcessEvidenceRecorderFacade,
  ScopeActivation.OnDemand,
  'processEvidenceRecorderFacade',
);
