import { describe, expect, it } from 'vitest';

import {
  PromptJsonWriter,
  PromptTranscriptWriter,
  type PromptOutput,
} from '#/cli/prompt-render';

class Output implements PromptOutput {
  value = '';
  write(chunk: string): boolean {
    this.value += chunk;
    return true;
  }
}

const status = {
  runId: 'run-1',
  phase: 'evaluating',
  evaluationsCompleted: 12,
  evaluationsActive: 1,
  viableModels: 4,
  openConflicts: 2,
  normalizedPosteriorEntropy: 0.4,
  decisionWeightedUncertainty: 0.3,
  remainingBudgetFraction: 0.7,
  verifiedCandidates: 3,
};

describe('adaptive print status', () => {
  it('emits one bounded stream-json metadata line', () => {
    const output = new Output();
    const writer = new PromptJsonWriter(output);
    writer.writeAdaptiveStatus(status);
    expect(JSON.parse(output.value)).toEqual({
      role: 'meta',
      type: 'adaptive.status.updated',
      run_id: 'run-1',
      phase: 'evaluating',
      evaluations_completed: 12,
      evaluations_active: 1,
      viable_models: 4,
      open_conflicts: 2,
      normalized_posterior_entropy: 0.4,
      decision_weighted_uncertainty: 0.3,
      remaining_budget_fraction: 0.7,
      verified_candidates: 3,
    });
  });

  it('suppresses status in ordinary text mode', () => {
    const stdout = new Output();
    const stderr = new Output();
    const writer = new PromptTranscriptWriter(stdout, stderr);
    writer.writeAdaptiveStatus(status);
    writer.finish();
    expect(stdout.value).toBe('');
    expect(stderr.value).toBe('');
  });
});
