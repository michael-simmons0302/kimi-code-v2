import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const CodeStructureErrors = {
  codes: {
    CODE_STRUCTURE_INDEX_FAILED: 'code_structure.index_failed',
    CODE_STRUCTURE_PARSE_FAILED: 'code_structure.parse_failed',
  },
  retryable: [],
  info: {
    'code_structure.index_failed': {
      title: 'Code structure indexing failed', retryable: false, public: true,
      action: 'Repair the workspace or parser configuration before causal analysis.',
    },
    'code_structure.parse_failed': {
      title: 'Code structure parse failed', retryable: false, public: true,
      action: 'Correct the malformed source or preserve the prior valid index until it is repaired.',
    },
  },
} as const satisfies ErrorDomain;

registerErrorDomain(CodeStructureErrors);
