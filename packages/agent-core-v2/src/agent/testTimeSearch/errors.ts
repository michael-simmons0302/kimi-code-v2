import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const TestTimeSearchErrors = {
  codes: {
    SEARCH_CHECKPOINT_INCOMPATIBLE: 'search.checkpoint_incompatible',
    SEARCH_BUDGET_EXHAUSTED: 'search.budget_exhausted',
    SEARCH_COMMIT_REJECTED: 'search.commit_rejected',
  },
  retryable: [],
  info: {
    'search.checkpoint_incompatible': {
      title: 'Search checkpoint incompatible', retryable: false, public: true,
      action: 'Resume from a compatible checkpoint or begin a new search episode.',
    },
    'search.budget_exhausted': {
      title: 'Search budget exhausted', retryable: false, public: true,
      action: 'Use the best verified candidate or increase the explicit search budget.',
    },
    'search.commit_rejected': {
      title: 'Search commit rejected', retryable: false, public: true,
      action: 'Resolve the failed commit gate before selecting a final solution.',
    },
  },
} as const satisfies ErrorDomain;

registerErrorDomain(TestTimeSearchErrors);
