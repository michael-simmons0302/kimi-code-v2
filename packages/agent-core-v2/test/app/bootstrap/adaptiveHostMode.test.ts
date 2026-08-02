import type { KimiHostIdentity } from '@moonshot-ai/kimi-code-oauth';
import { describe, expect, it } from 'vitest';

import {
  resolveBootstrapOptions,
  resolveHostArgs,
  withAdaptiveHostMode,
} from '#/app/bootstrap/bootstrap';

const IDENTITY = {} as KimiHostIdentity;

describe('adaptive HostArgs', () => {
  it('defaults to disabled', () => {
    expect(resolveHostArgs(undefined).adaptiveMode).toBe('disabled');
  });

  it('uses an explicit input ahead of invocation overrides', () => {
    const args = withAdaptiveHostMode('enabled', () =>
      resolveHostArgs({ adaptiveMode: 'disabled' }),
    );
    expect(args.adaptiveMode).toBe('disabled');
  });

  it('carries an invocation-scoped override into the frozen snapshot', () => {
    const args = withAdaptiveHostMode('enabled', () => resolveHostArgs(undefined));
    expect(args.adaptiveMode).toBe('enabled');
    expect(Object.isFrozen(args)).toBe(true);
  });

  it('restores nested invocation overrides without leaking mode', () => {
    const observed: string[] = [];
    withAdaptiveHostMode('enabled', () => {
      observed.push(resolveHostArgs(undefined).adaptiveMode);
      withAdaptiveHostMode('disabled', () => {
        observed.push(resolveHostArgs(undefined).adaptiveMode);
      });
      observed.push(resolveHostArgs(undefined).adaptiveMode);
    });
    observed.push(resolveHostArgs(undefined).adaptiveMode);
    expect(observed).toEqual(['enabled', 'disabled', 'enabled', 'disabled']);
  });

  it('copies and freezes mutable input collections', () => {
    const headers: Record<string, string> = { Authorization: 'redacted' };
    const skills = ['a'];
    const agents = ['b'];
    const args = resolveHostArgs({
      requestHeaders: headers,
      skillDirs: skills,
      agentFiles: agents,
      adaptiveMode: 'enabled',
    });
    headers.Authorization = 'changed';
    skills.push('changed');
    agents.push('changed');
    expect(args.requestHeaders.Authorization).toBe('redacted');
    expect(args.skillDirs).toEqual(['a']);
    expect(args.agentFiles).toEqual(['b']);
    expect(Object.isFrozen(args.requestHeaders)).toBe(true);
    expect(Object.isFrozen(args.skillDirs)).toBe(true);
    expect(Object.isFrozen(args.agentFiles)).toBe(true);
  });

  it('freezes the complete bootstrap option snapshot', () => {
    const options = resolveBootstrapOptions({
      homeDir: '/tmp/kimi-home',
      osHomeDir: '/tmp',
      cwd: '/workspace',
      env: {},
      platform: 'linux',
      arch: 'x64',
      clientIdentity: IDENTITY,
      args: { adaptiveMode: 'enabled' },
    });
    expect(options.args.adaptiveMode).toBe('enabled');
    expect(Object.isFrozen(options)).toBe(true);
    expect(Object.isFrozen(options.args)).toBe(true);
  });
});
