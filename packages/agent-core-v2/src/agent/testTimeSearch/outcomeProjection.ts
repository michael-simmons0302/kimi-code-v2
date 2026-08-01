import { createHash } from 'node:crypto';

export const OUTCOME_PROJECTION_PROTOCOL = 'outcome-projection/1' as const;

export type ProjectedOutcome =
  | { readonly protocol: typeof OUTCOME_PROJECTION_PROTOCOL; readonly kind: 'boolean'; readonly value: boolean }
  | { readonly protocol: typeof OUTCOME_PROJECTION_PROTOCOL; readonly kind: 'categorical'; readonly key: string }
  | {
      readonly protocol: typeof OUTCOME_PROJECTION_PROTOCOL;
      readonly kind: 'scalar-bin';
      readonly bin: string;
      readonly lowerInclusive?: number;
      readonly upperExclusive?: number;
    }
  | {
      readonly protocol: typeof OUTCOME_PROJECTION_PROTOCOL;
      readonly kind: 'structured';
      readonly value: CanonicalOutcomeValue;
      readonly hash: string;
    };

export type CanonicalOutcomeValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalOutcomeValue[]
  | Readonly<Record<string, CanonicalOutcomeValue>>;

export interface ScalarOutcomeBin {
  readonly key: string;
  readonly lowerInclusive?: number;
  readonly upperExclusive?: number;
}

export interface StructuredProjectionOptions {
  readonly volatileKeys?: readonly string[];
  readonly workspaceRoot?: string;
  readonly temporaryRoots?: readonly string[];
  readonly unorderedArrayKeys?: readonly string[];
}

const DEFAULT_VOLATILE_KEYS = new Set([
  'pid',
  'processId',
  'timestamp',
  'timestampMs',
  'observedAt',
  'observedAtMs',
  'startedAt',
  'startedAtMs',
  'finishedAt',
  'finishedAtMs',
  'temporaryPath',
]);

export function projectBoolean(value: boolean): ProjectedOutcome {
  return { protocol: OUTCOME_PROJECTION_PROTOCOL, kind: 'boolean', value };
}

export function projectCategorical(key: string): ProjectedOutcome {
  if (key.length === 0) throw new Error('Categorical outcome key cannot be empty.');
  return { protocol: OUTCOME_PROJECTION_PROTOCOL, kind: 'categorical', key };
}

export function projectScalar(
  value: number,
  bins: readonly ScalarOutcomeBin[],
): ProjectedOutcome {
  if (!Number.isFinite(value)) throw new Error('Scalar outcome must be finite.');
  validateBins(bins);
  const bin = bins.find(
    (candidate) =>
      (candidate.lowerInclusive === undefined || value >= candidate.lowerInclusive) &&
      (candidate.upperExclusive === undefined || value < candidate.upperExclusive),
  );
  if (bin === undefined) throw new Error(`Scalar outcome ${String(value)} is outside all bins.`);
  return {
    protocol: OUTCOME_PROJECTION_PROTOCOL,
    kind: 'scalar-bin',
    bin: bin.key,
    lowerInclusive: bin.lowerInclusive,
    upperExclusive: bin.upperExclusive,
  };
}

export function projectStructured(
  value: unknown,
  options: StructuredProjectionOptions = {},
): ProjectedOutcome {
  const canonical = canonicalizeOutcome(value, options);
  const serialized = stableStringify(canonical);
  return {
    protocol: OUTCOME_PROJECTION_PROTOCOL,
    kind: 'structured',
    value: canonical,
    hash: createHash('sha256').update(serialized).digest('hex'),
  };
}

export function outcomeKey(outcome: ProjectedOutcome): string {
  switch (outcome.kind) {
    case 'boolean':
      return `boolean:${String(outcome.value)}`;
    case 'categorical':
      return `categorical:${outcome.key}`;
    case 'scalar-bin':
      return `scalar-bin:${outcome.bin}`;
    case 'structured':
      return `structured:${outcome.hash}`;
  }
}

export function canonicalizeOutcome(
  value: unknown,
  options: StructuredProjectionOptions = {},
  parentKey?: string,
): CanonicalOutcomeValue {
  if (value === null) return null;
  if (typeof value === 'boolean' || typeof value === 'string') {
    return typeof value === 'string' ? normalizeOutcomeString(value, options) : value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Structured outcomes cannot contain non-finite numbers.');
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    const projected = value.map((entry) => canonicalizeOutcome(entry, options, parentKey));
    const unordered = new Set(options.unorderedArrayKeys ?? []);
    return unordered.has(parentKey ?? '')
      ? [...projected].sort((left, right) => stableStringify(left).localeCompare(stableStringify(right)))
      : projected;
  }
  if (typeof value !== 'object') {
    throw new Error(`Unsupported structured outcome value: ${typeof value}.`);
  }

  const volatile = new Set([...DEFAULT_VOLATILE_KEYS, ...(options.volatileKeys ?? [])]);
  const object = value as Record<string, unknown>;
  const result: Record<string, CanonicalOutcomeValue> = {};
  for (const key of Object.keys(object).sort()) {
    if (volatile.has(key)) continue;
    const entry = object[key];
    if (entry === undefined) continue;
    result[key] = canonicalizeOutcome(entry, options, key);
  }
  return result;
}

function normalizeOutcomeString(
  value: string,
  options: StructuredProjectionOptions,
): string {
  let normalized = value.replaceAll('\\', '/');
  const roots = [options.workspaceRoot, ...(options.temporaryRoots ?? [])]
    .filter((root): root is string => root !== undefined && root.length > 0)
    .map((root) => root.replaceAll('\\', '/').replace(/\/$/, ''))
    .sort((left, right) => right.length - left.length);
  for (const root of roots) {
    if (normalized === root) return '<root>';
    if (normalized.startsWith(`${root}/`)) {
      normalized = `<root>/${normalized.slice(root.length + 1)}`;
      break;
    }
  }
  return normalized;
}

function validateBins(bins: readonly ScalarOutcomeBin[]): void {
  if (bins.length === 0) throw new Error('At least one scalar outcome bin is required.');
  const keys = new Set<string>();
  const sorted = [...bins].sort(
    (left, right) =>
      (left.lowerInclusive ?? Number.NEGATIVE_INFINITY) -
      (right.lowerInclusive ?? Number.NEGATIVE_INFINITY),
  );
  for (const bin of sorted) {
    if (bin.key.length === 0 || keys.has(bin.key)) {
      throw new Error(`Scalar outcome bin keys must be unique and non-empty: ${bin.key}`);
    }
    keys.add(bin.key);
    if (
      bin.lowerInclusive !== undefined &&
      bin.upperExclusive !== undefined &&
      bin.lowerInclusive >= bin.upperExclusive
    ) {
      throw new Error(`Invalid scalar outcome bin bounds: ${bin.key}`);
    }
  }
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (
      previous?.upperExclusive === undefined ||
      current?.lowerInclusive === undefined ||
      previous.upperExclusive > current.lowerInclusive
    ) {
      throw new Error('Scalar outcome bins must not overlap.');
    }
  }
}

function stableStringify(value: CanonicalOutcomeValue): string {
  return JSON.stringify(value);
}
