import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import type { EvidenceId } from './adaptiveProtocol';
import {
  IAgentFinalResponseVerifierService,
  type FinalResponsePlan,
  type FinalResponseVerification,
} from './finalResponseVerifier';
import { ISessionEvaluationLedgerService } from '#/session/evaluationLedger/evaluationLedger';

const FORBIDDEN_INTERNAL_PATTERNS: readonly RegExp[] = [
  /\bMCTS\b/i,
  /\bPUCT\b/i,
  /\bposterior(?:s)?\b/i,
  /\bworld[- ]model(?:s)?\b/i,
  /\bepistemic\b/i,
  /\bentropy\b/i,
  /\bcandidate population\b/i,
  /\bhidden evaluator(?:s)?\b/i,
  /\binternal prompt(?:s)?\b/i,
  /\bsearch tree\b/i,
];

const VERIFICATION_LANGUAGE = /\b(?:verified|verification|typecheck|test(?:s|ed|ing)?|build|lint)\b/i;
const RISK_LANGUAGE = /\b(?:risk|remaining|unresolved|none)\b/i;

interface EvidenceIndexEntry {
  readonly evidenceId: EvidenceId;
  readonly recordType: string;
  readonly status?: string;
  readonly evaluatorId?: string;
  readonly tags: readonly string[];
  readonly payload: unknown;
}

export class AgentFinalResponseVerifierService
  implements IAgentFinalResponseVerifierService
{
  declare readonly _serviceBrand: undefined;

  constructor(
    @ISessionEvaluationLedgerService private readonly ledger: ISessionEvaluationLedgerService,
  ) {}

  async verify(
    text: string,
    plan: FinalResponsePlan,
  ): Promise<FinalResponseVerification> {
    await this.ledger.ready();
    validatePlan(plan);
    const normalized = text.trim();
    const evidence = await this.evidenceIndex();
    const referenced = plan.verificationEvidenceRefs
      .map((evidenceId) => evidence.get(evidenceId))
      .filter((entry): entry is EvidenceIndexEntry => entry !== undefined);
    const successful = referenced.filter((entry) => entry.status === 'passed');
    const missingChangedFiles = plan.requireChangedFiles
      ? plan.changedFiles.filter((path) => !mentionsPath(normalized, path))
      : [];
    const missingRequirements: string[] = [];
    if (normalized.length === 0) missingRequirements.push('Final response is empty.');
    if (plan.requireVerification && !VERIFICATION_LANGUAGE.test(normalized)) {
      missingRequirements.push('Final response does not state the decisive verification.');
    }
    if (plan.requireVerification && successful.length === 0) {
      missingRequirements.push('No referenced verification evidence passed.');
    }
    if (plan.requireRiskStatement && !RISK_LANGUAGE.test(normalized)) {
      missingRequirements.push('Final response does not state unresolved material risk or its absence.');
    }
    for (const risk of plan.unresolvedMaterialRisks) {
      if (!normalized.toLowerCase().includes(risk.toLowerCase())) {
        missingRequirements.push(`Final response omits unresolved material risk: ${risk}`);
      }
    }

    const unsupportedClaims = verifyClaims(normalized, referenced, successful);
    const forbiddenInternalDetails = FORBIDDEN_INTERNAL_PATTERNS
      .filter((pattern) => pattern.test(normalized))
      .map((pattern) => pattern.source);
    const estimatedTokens = estimateTokens(normalized);
    if (estimatedTokens > plan.maximumTokens) {
      missingRequirements.push(
        `Final response exceeds the ${String(plan.maximumTokens)} token limit.`,
      );
    }
    for (const evidenceId of plan.verificationEvidenceRefs) {
      if (!evidence.has(evidenceId)) {
        missingRequirements.push(`Final response plan references unknown evidence: ${evidenceId}`);
      }
    }

    return {
      valid:
        unsupportedClaims.length === 0 &&
        missingChangedFiles.length === 0 &&
        missingRequirements.length === 0 &&
        forbiddenInternalDetails.length === 0,
      estimatedTokens,
      unsupportedClaims,
      missingChangedFiles,
      missingRequirements,
      forbiddenInternalDetails,
      evidenceRefs: plan.verificationEvidenceRefs,
    };
  }

  private async evidenceIndex(): Promise<ReadonlyMap<EvidenceId, EvidenceIndexEntry>> {
    const index = new Map<EvidenceId, EvidenceIndexEntry>();
    for await (const record of this.ledger.records()) {
      if (record.evidenceId === undefined) continue;
      const payload = asObject(record.payload);
      index.set(record.evidenceId, {
        evidenceId: record.evidenceId,
        recordType: record.recordType,
        status: stringField(payload, 'status'),
        evaluatorId: stringField(payload, 'evaluatorId'),
        tags: stringArrayField(payload, 'tags'),
        payload: record.payload,
      });
    }
    return index;
  }
}

function validatePlan(plan: FinalResponsePlan): void {
  if (plan.protocol !== 'adaptive-final-response/1') {
    throw new Error(`Unsupported final response protocol: ${String(plan.protocol)}.`);
  }
  if (!Number.isInteger(plan.maximumTokens) || plan.maximumTokens <= 0) {
    throw new Error('Final response maximumTokens must be a positive integer.');
  }
  if (plan.requireVerification && plan.verificationEvidenceRefs.length === 0) {
    throw new Error('A verification-required final response plan needs evidence references.');
  }
}

function verifyClaims(
  text: string,
  referenced: readonly EvidenceIndexEntry[],
  successful: readonly EvidenceIndexEntry[],
): readonly string[] {
  const unsupported: string[] = [];
  const broadAllTestsClaim = /\ball (?:repository )?tests? (?:pass|passed|succeed|succeeded)\b/i;
  if (broadAllTestsClaim.test(text)) {
    const fullSuiteEvidence = successful.some(
      (entry) =>
        entry.tags.includes('full-suite') ||
        asObject(entry.payload)['scope'] === 'all-tests',
    );
    if (!fullSuiteEvidence) unsupported.push('Claim that all tests passed lacks full-suite evidence.');
  }

  const typecheckClaim = /\btypecheck(?:ing)? (?:pass|passed|succeed|succeeded)\b/i;
  if (typecheckClaim.test(text)) {
    const supported = successful.some(
      (entry) =>
        entry.evaluatorId === 'typescript.typecheck' ||
        entry.evaluatorId === 'sandbox.command',
    );
    if (!supported) unsupported.push('Typecheck success claim lacks passing evidence.');
  }

  const testsClaim = /\btests? (?:pass|passed|succeed|succeeded)\b/i;
  if (testsClaim.test(text) && !broadAllTestsClaim.test(text)) {
    const supported = successful.some(
      (entry) =>
        entry.evaluatorId === 'vitest.test' ||
        entry.evaluatorId === 'sandbox.command',
    );
    if (!supported) unsupported.push('Test success claim lacks passing evidence.');
  }

  const fixedClaim = /\b(?:fixed|completed|complete)\b/i;
  if (fixedClaim.test(text) && successful.length === 0) {
    unsupported.push('Completion claim lacks passing verification evidence.');
  }

  if (referenced.length === 0 && VERIFICATION_LANGUAGE.test(text)) {
    unsupported.push('Verification language is used without referenced evidence.');
  }
  return unsupported;
}

function mentionsPath(text: string, path: string): boolean {
  const normalizedText = text.replaceAll('\\', '/');
  const normalizedPath = path.replaceAll('\\', '/');
  const basename = normalizedPath.split('/').at(-1) ?? normalizedPath;
  return normalizedText.includes(normalizedPath) || normalizedText.includes(basename);
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function asObject(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object'
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function stringField(
  object: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  return typeof object[key] === 'string' ? object[key] : undefined;
}

function stringArrayField(
  object: Readonly<Record<string, unknown>>,
  key: string,
): readonly string[] {
  const value = object[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentFinalResponseVerifierService,
  AgentFinalResponseVerifierService,
  ScopeActivation.OnScopeCreated,
  'finalResponseVerifier',
);
