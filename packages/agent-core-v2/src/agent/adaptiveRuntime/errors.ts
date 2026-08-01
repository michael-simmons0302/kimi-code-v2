import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const AdaptiveRuntimeErrors = {
  codes: {
    ADAPTIVE_MODE_UNAVAILABLE: 'adaptive.mode_unavailable',
    ADAPTIVE_UNSUPPORTED_PLATFORM: 'adaptive.unsupported_platform',
    ADAPTIVE_BUDGET_EXHAUSTED: 'adaptive.budget_exhausted',
    ADAPTIVE_COMMIT_REJECTED: 'adaptive.commit_rejected',
  },
  retryable: [],
  info: {
    'adaptive.mode_unavailable': {
      title: 'Evolve mode unavailable',
      retryable: false,
      public: true,
      action: 'Install and load the required Evolve runtime services before starting the invocation.',
    },
    'adaptive.unsupported_platform': {
      title: 'Unsupported Evolve platform',
      retryable: false,
      public: true,
      action: 'Use a supported secure sandbox backend for this operating system.',
    },
    'adaptive.budget_exhausted': {
      title: 'Evolve budget exhausted',
      retryable: false,
      public: true,
      action: 'Review the best verified result or increase the configured adaptive budget.',
    },
    'adaptive.commit_rejected': {
      title: 'Evolve commit rejected',
      retryable: false,
      public: true,
      action: 'Resolve the reported hard gate, conflict, reconciliation, or claim-verification failure.',
    },
  },
} as const satisfies ErrorDomain;

registerErrorDomain(AdaptiveRuntimeErrors);
