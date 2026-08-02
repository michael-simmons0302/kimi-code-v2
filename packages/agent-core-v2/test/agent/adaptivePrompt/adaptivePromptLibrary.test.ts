import { describe, expect, it } from 'vitest';

import type {
  ContextInjectionProvider,
  IAgentContextInjectorService,
} from '#/agent/contextInjector/contextInjector';
import type { IAgentAdaptiveRuntimeService } from '#/agent/adaptiveRuntime/adaptiveRuntime';
import {
  ADAPTIVE_CONSTRAINT_FRAGMENTS,
  ADAPTIVE_PROMPT_FRAGMENTS,
  INTERNAL_ADAPTIVE_PROMPTS,
  constraintForPhase,
  estimatePromptTokens,
  fragmentForPhase,
  promptHash,
  validateAdaptivePromptLibrary,
  type AdaptivePromptPhase,
} from '#/agent/adaptivePrompt/adaptivePromptLibrary';
import { AgentAdaptivePromptService } from '#/agent/adaptivePrompt/adaptivePromptService';

const EXPECTED_SOLVER_PROMPTS = {
  'form-causal-hypotheses@1':
    'Identify the smallest set of materially different causes consistent with the evidence. Express each cause through behavior it predicts. Do not commit to the first explanation.',
  'choose-discriminating-evaluation@1':
    'Choose the smallest reliable check whose possible outcomes would most strongly separate the remaining explanations. Prefer direct observed evidence over additional speculation.',
  'trace-structural-effects@1':
    'Trace the affected structure through definitions, callers, imports, tests, persisted formats, generated artifacts, events, and runtime consumers before committing a change.',
  'repair-from-counterexample@1':
    'Revise the rule contradicted by the new evidence. Preserve rules that continue to predict observed behavior unless the underlying state representation is invalid.',
  'verify-across-scales@1':
    'Verify the candidate locally, at its integration boundaries, and at repository scope. Add a counterexample or controlled perturbation when the proposed cause may be overfit.',
  'commit-concise-result@1':
    'Return the completed change, the decisive verification result, and any unresolved risk that could alter use of the result. Omit investigation history and redundant logs.',
} as const;

class FakeInjector implements IAgentContextInjectorService {
  declare readonly _serviceBrand: undefined;
  readonly providers = new Map<string, ContextInjectionProvider>();
  register(name: string, provider: ContextInjectionProvider) {
    this.providers.set(name, provider);
    return { dispose: () => this.providers.delete(name) };
  }
  async injectAfterCompaction(): Promise<void> {}
}

class FakeRuntime {
  currentPhase: AdaptivePromptPhase | undefined = 'hypothesis-formation';
  enabled() { return true; }
  ensureRun() { return 'run'; }
  promptPhase() { return this.currentPhase; }
}

describe('adaptive prompt library', () => {
  it('keeps the approved solver prompts exact', () => {
    const actual = Object.fromEntries(
      Object.values(ADAPTIVE_PROMPT_FRAGMENTS).map((fragment) => [
        `${fragment.id}@${String(fragment.version)}`,
        fragment.content,
      ]),
    );
    expect(actual).toEqual(EXPECTED_SOLVER_PROMPTS);
  });

  it('contains every required internal operation prompt', () => {
    expect(Object.values(INTERNAL_ADAPTIVE_PROMPTS).map((prompt) => prompt.id).sort()).toEqual([
      'adaptive-memory.compress',
      'counterfactual.generate',
      'evaluation.design',
      'final-response.plan',
      'final-response.verify',
      'search.propose-actions',
      'world-model.propose',
      'world-model.repair',
    ]);
  });

  it('keeps all prompt hashes exact', () => {
    for (const prompt of Object.values(INTERNAL_ADAPTIVE_PROMPTS)) {
      expect(prompt.contentHash).toBe(promptHash(prompt.content));
    }
  });

  it('enforces the locked primary, constraint, and combined token budgets', () => {
    for (const primary of Object.values(ADAPTIVE_PROMPT_FRAGMENTS)) {
      const constraint = constraintForPhase(primary.phase as AdaptivePromptPhase);
      expect(primary.maximumTokens).toBeLessThanOrEqual(180);
      expect(constraint.maximumTokens).toBeLessThanOrEqual(100);
      expect(estimatePromptTokens(primary.content)).toBeLessThanOrEqual(primary.maximumTokens);
      expect(estimatePromptTokens(constraint.content)).toBeLessThanOrEqual(
        constraint.maximumTokens,
      );
      expect(
        estimatePromptTokens(primary.content) + estimatePromptTokens(constraint.content),
      ).toBeLessThanOrEqual(280);
    }
    expect(() => validateAdaptivePromptLibrary()).not.toThrow();
  });

  it('keeps solver and protected verification prompts immutable and host-owned', () => {
    for (const prompt of [
      ...Object.values(ADAPTIVE_PROMPT_FRAGMENTS),
      ...Object.values(ADAPTIVE_CONSTRAINT_FRAGMENTS),
    ]) {
      expect(prompt.hostOwned).toBe(true);
      expect(prompt.immutable).toBe(true);
      expect(Object.isFrozen(prompt)).toBe(true);
    }
    expect(INTERNAL_ADAPTIVE_PROMPTS.finalClaimVerification.immutable).toBe(true);
    expect(Object.isFrozen(INTERNAL_ADAPTIVE_PROMPTS.finalClaimVerification)).toBe(true);
  });

  it('does not expose architecture or research-framework terminology to the solver', () => {
    const solverText = [
      ...Object.values(ADAPTIVE_PROMPT_FRAGMENTS),
      ...Object.values(ADAPTIVE_CONSTRAINT_FRAGMENTS),
    ]
      .map((prompt) => prompt.content)
      .join('\n');
    expect(solverText).not.toMatch(/AlphaZero|AlphaEvolve|MCTS|PUCT|posterior|entropy|world model/i);
  });
});

describe('AgentAdaptivePromptService', () => {
  it.each<AdaptivePromptPhase>([
    'hypothesis-formation',
    'evaluation-selection',
    'cross-file-analysis',
    'candidate-repair',
    'verification',
    'commit',
  ])('selects one deterministic primary and one constraint for %s', async (phase) => {
    const runtime = new FakeRuntime();
    runtime.currentPhase = phase;
    const injector = new FakeInjector();
    const service = new AgentAdaptivePromptService(
      runtime as unknown as IAgentAdaptiveRuntimeService,
      injector,
    );
    const selection = service.current();
    expect(selection?.primary).toBe(fragmentForPhase(phase));
    expect(selection?.constraint).toBe(constraintForPhase(phase));
    expect(service.trace()).toEqual({
      protocol: 'adaptive-prompt/1',
      phase,
      fragmentIds: [selection?.primary.id, selection?.constraint.id],
      versions: [1, 1],
      contentHashes: [selection?.primaryHash, selection?.constraintHash],
    });
  });

  it('registers exactly two host-owned providers that remain available after compaction', async () => {
    const runtime = new FakeRuntime();
    const injector = new FakeInjector();
    new AgentAdaptivePromptService(
      runtime as unknown as IAgentAdaptiveRuntimeService,
      injector,
    );
    expect([...injector.providers.keys()].sort()).toEqual([
      'adaptive-constraint-fragment',
      'adaptive-operating-fragment',
    ]);
    const context = { injectedPositions: [], lastInjectedAt: null, isNewTurn: true };
    for (const provider of injector.providers.values()) {
      const first = await provider(context);
      const afterCompaction = await provider({
        injectedPositions: [1],
        lastInjectedAt: 1,
        isNewTurn: false,
      });
      expect(afterCompaction).toBe(first);
    }
  });

  it('injects no adaptive prompt when the runtime is disabled or has no active phase', () => {
    const runtime = new FakeRuntime();
    runtime.enabled = () => false;
    const disabled = new AgentAdaptivePromptService(
      runtime as unknown as IAgentAdaptiveRuntimeService,
      new FakeInjector(),
    );
    expect(disabled.current()).toBeUndefined();

    const noPhase = new FakeRuntime();
    noPhase.currentPhase = undefined;
    const inactive = new AgentAdaptivePromptService(
      noPhase as unknown as IAgentAdaptiveRuntimeService,
      new FakeInjector(),
    );
    expect(inactive.current()).toBeUndefined();
  });
});
