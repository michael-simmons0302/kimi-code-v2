import { createHash } from 'node:crypto';

export const EVALUATION_ENVIRONMENT_PROTOCOL = 'evaluation-environment/1' as const;

export interface EvaluationEnvironmentManifestInput {
  readonly baselineSnapshotHash: string;
  readonly candidatePatchHash: string;
  readonly candidateWorkspaceHash: string;
  readonly operatingSystem: string;
  readonly architecture: string;
  readonly sandboxBackendId: string;
  readonly sandboxBackendVersion?: string;
  readonly nodeVersion: string;
  readonly pnpmVersion?: string;
  readonly lockfileHash?: string;
  readonly dependencyStateHash: string;
  readonly evaluatorId: string;
  readonly evaluatorVersion: string;
  readonly configurationHash: string;
  readonly permittedEnvironment: Readonly<Record<string, string>>;
  readonly seed?: string;
  readonly modelRole?: string;
  readonly modelId?: string;
  readonly structuralStateHash?: string;
}

export interface EvaluationEnvironmentManifest
  extends EvaluationEnvironmentManifestInput {
  readonly protocol: typeof EVALUATION_ENVIRONMENT_PROTOCOL;
  readonly environmentHash: string;
}

export function createEvaluationEnvironmentManifest(
  input: EvaluationEnvironmentManifestInput,
): EvaluationEnvironmentManifest {
  validateEnvironmentInput(input);
  const canonical = deepFreeze(structuredClone({
    protocol: EVALUATION_ENVIRONMENT_PROTOCOL,
    ...input,
    permittedEnvironment: sortRecord(input.permittedEnvironment),
  }));
  return Object.freeze({
    ...canonical,
    environmentHash: hashCanonical(canonical),
  });
}

export function verifyEvaluationEnvironmentManifest(
  manifest: EvaluationEnvironmentManifest,
): boolean {
  const { environmentHash, ...input } = manifest;
  return manifest.protocol === EVALUATION_ENVIRONMENT_PROTOCOL &&
    environmentHash === hashCanonical(input);
}

function validateEnvironmentInput(input: EvaluationEnvironmentManifestInput): void {
  for (const [name, value] of Object.entries({
    baselineSnapshotHash: input.baselineSnapshotHash,
    candidatePatchHash: input.candidatePatchHash,
    candidateWorkspaceHash: input.candidateWorkspaceHash,
    operatingSystem: input.operatingSystem,
    architecture: input.architecture,
    sandboxBackendId: input.sandboxBackendId,
    nodeVersion: input.nodeVersion,
    dependencyStateHash: input.dependencyStateHash,
    evaluatorId: input.evaluatorId,
    evaluatorVersion: input.evaluatorVersion,
    configurationHash: input.configurationHash,
  })) {
    if (value.trim().length === 0) {
      throw new Error(`Evaluation environment field ${name} cannot be empty.`);
    }
  }
  for (const name of Object.keys(input.permittedEnvironment)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`Invalid permitted environment variable name: ${name}`);
    }
  }
}

function sortRecord(
  value: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
    ),
  );
}

function hashCanonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
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

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
