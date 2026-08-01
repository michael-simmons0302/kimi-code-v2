import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  ADAPTIVE_ARCHITECTURE_VERSION,
  ADAPTIVE_PROTOCOL_REGISTRY,
} from '#/agent/adaptiveRuntime/adaptiveProtocol';
import {
  computeCheckpointHash,
  recoverCheckpointTail,
} from '#/session/searchCheckpoint/checkpointRecovery';
import type {
  SearchCheckpoint,
  SearchCheckpointCompatibility,
} from '#/session/searchCheckpoint/searchCheckpoint';

const compatibility: SearchCheckpointCompatibility = {
  architectureVersion: ADAPTIVE_ARCHITECTURE_VERSION,
  protocolVersions: ADAPTIVE_PROTOCOL_REGISTRY,
  configHash: 'config',
  workspaceSnapshotHash: 'workspace',
};

function ledgerHash(sequence: number): string {
  return createHash('sha256').update(`ledger-${String(sequence)}`).digest('hex');
}

function checkpoint(
  sequence: number,
  previousCheckpointHash: string | null,
  overrides: Partial<SearchCheckpoint> = {},
): SearchCheckpoint {
  const content: Omit<SearchCheckpoint, 'checkpointHash'> = {
    protocol: 'adaptive-search-checkpoint/1',
    checkpointId: `checkpoint-${String(sequence)}`,
    previousCheckpointHash,
    ledgerHeadHash: ledgerHash(sequence),
    createdAtSequence: sequence,
    architectureVersion: ADAPTIVE_ARCHITECTURE_VERSION,
    protocolVersions: ADAPTIVE_PROTOCOL_REGISTRY,
    configHash: 'config',
    workspaceSnapshotHash: 'workspace',
    state: {},
    budget: {
      maxInternalRequests: 1,
      maxEvaluations: 1,
      maxStochasticReplicates: 1,
      maxToolCalls: 1,
      maxInputTokens: 1,
      maxOutputTokens: 1,
      maxWallMs: 1,
      maxCpuMs: 1,
      maxDiskBytes: 1,
      maxCandidates: 1,
    },
    cost: {
      internalRequests: 0,
      evaluations: 0,
      stochasticReplicates: 0,
      toolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      wallMs: 0,
      cpuMs: 0,
      diskBytes: 0,
    },
    randomStates: [],
    activeEvaluators: [],
    frontierTemperature: 0.75,
    transpositions: { entries: 0, hits: 0, evictions: 0, hash: 'empty' },
    reason: 'test',
    ...overrides,
  };
  return { ...content, checkpointHash: computeCheckpointHash(content) };
}

function durable(...sequences: number[]): ReadonlySet<string> {
  return new Set(sequences.map(ledgerHash));
}

describe('recoverCheckpointTail', () => {
  it('returns the requested valid compatible head', () => {
    const first = checkpoint(1, null);
    const second = checkpoint(2, first.checkpointHash);
    const result = recoverCheckpointTail({
      checkpoints: [first, second],
      requestedHeadHash: second.checkpointHash,
      durableLedgerHashes: durable(1, 2),
      compatibility,
    });
    expect(result.checkpoint?.checkpointHash).toBe(second.checkpointHash);
    expect(result.exactRequestedHead).toBe(true);
  });

  it('falls back to the newest valid ancestor when the requested tail is corrupt', () => {
    const first = checkpoint(1, null);
    const second = checkpoint(2, first.checkpointHash);
    const corrupt = { ...second, checkpointHash: 'corrupt' };
    const result = recoverCheckpointTail({
      checkpoints: [first, corrupt],
      requestedHeadHash: corrupt.checkpointHash,
      durableLedgerHashes: durable(1, 2),
      compatibility,
    });
    expect(result.checkpoint?.checkpointHash).toBe(first.checkpointHash);
    expect(result.exactRequestedHead).toBe(false);
    expect(result.rejected).toContainEqual(
      expect.objectContaining({ checkpointHash: 'corrupt', reason: 'invalid-hash' }),
    );
  });

  it('rejects a checkpoint whose parent is missing', () => {
    const orphan = checkpoint(2, 'missing-parent');
    const result = recoverCheckpointTail({
      checkpoints: [orphan],
      durableLedgerHashes: durable(2),
      compatibility,
    });
    expect(result.checkpoint).toBeUndefined();
    expect(result.rejected).toContainEqual(
      expect.objectContaining({ reason: 'missing-parent' }),
    );
  });

  it('rejects both branches of a fork and recovers the parent', () => {
    const root = checkpoint(1, null);
    const left = checkpoint(2, root.checkpointHash);
    const right = checkpoint(3, root.checkpointHash);
    const result = recoverCheckpointTail({
      checkpoints: [root, left, right],
      durableLedgerHashes: durable(1, 2, 3),
      compatibility,
    });
    expect(result.checkpoint?.checkpointHash).toBe(root.checkpointHash);
    expect(result.rejected.filter((value) => value.reason === 'forked-chain')).toHaveLength(2);
  });

  it('rejects a chain whose parent sequence is not earlier', () => {
    const parent = checkpoint(2, null);
    const child = checkpoint(1, parent.checkpointHash);
    const result = recoverCheckpointTail({
      checkpoints: [parent, child],
      requestedHeadHash: child.checkpointHash,
      durableLedgerHashes: durable(1, 2),
      compatibility,
    });
    expect(result.checkpoint?.checkpointHash).toBe(parent.checkpointHash);
    expect(result.rejected).toContainEqual(expect.objectContaining({ reason: 'cycle' }));
  });

  it('does not restore a checkpoint ahead of durable evidence', () => {
    const first = checkpoint(1, null);
    const second = checkpoint(2, first.checkpointHash);
    const result = recoverCheckpointTail({
      checkpoints: [first, second],
      durableLedgerHashes: durable(1),
      compatibility,
    });
    expect(result.checkpoint?.checkpointHash).toBe(first.checkpointHash);
    expect(result.rejected).toContainEqual(
      expect.objectContaining({ checkpointHash: second.checkpointHash, reason: 'ledger-ahead' }),
    );
  });

  it('falls back across incompatible configuration and workspace checkpoints', () => {
    const valid = checkpoint(1, null);
    const changedConfig = checkpoint(2, valid.checkpointHash, { configHash: 'other' });
    const changedWorkspace = checkpoint(3, changedConfig.checkpointHash, {
      workspaceSnapshotHash: 'other-workspace',
    });
    const result = recoverCheckpointTail({
      checkpoints: [valid, changedConfig, changedWorkspace],
      requestedHeadHash: changedWorkspace.checkpointHash,
      durableLedgerHashes: durable(1, 2, 3),
      compatibility,
    });
    expect(result.checkpoint?.checkpointHash).toBe(valid.checkpointHash);
    expect(result.rejected.filter((value) => value.reason === 'incompatible')).toHaveLength(2);
  });
});
