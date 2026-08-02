import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const StructuralSignalErrors = {
  codes: {
    STRUCTURAL_SIGNAL_OVERFLOW: 'structural_signal.overflow',
    STRUCTURAL_REDUCER_FAILED: 'structural_signal.reducer_failed',
  },
  retryable: [],
  info: {
    'structural_signal.overflow': {
      title: 'Structural signal queue overflow', retryable: false, public: true,
      action: 'Stop commit, drain or restore the queue, and replay all lossless structural facts.',
    },
    'structural_signal.reducer_failed': {
      title: 'Structural signal reducer failed', retryable: false, public: true,
      action: 'Restore the last reducer sequence and replay later signals transactionally.',
    },
  },
} as const satisfies ErrorDomain;

registerErrorDomain(StructuralSignalErrors);
