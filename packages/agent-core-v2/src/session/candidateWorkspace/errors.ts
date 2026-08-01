import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const CandidateWorkspaceErrors = {
  codes: {
    BASELINE_SNAPSHOT_FAILED: 'candidate_workspace.baseline_snapshot_failed',
    CANDIDATE_WORKSPACE_CONFLICT: 'candidate_workspace.conflict',
    LIVE_WORKSPACE_CHANGED: 'candidate_workspace.live_changed',
    CANDIDATE_PATCH_REJECTED: 'candidate_workspace.patch_rejected',
  },
  retryable: [],
  info: {
    'candidate_workspace.baseline_snapshot_failed': {
      title: 'Baseline snapshot failed', retryable: false, public: true,
      action: 'Resolve workspace read or repository-state errors before adaptive evaluation.',
    },
    'candidate_workspace.conflict': {
      title: 'Candidate workspace conflict', retryable: false, public: true,
      action: 'Rebase or regenerate the candidate against the frozen baseline.',
    },
    'candidate_workspace.live_changed': {
      title: 'Live workspace changed', retryable: false, public: true,
      action: 'Capture a new baseline, rebase the candidate, and rerun affected hard gates.',
    },
    'candidate_workspace.patch_rejected': {
      title: 'Candidate patch rejected', retryable: false, public: true,
      action: 'Correct the patch path, base, or conflicting hunks before evaluation.',
    },
  },
} as const satisfies ErrorDomain;

registerErrorDomain(CandidateWorkspaceErrors);
