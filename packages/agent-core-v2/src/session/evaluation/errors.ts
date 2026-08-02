import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const EvaluationErrors = {
  codes: {
    EVALUATION_INVALID: 'evaluation.invalid',
    EVALUATOR_UNAVAILABLE: 'evaluation.evaluator_unavailable',
    EVALUATION_TIMED_OUT: 'evaluation.timed_out',
    EVALUATION_INFRASTRUCTURE_FAILED: 'evaluation.infrastructure_failed',
  },
  retryable: ['evaluation.infrastructure_failed'],
  info: {
    'evaluation.invalid': {
      title: 'Invalid evaluation', retryable: false, public: true,
      action: 'Correct the evaluation specification or evaluator input.',
    },
    'evaluation.evaluator_unavailable': {
      title: 'Evaluator unavailable', retryable: false, public: true,
      action: 'Register the required evaluator and version before scheduling the evaluation.',
    },
    'evaluation.timed_out': {
      title: 'Evaluation timed out', retryable: false, public: true,
      action: 'Reduce the evaluation scope or raise its explicit timeout budget.',
    },
    'evaluation.infrastructure_failed': {
      title: 'Evaluation infrastructure failed', retryable: true, public: true,
      action: 'Repair the evaluator environment and retry without treating the candidate as failed.',
    },
  },
} as const satisfies ErrorDomain;

registerErrorDomain(EvaluationErrors);
