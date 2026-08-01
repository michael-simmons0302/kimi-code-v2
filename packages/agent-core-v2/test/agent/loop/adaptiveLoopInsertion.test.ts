import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const LOOP_SOURCE = fileURLToPath(
  new URL('../../../src/agent/loop/loopService.ts', import.meta.url),
);

async function source(): Promise<string> {
  return readFile(LOOP_SOURCE, 'utf8');
}

function indexOfOrFail(text: string, marker: string): number {
  const index = text.indexOf(marker);
  expect(index, `missing loop marker: ${marker}`).toBeGreaterThanOrEqual(0);
  return index;
}

describe('authoritative adaptive loop insertion', () => {
  it('runs adaptive preparation after ordinary pre-step hooks and before the provider request', async () => {
    const text = await source();
    const hook = indexOfOrFail(
      text,
      'await this.hooks.onWillBeginStep.run({ turnId, step: currentStep, signal });',
    );
    const adaptive = indexOfOrFail(
      text,
      'await this.prepareAdaptiveStep(turnId, currentStep, stepUuid, signal);',
    );
    const request = indexOfOrFail(text, 'const request = this.llmRequester.start(');
    expect(hook).toBeLessThan(adaptive);
    expect(adaptive).toBeLessThan(request);
  });

  it('runs final verification and reconciliation before advisory post-step hooks', async () => {
    const text = await source();
    const finish = indexOfOrFail(
      text,
      'this.finishStep(turnId, signal, currentStep, stepUuid, response, finishReason, markStepStarted);',
    );
    const adaptive = indexOfOrFail(
      text,
      'const adaptiveStopTurn = await this.reconcileAdaptiveStep(',
    );
    const advisory = indexOfOrFail(
      text,
      'const hookStopTurn = await this.runAfterStep(',
    );
    expect(finish).toBeLessThan(adaptive);
    expect(adaptive).toBeLessThan(advisory);
  });

  it('keeps correction and ordinary adaptive continuations explicit', async () => {
    const text = await source();
    expect(text).toContain("this.enqueueAdaptiveContinuation('adaptive.final-response-correction');");
    expect(text).toContain("this.enqueueAdaptiveContinuation('adaptive.continue');");
    expect(text).toContain("admission: 'activeTurnOnly'");
    expect(text).toContain('turnScoped: true');
  });

  it('keeps adaptive failures fail-closed and the temporary bridge absent', async () => {
    const text = await source();
    expect(text).toContain("this.adaptiveRuntime.fail(\n        'infrastructure-failed'");
    expect(text).not.toContain('adaptiveLoopBridge');
    await expect(
      readFile(
        fileURLToPath(
          new URL(
            '../../../src/agent/adaptiveRuntime/adaptiveLoopBridgeService.ts',
            import.meta.url,
          ),
        ),
        'utf8',
      ),
    ).rejects.toThrow();
  });
});
