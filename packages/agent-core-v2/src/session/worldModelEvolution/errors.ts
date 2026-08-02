import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const WorldModelEvolutionErrors = {
  codes: {
    WORLD_MODEL_EVOLUTION_UNAVAILABLE: 'world_model_evolution.unavailable',
    WORLD_MODEL_EVOLUTION_INVALID_CANDIDATE: 'world_model_evolution.invalid_candidate',
  },
  retryable: [],
  info: {
    'world_model_evolution.unavailable': {
      title: 'World model evolution unavailable', retryable: false, public: true,
      action: 'Load the program-evolution implementation before starting Evolve mode.',
    },
    'world_model_evolution.invalid_candidate': {
      title: 'Invalid evolved candidate', retryable: false, public: true,
      action: 'Reject the candidate and repair its schema, source, lineage, or protected-boundary violation.',
    },
  },
} as const satisfies ErrorDomain;

registerErrorDomain(WorldModelEvolutionErrors);
