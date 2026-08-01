import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const CausalRuleErrors = {
  codes: {
    CAUSAL_RULE_INVALID: 'causal_rule.invalid',
    CAUSAL_RULE_CONFLICT: 'causal_rule.conflict',
  },
  retryable: [],
  info: {
    'causal_rule.invalid': {
      title: 'Invalid causal rule', retryable: false, public: true,
      action: 'Correct the rule schema, structural references, or lineage before use.',
    },
    'causal_rule.conflict': {
      title: 'Causal rule conflict', retryable: false, public: true,
      action: 'Run a separating evaluation or split the incompatible causal rules.',
    },
  },
} as const satisfies ErrorDomain;

registerErrorDomain(CausalRuleErrors);
