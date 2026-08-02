import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const EvaluationSandboxErrors = {
  codes: {
    SANDBOX_UNAVAILABLE: 'sandbox.unavailable',
    SANDBOX_CAPABILITY_DENIED: 'sandbox.capability_denied',
    SANDBOX_RESOURCE_LIMIT: 'sandbox.resource_limit',
  },
  retryable: [],
  info: {
    'sandbox.unavailable': {
      title: 'Secure sandbox unavailable', retryable: false, public: true,
      action: 'Install and configure the required secure backend before using Evolve mode.',
    },
    'sandbox.capability_denied': {
      title: 'Sandbox capability denied', retryable: false, public: true,
      action: 'Remove the undeclared capability or register an evaluator that explicitly requires it.',
    },
    'sandbox.resource_limit': {
      title: 'Sandbox resource limit exceeded', retryable: false, public: true,
      action: 'Reduce candidate resource use or raise the explicit sandbox budget.',
    },
  },
} as const satisfies ErrorDomain;

registerErrorDomain(EvaluationSandboxErrors);
