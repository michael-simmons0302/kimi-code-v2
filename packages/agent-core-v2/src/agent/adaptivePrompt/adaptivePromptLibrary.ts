import { createHash } from 'node:crypto';

import { ADAPTIVE_PROMPT_PROTOCOL } from '#/agent/adaptiveRuntime/adaptiveProtocol';

export type AdaptivePromptPhase =
  | 'hypothesis-formation'
  | 'evaluation-selection'
  | 'cross-file-analysis'
  | 'candidate-repair'
  | 'verification'
  | 'commit';

export interface AdaptivePromptFragment {
  readonly protocol: typeof ADAPTIVE_PROMPT_PROTOCOL;
  readonly id: string;
  readonly version: number;
  readonly phase: AdaptivePromptPhase | 'constraint';
  readonly content: string;
  readonly maximumTokens: number;
  readonly hostOwned: true;
  readonly immutable: true;
}

export interface AdaptiveInternalPrompt {
  readonly protocol: typeof ADAPTIVE_PROMPT_PROTOCOL;
  readonly id: string;
  readonly version: number;
  readonly content: string;
  readonly contentHash: string;
  readonly hostOwned: true;
  readonly immutable: boolean;
}

const fragment = (
  input: Omit<AdaptivePromptFragment, 'protocol' | 'hostOwned' | 'immutable'>,
): AdaptivePromptFragment =>
  Object.freeze({
    protocol: ADAPTIVE_PROMPT_PROTOCOL,
    hostOwned: true,
    immutable: true,
    ...input,
  });

const internalPrompt = (
  input: Omit<
    AdaptiveInternalPrompt,
    'protocol' | 'contentHash' | 'hostOwned' | 'immutable'
  > & { readonly immutable?: boolean },
): AdaptiveInternalPrompt =>
  Object.freeze({
    protocol: ADAPTIVE_PROMPT_PROTOCOL,
    id: input.id,
    version: input.version,
    content: input.content,
    contentHash: promptHash(input.content),
    hostOwned: true,
    immutable: input.immutable ?? false,
  });

export const ADAPTIVE_PROMPT_FRAGMENTS = Object.freeze({
  hypothesisFormation: fragment({
    id: 'form-causal-hypotheses',
    version: 1,
    phase: 'hypothesis-formation',
    maximumTokens: 180,
    content:
      'Identify the smallest set of materially different causes consistent with the evidence. Express each cause through behavior it predicts. Do not commit to the first explanation.',
  }),
  evaluationSelection: fragment({
    id: 'choose-discriminating-evaluation',
    version: 1,
    phase: 'evaluation-selection',
    maximumTokens: 180,
    content:
      'Choose the smallest reliable check whose possible outcomes would most strongly separate the remaining explanations. Prefer direct observed evidence over additional speculation.',
  }),
  crossFileAnalysis: fragment({
    id: 'trace-structural-effects',
    version: 1,
    phase: 'cross-file-analysis',
    maximumTokens: 180,
    content:
      'Trace the affected structure through definitions, callers, imports, tests, persisted formats, generated artifacts, events, and runtime consumers before committing a change.',
  }),
  candidateRepair: fragment({
    id: 'repair-from-counterexample',
    version: 1,
    phase: 'candidate-repair',
    maximumTokens: 180,
    content:
      'Revise the rule contradicted by the new evidence. Preserve rules that continue to predict observed behavior unless the underlying state representation is invalid.',
  }),
  verification: fragment({
    id: 'verify-across-scales',
    version: 1,
    phase: 'verification',
    maximumTokens: 180,
    content:
      'Verify the candidate locally, at its integration boundaries, and at repository scope. Add a counterexample or controlled perturbation when the proposed cause may be overfit.',
  }),
  commit: fragment({
    id: 'commit-concise-result',
    version: 1,
    phase: 'commit',
    maximumTokens: 180,
    content:
      'Return the completed change, the decisive verification result, and any unresolved risk that could alter use of the result. Omit investigation history and redundant logs.',
  }),
} satisfies Readonly<Record<string, AdaptivePromptFragment>>);

export const ADAPTIVE_CONSTRAINT_FRAGMENTS = Object.freeze({
  evidenceIntegrity: fragment({
    id: 'preserve-evidence-integrity',
    version: 1,
    phase: 'constraint',
    maximumTokens: 100,
    content:
      'Use observed results rather than assumptions. Do not claim a check passed without direct recorded evidence. Preserve established observations when revising an explanation.',
  }),
  commitIntegrity: fragment({
    id: 'preserve-commit-integrity',
    version: 1,
    phase: 'constraint',
    maximumTokens: 100,
    content:
      'State only changes and verification supported by recorded evidence. Include unresolved material risk or state that none remains. Do not expose internal search details.',
  }),
} satisfies Readonly<Record<string, AdaptivePromptFragment>>);

export const INTERNAL_ADAPTIVE_PROMPTS = Object.freeze({
  worldModelProposal: internalPrompt({
    id: 'world-model.propose',
    version: 1,
    content: `Produce one executable causal model that explains the supplied observations and predicts the effects of the listed actions.

Requirements:
- Preserve every established observation.
- Represent uncertain transitions explicitly.
- Use the provided state and action contracts.
- Prefer the smallest rule set that distinguishes the unresolved outcomes.
- Do not modify evidence, evaluators, budgets, or permissions.
- Return only the requested candidate bundle.`,
  }),
  worldModelRepair: internalPrompt({
    id: 'world-model.repair',
    version: 1,
    content: `Repair the candidate causal model using the supplied counterexamples.

Requirements:
- Change the smallest causal assumption necessary.
- Preserve rules that still predict observed behavior.
- Replace the state representation only when the counterexample cannot be expressed by a local rule repair.
- Preserve deterministic outcomes exactly.
- Represent residual uncertainty explicitly.
- Return only the repaired candidate bundle and its parent identifiers.`,
  }),
  evaluationDesign: internalPrompt({
    id: 'evaluation.design',
    version: 1,
    content: `Design one evaluation that most strongly separates the remaining candidate explanations.

Requirements:
- State the competing predicted outcomes.
- Control unrelated variables.
- Prefer a deterministic evaluation when one is available.
- Minimize execution cost and irreversible effects.
- Specify the exact result projection used to distinguish the candidates.
- Return only a valid EvaluationSpec.`,
  }),
  counterfactualGeneration: internalPrompt({
    id: 'counterfactual.generate',
    version: 1,
    content: `Generate a controlled intervention that changes one decision-relevant causal variable while preserving the remaining relevant conditions.

Return:
- the intervention,
- the expected outcome under each candidate model,
- the observable result that distinguishes them,
- the minimum safe execution procedure.`,
  }),
  actionProposal: internalPrompt({
    id: 'search.propose-actions',
    version: 1,
    content: `Propose distinct next actions that can either advance the task or reduce uncertainty that could change the selected solution.

Each action must:
- have an explicit expected result,
- state which candidate explanations it separates,
- identify required permissions,
- identify expected cost,
- avoid duplicating completed evaluations.

Return only structured action proposals.`,
  }),
  trajectoryCompression: internalPrompt({
    id: 'adaptive-memory.compress',
    version: 1,
    content: `Compress the supplied trajectory into reusable task state.

Preserve:
- attempted causal explanation,
- selected evaluation,
- observed outcome,
- rules supported,
- rules contradicted,
- unresolved conflicts,
- useful artifacts,
- current verified progress.

Discard:
- narration,
- repeated logs,
- abandoned wording,
- speculative detail not used by a decision.`,
  }),
  finalResponsePlanning: internalPrompt({
    id: 'final-response.plan',
    version: 1,
    content: `Create a bounded final-response plan from the supplied committed evidence.

Return only:
- changed files,
- the decisive verification evidence references,
- unresolved material risks,
- the maximum response token budget.

Do not add claims that are not directly supported by the supplied evidence.`,
  }),
  finalClaimVerification: internalPrompt({
    id: 'final-response.verify',
    version: 1,
    immutable: true,
    content: `Verify the supplied final-response claims against the supplied immutable evidence references.

Reject:
- unsupported completion claims,
- test or typecheck claims broader than the recorded evaluation scope,
- omitted changed files,
- omitted material risks,
- internal search details,
- responses exceeding the token budget.

Return only the structured verification result.`,
  }),
});

export function fragmentForPhase(phase: AdaptivePromptPhase): AdaptivePromptFragment {
  const prompt = Object.values(ADAPTIVE_PROMPT_FRAGMENTS).find(
    (candidate) => candidate.phase === phase,
  );
  if (prompt === undefined) throw new Error(`No adaptive prompt fragment for phase: ${phase}`);
  return prompt;
}

export function constraintForPhase(
  phase: AdaptivePromptPhase,
): AdaptivePromptFragment {
  return phase === 'commit'
    ? ADAPTIVE_CONSTRAINT_FRAGMENTS.commitIntegrity
    : ADAPTIVE_CONSTRAINT_FRAGMENTS.evidenceIntegrity;
}

export function promptHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function estimatePromptTokens(content: string): number {
  return Math.ceil(Buffer.byteLength(content, 'utf8') / 3);
}

export function validateAdaptivePromptLibrary(): void {
  const solver = [
    ...Object.values(ADAPTIVE_PROMPT_FRAGMENTS),
    ...Object.values(ADAPTIVE_CONSTRAINT_FRAGMENTS),
  ];
  const identities = new Set<string>();
  for (const prompt of solver) {
    const identity = `${prompt.id}@${String(prompt.version)}`;
    if (identities.has(identity)) throw new Error(`Duplicate adaptive prompt identity: ${identity}`);
    identities.add(identity);
    if (estimatePromptTokens(prompt.content) > prompt.maximumTokens) {
      throw new Error(`Adaptive prompt exceeds its token budget: ${identity}`);
    }
    if (!prompt.hostOwned || !prompt.immutable) {
      throw new Error(`Solver prompt is not immutable and host-owned: ${identity}`);
    }
  }
  for (const [phaseKey, primary] of Object.entries(ADAPTIVE_PROMPT_FRAGMENTS)) {
    const constraint = constraintForPhase(primary.phase as AdaptivePromptPhase);
    if (primary.maximumTokens > 180 || constraint.maximumTokens > 100) {
      throw new Error(`Adaptive prompt limits are invalid for phase ${phaseKey}.`);
    }
    if (
      estimatePromptTokens(primary.content) + estimatePromptTokens(constraint.content) >
      280
    ) {
      throw new Error(`Combined adaptive prompt exceeds 280 tokens for phase ${phaseKey}.`);
    }
  }
  const internal = Object.values(INTERNAL_ADAPTIVE_PROMPTS);
  for (const prompt of internal) {
    const identity = `${prompt.id}@${String(prompt.version)}`;
    if (identities.has(identity)) throw new Error(`Duplicate adaptive prompt identity: ${identity}`);
    identities.add(identity);
    if (prompt.contentHash !== promptHash(prompt.content)) {
      throw new Error(`Internal prompt hash mismatch: ${identity}`);
    }
  }
}

validateAdaptivePromptLibrary();
