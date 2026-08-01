import { createHash } from 'node:crypto';

import { createDecorator } from '#/_base/di/instantiation';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IConfigService } from '#/app/config/config';
import {
  ADAPTIVE_SECTION,
  AdaptiveConfigSchema,
  resolveAdaptiveModelRoles,
  type AdaptiveConfig,
  type ResolvedAdaptiveModelRoles,
} from './configSection';

export interface AdaptiveConfigSnapshot {
  readonly config: AdaptiveConfig;
  readonly hash: string;
}

export interface ISessionAdaptiveConfigService {
  readonly _serviceBrand: undefined;
  snapshot(): AdaptiveConfigSnapshot;
  modelRoles(primaryModel: string): ResolvedAdaptiveModelRoles;
}

export const ISessionAdaptiveConfigService = createDecorator<ISessionAdaptiveConfigService>(
  'sessionAdaptiveConfigService',
);

export class SessionAdaptiveConfigService implements ISessionAdaptiveConfigService {
  declare readonly _serviceBrand: undefined;
  private readonly resolved: AdaptiveConfigSnapshot;

  constructor(@IConfigService config: IConfigService) {
    const parsed = AdaptiveConfigSchema.parse(config.get<unknown>(ADAPTIVE_SECTION));
    const frozen = deepFreeze(structuredClone(parsed));
    this.resolved = Object.freeze({
      config: frozen,
      hash: createHash('sha256').update(canonicalJson(frozen)).digest('hex'),
    });
  }

  snapshot(): AdaptiveConfigSnapshot {
    return this.resolved;
  }

  modelRoles(primaryModel: string): ResolvedAdaptiveModelRoles {
    return Object.freeze(
      resolveAdaptiveModelRoles(this.resolved.config.models, primaryModel),
    );
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, current: unknown) => {
    if (current !== null && typeof current === 'object' && !Array.isArray(current)) {
      const object = current as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(object)
          .sort()
          .filter((key) => object[key] !== undefined)
          .map((key) => [key, object[key]]),
      );
    }
    return current;
  });
}

registerScopedService(
  LifecycleScope.Session,
  ISessionAdaptiveConfigService,
  SessionAdaptiveConfigService,
  ScopeActivation.OnScopeCreated,
  'adaptiveConfig',
);
