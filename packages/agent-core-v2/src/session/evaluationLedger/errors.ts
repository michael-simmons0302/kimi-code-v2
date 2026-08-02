import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const EvaluationLedgerErrors = {
  codes: {
    EVIDENCE_CORRUPTED: 'evidence.corrupted',
    EVIDENCE_HASH_MISMATCH: 'evidence.hash_mismatch',
    LEDGER_APPEND_FAILED: 'ledger.append_failed',
    LEDGER_RECOVERY_FAILED: 'ledger.recovery_failed',
  },
  retryable: [],
  info: {
    'evidence.corrupted': {
      title: 'Adaptive evidence corrupted', retryable: false, public: true,
      action: 'Stop adaptive execution and restore a verified evidence ledger.',
    },
    'evidence.hash_mismatch': {
      title: 'Adaptive evidence hash mismatch', retryable: false, public: true,
      action: 'Do not continue search with the mismatched artifact or record.',
    },
    'ledger.append_failed': {
      title: 'Evidence ledger append failed', retryable: false, public: true,
      action: 'Repair persistence before continuing adaptive execution.',
    },
    'ledger.recovery_failed': {
      title: 'Evidence ledger recovery failed', retryable: false, public: true,
      action: 'Restore the most recent verified ledger and atomic head.',
    },
  },
} as const satisfies ErrorDomain;

registerErrorDomain(EvaluationLedgerErrors);
