import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const AdaptiveMemoryErrors = {
  codes: {
    ADAPTIVE_MEMORY_INVALID_SUMMARY: 'adaptive_memory.invalid_summary',
    ADAPTIVE_MEMORY_UNSUPPORTED_EVIDENCE: 'adaptive_memory.unsupported_evidence',
  },
  retryable: [],
  info: {
    'adaptive_memory.invalid_summary': {
      title: 'Invalid adaptive summary', retryable: false, public: true,
      action: 'Correct the summary schema and ensure every claim is evidence-backed.',
    },
    'adaptive_memory.unsupported_evidence': {
      title: 'Unsupported adaptive memory evidence', retryable: false, public: true,
      action: 'Reference only evidence present in the immutable ledger.',
    },
  },
} as const satisfies ErrorDomain;

registerErrorDomain(AdaptiveMemoryErrors);
