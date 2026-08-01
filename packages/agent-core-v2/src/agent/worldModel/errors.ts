import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const WorldModelErrors = {
  codes: {
    WORLD_MODEL_COMPILE_FAILED: 'world_model.compile_failed',
    WORLD_MODEL_RESOURCE_LIMIT: 'world_model.resource_limit',
    WORLD_MODEL_NO_VIABLE_MODEL: 'world_model.no_viable_model',
  },
  retryable: [],
  info: {
    'world_model.compile_failed': {
      title: 'World model compilation failed', retryable: false, public: true,
      action: 'Repair the candidate source and required executable module surface.',
    },
    'world_model.resource_limit': {
      title: 'World model resource limit exceeded', retryable: false, public: true,
      action: 'Simplify the model or raise its explicit execution budget.',
    },
    'world_model.no_viable_model': {
      title: 'No viable world model', retryable: false, public: true,
      action: 'Expand the model population or state abstraction before continuing search.',
    },
  },
} as const satisfies ErrorDomain;

registerErrorDomain(WorldModelErrors);
