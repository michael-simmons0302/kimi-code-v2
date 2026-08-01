export type AdaptivePromptPhase =
  | 'hypothesis-formation'
  | 'evaluation-selection'
  | 'cross-file-analysis'
  | 'candidate-repair'
  | 'verification'
  | 'commit';

export interface AdaptivePromptFragment {
  readonly id: string;
  readonly version: number;
  readonly phase: AdaptivePromptPhase;
  readonly content: string;
  readonly maximumTokens: number;
  readonly hostOwned: true;
}

export const ADAPTIVE_PROMPT_FRAGMENTS = Object.freeze({
  hypothesisFormation: Object.freeze({
    id: 'form-causal-hypotheses',
    version: 1,
    phase: 'hypothesis-formation',
    maximumTokens: 180,
    hostOwned: true,
    content:
      'Identify the smallest set of materially different causes consistent with the evidence. Express each cause through behavior it predicts. Do not commit to the first explanation.',
  }),
  evaluationSelection: Object.freeze({
    id: 'choose-discriminating-evaluation',
    version: 1,
    phase: 'evaluation-selection',
    maximumTokens: 180,
    hostOwned: true,
    content:
      'Choose the smallest reliable check whose possible outcomes would most strongly separate the remaining explanations. Prefer direct observed evidence over additional speculation.',
  }),
  crossFileAnalysis: Object.freeze({
    id: 'trace-structural-effects',
    version: 1,
    phase: 'cross-file-analysis',
    maximumTokens: 180,
    hostOwned: true,
    content:
      'Trace the affected structure through definitions, callers, imports, tests, persisted formats, generated artifacts, events, and runtime consumers before committing a change.',
  }),
  candidateRepair: Object.freeze({
    id: 'repair-from-counterexample',
    version: 1,
    phase: 'candidate-repair',
    maximumTokens: 180,
    hostOwned: true,
    content:
      'Revise the rule contradicted by the new evidence. Preserve rules that continue to predict observed behavior unless the underlying state representation is invalid.',
  }),
  verification: Object.freeze({
    id: 'verify-across-scales',
    version: 1,
    phase: 'verification',
    maximumTokens: 180,
    hostOwned: true,
    content:
      'Verify the candidate locally, at its integration boundaries, and at repository scope. Add a counterexample or controlled perturbation when the proposed cause may be overfit.',
  }),
  commit: Object.freeze({
    id: 'commit-concise-result',
    version: 1,
    phase: 'commit',
    maximumTokens: 180,
    hostOwned: true,
    content:
      'Return the completed change, the decisive verification result, and any unresolved risk that could alter use of the result. Omit investigation history and redundant logs.',
  }),
} satisfies Readonly<Record<string, AdaptivePromptFragment>>);

export const INTERNAL_ADAPTIVE_PROMPTS = Object.freeze({
  worldModelProposal: Object.freeze({
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
  worldModelRepair: Object.freeze({
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
  evaluationDesign: Object.freeze({
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
  counterfactualGeneration: Object.freeze({
    id: 'counterfactual.generate',
    version: 1,
    content: `Generate a controlled intervention that changes one decision-relevant causal variable while preserving the remaining relevant conditions.

Return:
- the intervention,
- the expected outcome under each candidate model,
- the observable result that distinguishes them,
- the minimum safe execution procedure.`,
  }),
  actionProposal: Object.freeze({
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
  trajectoryCompression: Object.freeze({
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
});

export function fragmentForPhase(phase: AdaptivePromptPhase): AdaptivePromptFragment {
  const fragment = Object.values(ADAPTIVE_PROMPT_FRAGMENTS).find(
    (candidate) => candidate.phase === phase,
  );
  if (fragment === undefined) throw new Error(`No adaptive prompt fragment for phase: ${phase}`);
  return fragment;
}
