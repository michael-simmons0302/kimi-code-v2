import { createDecorator } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/_base/state/stateRegistry';
import { IAgentAdaptiveMemoryService } from '#/agent/adaptiveMemory/adaptiveMemory';
import { IAgentAdaptiveDirectiveService } from '#/agent/adaptivePrompt/adaptiveDirectiveService';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentStateService } from '#/agent/state/agentState';
import { createEvidenceId } from './adaptiveProtocol';
import { IAgentAdaptiveRuntimeService } from './adaptiveRuntime';
import {
  FINAL_RESPONSE_PROTOCOL,
  IAgentFinalResponseVerifierService,
  type FinalResponsePlan,
  type FinalResponseVerification,
} from './finalResponseVerifier';
import type { BaselineSnapshot } from '#/session/candidateWorkspace/candidateWorkspace';
import { ISessionCandidateWorkspaceService } from '#/session/candidateWorkspace/candidateWorkspace';
import { ISessionEvaluationLedgerService } from '#/session/evaluationLedger/evaluationLedger';
import { ISessionStructuralSignalsService } from '#/session/structuralSignals/structuralSignals';

const MAXIMUM_FINAL_RESPONSE_TOKENS = 400;

interface AdaptiveFinalResponseGateState {
  readonly correctionAttempts: number;
}

export const adaptiveFinalResponseGateStateKey = defineState<AdaptiveFinalResponseGateState>(
  'adaptiveFinalResponseGate.state',
  () => ({ correctionAttempts: 0 }),
);

export type AdaptiveFinalResponseDecision =
  | { readonly kind: 'not-applicable' }
  | { readonly kind: 'verified'; readonly verification: FinalResponseVerification }
  | { readonly kind: 'correction-required'; readonly verification: FinalResponseVerification }
  | { readonly kind: 'rejected'; readonly verification: FinalResponseVerification };

export interface IAgentAdaptiveFinalResponseGateService {
  readonly _serviceBrand: undefined;
  allowCoordinatorPreparation(): boolean;
  verifyAfterStep(): Promise<AdaptiveFinalResponseDecision>;
}

export const IAgentAdaptiveFinalResponseGateService =
  createDecorator<IAgentAdaptiveFinalResponseGateService>(
    'agentAdaptiveFinalResponseGateService',
  );

export class AgentAdaptiveFinalResponseGateService
  extends Disposable
  implements IAgentAdaptiveFinalResponseGateService
{
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentAdaptiveRuntimeService private readonly runtime: IAgentAdaptiveRuntimeService,
    @IAgentAdaptiveDirectiveService private readonly directive: IAgentAdaptiveDirectiveService,
    @IAgentAdaptiveMemoryService private readonly memory: IAgentAdaptiveMemoryService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentFinalResponseVerifierService private readonly verifier: IAgentFinalResponseVerifierService,
    @IAgentStateService private readonly states: IAgentStateService,
    @ISessionCandidateWorkspaceService private readonly workspaces: ISessionCandidateWorkspaceService,
    @ISessionEvaluationLedgerService private readonly ledger: ISessionEvaluationLedgerService,
    @ISessionStructuralSignalsService private readonly signals: ISessionStructuralSignalsService,
  ) {
    super();
    states.register(adaptiveFinalResponseGateStateKey);
  }

  allowCoordinatorPreparation(): boolean {
    return !this.runtime.enabled() || this.runtime.phase() !== 'committing';
  }

  async verifyAfterStep(): Promise<AdaptiveFinalResponseDecision> {
    if (!this.runtime.enabled() || this.runtime.phase() !== 'committing') {
      return { kind: 'not-applicable' };
    }
    try {
      const plan = await this.buildPlan();
      const verification = await this.verifier.verify(this.latestAssistantText(), plan);
      await this.recordVerification(verification, plan);
      if (verification.valid) {
        this.state = { correctionAttempts: 0 };
        this.directive.set(undefined);
        return { kind: 'verified', verification };
      }
      if (this.state.correctionAttempts === 0) {
        this.state = { correctionAttempts: 1 };
        this.directive.set(correctionDirective(verification));
        return { kind: 'correction-required', verification };
      }
      this.runtime.fail(
        'commit-rejected',
        `Final response verification failed after one correction: ${verificationSummary(verification)}`,
      );
      this.directive.set(undefined);
      return { kind: 'rejected', verification };
    } catch (error) {
      this.runtime.fail(
        'infrastructure-failed',
        error instanceof Error ? error.message : String(error),
      );
      throw new Error(
        `Final response verification failed closed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
  }

  private get state(): AdaptiveFinalResponseGateState {
    return this.states.get(adaptiveFinalResponseGateStateKey);
  }

  private set state(value: AdaptiveFinalResponseGateState) {
    this.states.set(adaptiveFinalResponseGateStateKey, value);
  }

  private async buildPlan(): Promise<FinalResponsePlan> {
    await Promise.all([this.ledger.ready(), this.memory.ready(), this.workspaces.ready()]);
    const changedFiles = await this.changedFiles();
    const verificationEvidenceRefs = [
      ...new Set(
        this.memory
          .summaries({ kind: 'verified-progress' })
          .flatMap((summary) => summary.claims)
          .flatMap((claim) => claim.evidenceRefs),
      ),
    ];
    const unresolvedMaterialRisks = this.signals
      .conflicts('open')
      .filter((conflict) => conflict.severity !== 'information')
      .map((conflict) => conflict.message);
    return {
      protocol: FINAL_RESPONSE_PROTOCOL,
      changedFiles,
      verificationEvidenceRefs,
      unresolvedMaterialRisks,
      maximumTokens: MAXIMUM_FINAL_RESPONSE_TOKENS,
      requireChangedFiles: changedFiles.length > 0,
      requireVerification: true,
      requireRiskStatement: true,
    };
  }

  private async changedFiles(): Promise<readonly string[]> {
    const current = this.workspaces.baseline();
    if (current === undefined) return [];
    let initial: BaselineSnapshot | undefined;
    for await (const record of this.ledger.records()) {
      if (record.recordType !== 'baseline.captured') continue;
      initial = asBaselineSnapshot(record.payload);
      if (initial !== undefined) break;
    }
    if (initial === undefined) return [];
    const before = new Map(initial.files.map((file) => [file.relativePath, file.sha256]));
    const after = new Map(current.files.map((file) => [file.relativePath, file.sha256]));
    return [...new Set([...before.keys(), ...after.keys()])]
      .filter((path) => before.get(path) !== after.get(path))
      .sort();
  }

  private latestAssistantText(): string {
    for (const message of [...this.context.get()].reverse()) {
      if (message.role !== 'assistant') continue;
      const text = message.content
        .flatMap((part) => (part.type === 'text' ? [part.text] : []))
        .join('')
        .trim();
      if (text.length > 0) return text;
    }
    return '';
  }

  private async recordVerification(
    verification: FinalResponseVerification,
    plan: FinalResponsePlan,
  ): Promise<void> {
    await this.ledger.append({
      recordType: 'final.claim.verified',
      adaptiveRunId: this.runtime.runId(),
      evidenceId: createEvidenceId(),
      payload: {
        protocol: FINAL_RESPONSE_PROTOCOL,
        valid: verification.valid,
        estimatedTokens: verification.estimatedTokens,
        unsupportedClaims: verification.unsupportedClaims,
        missingChangedFiles: verification.missingChangedFiles,
        missingRequirements: verification.missingRequirements,
        forbiddenInternalDetails: verification.forbiddenInternalDetails,
        verificationEvidenceRefs: plan.verificationEvidenceRefs,
        changedFiles: plan.changedFiles,
      },
    });
  }
}

function asBaselineSnapshot(value: unknown): BaselineSnapshot | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const candidate = value as Partial<BaselineSnapshot>;
  return candidate.protocol === 'candidate-baseline/1' && Array.isArray(candidate.files)
    ? (candidate as BaselineSnapshot)
    : undefined;
}

function correctionDirective(verification: FinalResponseVerification): string {
  return [
    'Rewrite the final response once. Preserve only supported claims.',
    ...verification.unsupportedClaims.map((claim) => `Unsupported claim: ${claim}`),
    ...verification.missingChangedFiles.map((path) => `Mention changed file: ${path}`),
    ...verification.missingRequirements.map((requirement) => `Requirement: ${requirement}`),
    verification.forbiddenInternalDetails.length > 0
      ? 'Remove all internal search, posterior, entropy, candidate, and hidden-evaluator details.'
      : undefined,
    'Return only what changed, decisive verification, and unresolved material risk or its absence.',
  ]
    .filter((line): line is string => line !== undefined)
    .join('\n');
}

function verificationSummary(verification: FinalResponseVerification): string {
  return [
    ...verification.unsupportedClaims,
    ...verification.missingChangedFiles.map((path) => `missing file ${path}`),
    ...verification.missingRequirements,
    ...verification.forbiddenInternalDetails.map((detail) => `forbidden detail ${detail}`),
  ].join('; ');
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentAdaptiveFinalResponseGateService,
  AgentAdaptiveFinalResponseGateService,
  ScopeActivation.OnScopeCreated,
  'adaptiveFinalResponseGate',
);