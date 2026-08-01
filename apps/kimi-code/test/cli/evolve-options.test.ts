import { afterEach, describe, expect, it } from 'vitest';

import { createProgram } from '#/cli/commands';
import {
  KIMI_V2_ENV,
  isKimiV2Enabled,
  setKimiV2InvocationOverride,
  shouldUseKimiV2,
} from '#/cli/experimental-v2';
import type { CLIOptions } from '#/cli/options';
import { OptionConflictError, validateOptions } from '#/cli/options';

function parse(argv: readonly string[]): CLIOptions {
  let captured: CLIOptions | undefined;
  const program = createProgram('0.0.0-test', (options) => {
    captured = options;
  }, () => {});
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  program.parse(['node', 'kimi', ...argv]);
  if (captured === undefined) throw new Error('Main action handler was not called.');
  return captured;
}

afterEach(() => {
  setKimiV2InvocationOverride(false);
});

describe('--evolve parsing and validation', () => {
  it('is disabled by default', () => {
    expect(parse([]).evolve).toBe(false);
  });

  it('is enabled by --evolve', () => {
    expect(parse(['--evolve']).evolve).toBe(true);
  });

  it('is documented with the locked help text', () => {
    const help = createProgram('0.0.0-test', () => {}, () => {}).helpInformation();
    expect(help).toContain('--evolve');
    expect(help).toContain(
      'Enable evaluation-guided test-time adaptation using executable causal models.',
    );
  });

  it.each([
    ['--evolve'],
    ['--evolve', '--yolo'],
    ['--evolve', '--auto'],
    ['--evolve', '--continue'],
    ['--evolve', '--session', 'ses_123'],
    ['--evolve', '--prompt', 'fix the repository'],
  ])('accepts %s', (...argv) => {
    const options = parse(argv);
    expect(options.evolve).toBe(true);
    expect(() => validateOptions(options, {})).not.toThrow();
  });

  it('rejects --evolve with --plan using the locked message', () => {
    const options = parse(['--evolve', '--plan']);
    expect(() => validateOptions(options, {})).toThrow(OptionConflictError);
    expect(() => validateOptions(options, {})).toThrow(
      'Cannot combine --evolve with --plan. Evolve mode performs evaluations and may execute candidate changes.',
    );
  });

  it('preserves the prompt and yolo conflict', () => {
    const options = parse(['--evolve', '--prompt', 'fix it', '--yolo']);
    expect(() => validateOptions(options, {})).toThrow('Cannot combine --prompt with --yolo.');
  });

  it('preserves the prompt and auto conflict', () => {
    const options = parse(['--evolve', '--prompt', 'fix it', '--auto']);
    expect(() => validateOptions(options, {})).toThrow('Cannot combine --prompt with --auto.');
  });

  it('preserves hidden yolo aliases', () => {
    expect(parse(['--evolve', '--yes']).yolo).toBe(true);
    expect(parse(['--evolve', '--auto-approve']).yolo).toBe(true);
  });
});

describe('Evolve v2 routing', () => {
  it('routes shell mode to v2 when --evolve is enabled', () => {
    expect(shouldUseKimiV2({ evolve: true }, {})).toBe(true);
  });

  it('does not route an ordinary shell invocation to v2 without the master switch', () => {
    expect(shouldUseKimiV2({ evolve: false }, {})).toBe(false);
  });

  it('preserves the environment-controlled v2 route', () => {
    expect(shouldUseKimiV2({ evolve: false }, { [KIMI_V2_ENV]: '1' })).toBe(true);
  });

  it('routes native prompt mode through the invocation override', () => {
    setKimiV2InvocationOverride(true);
    expect(isKimiV2Enabled({})).toBe(true);
  });

  it('does not mutate process.env when enabling Evolve routing', () => {
    const before = { ...process.env };
    setKimiV2InvocationOverride(true);
    expect(process.env).toEqual(before);
    expect(process.env[KIMI_V2_ENV]).toBe(before[KIMI_V2_ENV]);
  });

  it('does not enable the general experimental environment switch', () => {
    const before = process.env[KIMI_V2_ENV];
    setKimiV2InvocationOverride(true);
    expect(process.env[KIMI_V2_ENV]).toBe(before);
  });
});
