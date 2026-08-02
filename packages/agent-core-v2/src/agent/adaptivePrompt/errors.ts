import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const AdaptivePromptErrors = {
  codes: {
    ADAPTIVE_PROMPT_INVALID: 'adaptive_prompt.invalid',
    ADAPTIVE_PROMPT_BUDGET_EXCEEDED: 'adaptive_prompt.budget_exceeded',
  },
  retryable: [],
  info: {
    'adaptive_prompt.invalid': {
      title: 'Invalid adaptive prompt fragment', retryable: false, public: true,
      action: 'Use a registered immutable prompt fragment and valid phase routing.',
    },
    'adaptive_prompt.budget_exceeded': {
      title: 'Adaptive prompt budget exceeded', retryable: false, public: true,
      action: 'Reduce the selected fragments to the locked adaptive prompt budget.',
    },
  },
} as const satisfies ErrorDomain;

registerErrorDomain(AdaptivePromptErrors);
