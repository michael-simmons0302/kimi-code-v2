import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import type {
  ProcessEvidenceRecorder,
  ProcessEvidenceSettlement,
} from '#/agent/evaluationEvidence/processEvidenceRecorder';
import { ProcessTask } from '#/agent/tools/os/bash/process-task';
import type { AgentTaskSettlement, AgentTaskSink } from '#/agent/task/types';
import type { IProcess } from '#/session/process/processRunner';

class Recorder implements ProcessEvidenceRecorder {
  taskId: string | undefined;
  readonly stdout: Uint8Array[] = [];
  readonly stderr: Uint8Array[] = [];
  readonly combined: Array<{ kind: 'stdout' | 'stderr'; bytes: Uint8Array }> = [];
  settlement: ProcessEvidenceSettlement | undefined;

  setTaskId(taskId: string): void {
    this.taskId = taskId;
  }

  append(kind: 'stdout' | 'stderr', bytes: Uint8Array): void {
    const copy = bytes.slice();
    (kind === 'stdout' ? this.stdout : this.stderr).push(copy);
    this.combined.push({ kind, bytes: copy });
  }

  async settle(settlement: ProcessEvidenceSettlement) {
    this.settlement = settlement;
    return {
      kind: 'process-execution',
      schemaVersion: 1,
      payload: { evidenceId: 'process:test' },
    } as const;
  }
}

function fakeProcess(
  run: (stdout: PassThrough, stderr: PassThrough) => void,
): IProcess {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  let exitCode: number | null = null;
  return {
    stdin,
    stdout,
    stderr,
    pid: 42,
    get exitCode() { return exitCode; },
    async wait() {
      run(stdout, stderr);
      stdout.end();
      stderr.end();
      exitCode = 0;
      return 0;
    },
    async kill() {},
    async dispose() {},
  };
}

function sink() {
  const output: string[] = [];
  let settlement: AgentTaskSettlement | undefined;
  const value: AgentTaskSink = {
    signal: new AbortController().signal,
    appendOutput: (chunk) => output.push(chunk),
    settle: async (next) => {
      settlement = next;
      return true;
    },
  };
  return { value, output, settlement: () => settlement };
}

describe('ProcessTask evidence capture', () => {
  it('preserves raw stdout and stderr chunks while decoding split UTF-8 safely', async () => {
    const recorder = new Recorder();
    const proc = fakeProcess((stdout, stderr) => {
      stdout.write(Buffer.from([0xf0, 0x9f]));
      stderr.write(Buffer.from('x'));
      stdout.write(Buffer.from([0x98, 0x80]));
    });
    const target = sink();
    const task = new ProcessTask(
      proc,
      'printf',
      'test',
      undefined,
      recorder,
      () => 5,
    );

    await task.start(target.value);

    expect(target.output.join('')).toBe('x😀');
    expect(recorder.stdout.map((value) => [...value])).toEqual([
      [0xf0, 0x9f],
      [0x98, 0x80],
    ]);
    expect(recorder.stderr.map((value) => [...value])).toEqual([[0x78]]);
    expect(recorder.combined.map(({ kind, bytes }) => [kind, [...bytes]])).toEqual([
      ['stdout', [0xf0, 0x9f]],
      ['stderr', [0x78]],
      ['stdout', [0x98, 0x80]],
    ]);
    expect(recorder.settlement).toMatchObject({
      exitCode: 0,
      timedOut: false,
      cancelled: false,
      modelOutputBytes: 5,
    });
    expect(task.evidence()?.kind).toBe('process-execution');
    expect(target.settlement()).toEqual({ status: 'completed' });
  });

  it('fails the task when evidence persistence fails', async () => {
    const recorder = new Recorder();
    recorder.settle = async () => {
      throw new Error('ledger unavailable');
    };
    const proc = fakeProcess((stdout) => stdout.write('ok'));
    const target = sink();
    const task = new ProcessTask(proc, 'echo ok', 'test', undefined, recorder);

    await task.start(target.value);

    expect(target.settlement()).toEqual({
      status: 'failed',
      stopReason: 'Process evidence persistence failed: ledger unavailable',
    });
  });
});
