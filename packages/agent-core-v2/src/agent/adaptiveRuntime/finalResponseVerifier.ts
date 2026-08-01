import { createDecorator } from '#/_base/di/instantiation';
import type { EvidenceId } from './adaptiveProtocol';

export const FINAL_RESPONSE_PROTOCOL = 'adaptive-final-response/1' as const;

export interface FinalResponsePlan {
  readonly protocol: typeof FINAL_RESPONSE_PROTOCOL;
  readonly changedFiles: readonly string[];
  readonly verificationEvidenceRefs: readonly EvidenceId[];
  readonly unresolvedMaterialRisks: readonly string[];
  readonly maximumTokens: number;
  readonly requireChangedFiles: boolean;
  readonly requireVerification: boolean;
  readonly requireRiskStatement: boolean;
}

export interface FinalResponseVerification {
  readonly valid: boolean;
  readonly estimatedTokens: number;
  readonly unsupportedClaims: readonly string[];
  readonly missingChangedFiles: readonly string[];
  readonly missingRequirements: readonly string[];
  readonly forbiddenInternalDetails: readonly string[];
  readonly evidenceRefs: readonly EvidenceId[];
}

export interface IAgentFinalResponseVerifierService {
  readonly _serviceBrand: undefined;
  verify(text: string, plan: FinalResponsePlan): Promise<FinalResponseVerification>;
}

export const IAgentFinalResponseVerifierService =
  createDecorator<IAgentFinalResponseVerifierService>('agentFinalResponseVerifierService');
