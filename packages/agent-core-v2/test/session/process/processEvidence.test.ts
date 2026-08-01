import { describe, expect, it } from 'vitest';

import {
  createProcessEvidence,
  verifyProcessEvidence,
} from '#/session/process/processEvidence';

const encoder = new TextEncoder();

function input() {
  return {
    command: ['pnpm', 'typecheck'] as const,
    shell: false,
    cwd: '/workspace',
    environment: { CI: '1', LANG: 'C.UTF-8' },
    startedAtMonotonicMs: 100,
    endedAtMonotonicMs: 125,
    exitCode: 0,
    timedOut: false,
    cancelled: false,
    background: false,
    stdout: encoder.encode('ok\n'),
    stderr: encoder.encode('warning\n'),
    modelOutputBytes: 3,
    resourceUsage: {
      cpuUserMicros: 1000,
      cpuSystemMicros: 500,
      maximumResidentSetBytes: 1024,
    },
  };
}

describe('createProcessEvidence', () => {
  it('creates a verifiable immutable process envelope', () => {
    const materialized = createProcessEvidence(input());
    expect(materialized.envelope).toMatchObject({
      protocol: 'process-evidence/1',
      command: ['pnpm', 'typecheck'],
      cwd: '/workspace',
      durationMs: 25,
      exitCode: 0,
      timedOut: false,
      cancelled: false,
      background: false,
      modelOutputBytes: 3,
      modelOutputTruncated: true,
      stdout: { byteLength: 3, stream: 'stdout' },
      stderr: { byteLength: 8, stream: 'stderr' },
      combined: { byteLength: 11, stream: 'combined' },
    });
    expect(Object.isFrozen(materialized.envelope)).toBe(true);
    expect(Object.isFrozen(materialized.envelope.environment)).toBe(true);
    expect(verifyProcessEvidence(materialized)).toBe(true);
  });

  it('preserves caller-supplied interleaving independently of stream totals', () => {
    const combined = Uint8Array.from([0xf0, 0x9f, 0x78, 0x98, 0x80]);
    const materialized = createProcessEvidence({
      ...input(),
      stdout: Uint8Array.from([0xf0, 0x9f, 0x98, 0x80]),
      stderr: Uint8Array.from([0x78]),
      combined,
      modelOutputBytes: 1,
    });
    expect([...materialized.artifacts.combined]).toEqual([...combined]);
    expect(materialized.envelope.combined.byteLength).toBe(5);
    expect(materialized.envelope.modelOutputTruncated).toBe(true);
    expect(verifyProcessEvidence(materialized)).toBe(true);
  });

  it('hashes environment variables independent of property order', () => {
    const first = createProcessEvidence(input());
    const second = createProcessEvidence({
      ...input(),
      environment: { LANG: 'C.UTF-8', CI: '1' },
    });
    expect(first.envelope.environmentHash).toBe(second.envelope.environmentHash);
    expect(first.envelope.evidenceHash).toBe(second.envelope.evidenceHash);
  });

  it('detects artifact tampering', () => {
    const materialized = createProcessEvidence(input());
    materialized.artifacts.stdout[0] = 0;
    expect(verifyProcessEvidence(materialized)).toBe(false);
  });

  it('supports shell source and background task identity', () => {
    const materialized = createProcessEvidence({
      ...input(),
      command: 'pnpm typecheck && pnpm test',
      shell: true,
      background: true,
      taskId: 'task-1',
    });
    expect(materialized.envelope).toMatchObject({
      command: 'pnpm typecheck && pnpm test',
      shell: true,
      background: true,
      taskId: 'task-1',
    });
  });

  it('records timeout, cancellation, signals, and null exit status separately', () => {
    const materialized = createProcessEvidence({
      ...input(),
      exitCode: null,
      terminationSignal: 'SIGTERM',
      timedOut: true,
      cancelled: true,
    });
    expect(materialized.envelope).toMatchObject({
      exitCode: null,
      terminationSignal: 'SIGTERM',
      timedOut: true,
      cancelled: true,
    });
  });

  it('rejects invalid command, time, environment, and background identity', () => {
    expect(() => createProcessEvidence({ ...input(), command: [] })).toThrow('command argv');
    expect(() =>
      createProcessEvidence({
        ...input(),
        endedAtMonotonicMs: 99,
      }),
    ).toThrow('timestamps');
    expect(() =>
      createProcessEvidence({
        ...input(),
        environment: { 'BAD-NAME': '1' },
      }),
    ).toThrow('environment variable');
    expect(() =>
      createProcessEvidence({
        ...input(),
        background: true,
      }),
    ).toThrow('requires a taskId');
  });
});
