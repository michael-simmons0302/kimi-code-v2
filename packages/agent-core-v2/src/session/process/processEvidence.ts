import { createHash } from 'node:crypto';

export const PROCESS_EVIDENCE_PROTOCOL = 'process-evidence/1' as const;

export interface ProcessEvidenceArtifact {
  readonly artifactHash: string;
  readonly byteLength: number;
  readonly mediaType: string;
  readonly stream: 'stdout' | 'stderr' | 'combined';
}

export interface ProcessEvidenceInput {
  readonly command: readonly string[] | string;
  readonly shell: boolean;
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly startedAtMonotonicMs: number;
  readonly endedAtMonotonicMs: number;
  readonly exitCode: number | null;
  readonly terminationSignal?: string;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly background: boolean;
  readonly taskId?: string;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly modelOutputBytes?: number;
  readonly resourceUsage?: Readonly<{
    cpuUserMicros?: number;
    cpuSystemMicros?: number;
    maximumResidentSetBytes?: number;
  }>;
}

export interface ProcessEvidenceEnvelope {
  readonly protocol: typeof PROCESS_EVIDENCE_PROTOCOL;
  readonly command: readonly string[] | string;
  readonly commandHash: string;
  readonly shell: boolean;
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly environmentHash: string;
  readonly startedAtMonotonicMs: number;
  readonly endedAtMonotonicMs: number;
  readonly durationMs: number;
  readonly exitCode: number | null;
  readonly terminationSignal?: string;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly background: boolean;
  readonly taskId?: string;
  readonly stdout: ProcessEvidenceArtifact;
  readonly stderr: ProcessEvidenceArtifact;
  readonly combined: ProcessEvidenceArtifact;
  readonly modelOutputBytes: number;
  readonly modelOutputTruncated: boolean;
  readonly resourceUsage?: ProcessEvidenceInput['resourceUsage'];
  readonly evidenceHash: string;
}

export interface MaterializedProcessEvidence {
  readonly envelope: ProcessEvidenceEnvelope;
  readonly artifacts: Readonly<{
    stdout: Uint8Array;
    stderr: Uint8Array;
    combined: Uint8Array;
  }>;
}

export function createProcessEvidence(
  input: ProcessEvidenceInput,
): MaterializedProcessEvidence {
  validateInput(input);
  const stdout = input.stdout.slice();
  const stderr = input.stderr.slice();
  const combined = combineStreams(stdout, stderr);
  const stdoutArtifact = artifact(stdout, 'stdout');
  const stderrArtifact = artifact(stderr, 'stderr');
  const combinedArtifact = artifact(combined, 'combined');
  const environment = Object.freeze(sortRecord(input.environment));
  const command = Array.isArray(input.command)
    ? Object.freeze([...input.command])
    : input.command;
  const base = deepFreeze({
    protocol: PROCESS_EVIDENCE_PROTOCOL,
    command,
    commandHash: hashCanonical(command),
    shell: input.shell,
    cwd: input.cwd,
    environment,
    environmentHash: hashCanonical(environment),
    startedAtMonotonicMs: input.startedAtMonotonicMs,
    endedAtMonotonicMs: input.endedAtMonotonicMs,
    durationMs: input.endedAtMonotonicMs - input.startedAtMonotonicMs,
    exitCode: input.exitCode,
    terminationSignal: input.terminationSignal,
    timedOut: input.timedOut,
    cancelled: input.cancelled,
    background: input.background,
    taskId: input.taskId,
    stdout: stdoutArtifact,
    stderr: stderrArtifact,
    combined: combinedArtifact,
    modelOutputBytes: input.modelOutputBytes ?? combined.byteLength,
    modelOutputTruncated:
      (input.modelOutputBytes ?? combined.byteLength) < combined.byteLength,
    resourceUsage: input.resourceUsage,
  });
  return {
    envelope: Object.freeze({
      ...base,
      evidenceHash: hashCanonical(base),
    }),
    artifacts: Object.freeze({ stdout, stderr, combined }),
  };
}

export function verifyProcessEvidence(
  materialized: MaterializedProcessEvidence,
): boolean {
  const { evidenceHash, ...base } = materialized.envelope;
  return evidenceHash === hashCanonical(base) &&
    verifyArtifact(materialized.envelope.stdout, materialized.artifacts.stdout) &&
    verifyArtifact(materialized.envelope.stderr, materialized.artifacts.stderr) &&
    verifyArtifact(materialized.envelope.combined, materialized.artifacts.combined);
}

function validateInput(input: ProcessEvidenceInput): void {
  if (Array.isArray(input.command)) {
    if (input.command.length === 0 || input.command.some((part) => part.length === 0)) {
      throw new Error('Process evidence command argv must contain non-empty entries.');
    }
  } else if (input.command.trim().length === 0) {
    throw new Error('Process evidence shell source cannot be empty.');
  }
  if (input.cwd.trim().length === 0) throw new Error('Process evidence cwd cannot be empty.');
  if (
    !Number.isFinite(input.startedAtMonotonicMs) ||
    !Number.isFinite(input.endedAtMonotonicMs) ||
    input.endedAtMonotonicMs < input.startedAtMonotonicMs
  ) {
    throw new Error('Process evidence monotonic timestamps are invalid.');
  }
  if (input.exitCode !== null && !Number.isInteger(input.exitCode)) {
    throw new Error('Process evidence exitCode must be an integer or null.');
  }
  if (input.background && input.taskId?.trim().length !== input.taskId?.length) {
    throw new Error('Process evidence taskId cannot contain surrounding whitespace.');
  }
  if (input.background && (input.taskId === undefined || input.taskId.length === 0)) {
    throw new Error('Background process evidence requires a taskId.');
  }
  if (
    input.modelOutputBytes !== undefined &&
    (!Number.isInteger(input.modelOutputBytes) || input.modelOutputBytes < 0)
  ) {
    throw new Error('Process evidence modelOutputBytes must be non-negative.');
  }
  for (const name of Object.keys(input.environment)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`Invalid process environment variable name: ${name}`);
    }
  }
}

function artifact(
  bytes: Uint8Array,
  stream: ProcessEvidenceArtifact['stream'],
): ProcessEvidenceArtifact {
  return Object.freeze({
    artifactHash: createHash('sha256').update(bytes).digest('hex'),
    byteLength: bytes.byteLength,
    mediaType: 'application/octet-stream',
    stream,
  });
}

function verifyArtifact(
  artifactValue: ProcessEvidenceArtifact,
  bytes: Uint8Array,
): boolean {
  return artifactValue.byteLength === bytes.byteLength &&
    artifactValue.artifactHash === createHash('sha256').update(bytes).digest('hex');
}

function combineStreams(stdout: Uint8Array, stderr: Uint8Array): Uint8Array {
  const combined = new Uint8Array(stdout.byteLength + stderr.byteLength);
  combined.set(stdout, 0);
  combined.set(stderr, stdout.byteLength);
  return combined;
}

function sortRecord(
  value: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function hashCanonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, current: unknown) => {
    if (current instanceof Uint8Array) return Buffer.from(current).toString('base64');
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
