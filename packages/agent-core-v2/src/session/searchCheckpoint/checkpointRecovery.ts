import { createHash } from 'node:crypto';

import type {
  SearchCheckpoint,
  SearchCheckpointCompatibility,
  SearchCheckpointRejection,
  SearchCheckpointRejectionReason,
} from './searchCheckpoint';

export interface RecoverCheckpointInput {
  readonly checkpoints: readonly SearchCheckpoint[];
  readonly requestedHeadHash?: string;
  readonly durableLedgerHashes: ReadonlySet<string>;
  readonly compatibility: SearchCheckpointCompatibility;
}

export interface RecoverCheckpointResult {
  readonly checkpoint?: SearchCheckpoint;
  readonly exactRequestedHead: boolean;
  readonly rejected: readonly SearchCheckpointRejection[];
}

export function recoverCheckpointTail(
  input: RecoverCheckpointInput,
): RecoverCheckpointResult {
  const byHash = new Map<string, SearchCheckpoint>();
  const rejected: SearchCheckpointRejection[] = [];

  for (const checkpoint of input.checkpoints) {
    if (!verifyCheckpointHash(checkpoint)) {
      rejected.push(rejection(
        checkpoint,
        'invalid-hash',
        'Checkpoint content does not match checkpointHash.',
      ));
      continue;
    }
    if (byHash.has(checkpoint.checkpointHash)) {
      rejected.push(rejection(
        checkpoint,
        'duplicate-hash',
        'The same checkpoint hash occurs more than once.',
      ));
      continue;
    }
    byHash.set(checkpoint.checkpointHash, checkpoint);
  }

  const children = new Map<string, string[]>();
  for (const checkpoint of byHash.values()) {
    const parent = checkpoint.previousCheckpointHash;
    if (parent === null) continue;
    if (!byHash.has(parent)) {
      rejected.push(rejection(
        checkpoint,
        'missing-parent',
        `Missing parent checkpoint ${parent}.`,
      ));
      continue;
    }
    const values = children.get(parent) ?? [];
    values.push(checkpoint.checkpointHash);
    children.set(parent, values);
  }
  for (const [parent, values] of children) {
    if (values.length <= 1) continue;
    for (const child of values) {
      const checkpoint = byHash.get(child)!;
      rejected.push(rejection(
        checkpoint,
        'forked-chain',
        `Checkpoint ${parent} has ${String(values.length)} children.`,
      ));
    }
  }

  const ordered = [...byHash.values()].sort((left, right) =>
    right.createdAtSequence - left.createdAtSequence ||
    left.checkpointHash.localeCompare(right.checkpointHash),
  );
  const requested = input.requestedHeadHash === undefined
    ? undefined
    : byHash.get(input.requestedHeadHash);
  const candidates = requested === undefined
    ? ordered
    : [requested, ...ordered.filter((checkpoint) => checkpoint !== requested)];

  for (const checkpoint of candidates) {
    const chain = validateChain(checkpoint, byHash, children);
    if (!chain.valid) {
      rejected.push(rejection(checkpoint, chain.reason, chain.detail));
      continue;
    }
    if (!input.durableLedgerHashes.has(checkpoint.ledgerHeadHash)) {
      rejected.push(rejection(
        checkpoint,
        'ledger-ahead',
        `Checkpoint ledger head is not durable: ${checkpoint.ledgerHeadHash}.`,
      ));
      continue;
    }
    const incompatibility = incompatibilityReason(checkpoint, input.compatibility);
    if (incompatibility !== undefined) {
      rejected.push(rejection(checkpoint, 'incompatible', incompatibility));
      continue;
    }
    return {
      checkpoint,
      exactRequestedHead:
        input.requestedHeadHash !== undefined &&
        checkpoint.checkpointHash === input.requestedHeadHash,
      rejected: deduplicateRejections(rejected),
    };
  }

  return {
    exactRequestedHead: false,
    rejected: deduplicateRejections(rejected),
  };
}

export function checkpointChainTo(
  checkpoint: SearchCheckpoint,
  checkpoints: readonly SearchCheckpoint[],
): readonly SearchCheckpoint[] {
  const byHash = new Map(checkpoints.map((value) => [value.checkpointHash, value]));
  const chain: SearchCheckpoint[] = [];
  const seen = new Set<string>();
  let current: SearchCheckpoint | undefined = checkpoint;
  while (current !== undefined) {
    if (seen.has(current.checkpointHash)) {
      throw new Error(`Checkpoint chain cycles at ${current.checkpointHash}.`);
    }
    seen.add(current.checkpointHash);
    chain.push(current);
    current = current.previousCheckpointHash === null
      ? undefined
      : byHash.get(current.previousCheckpointHash);
  }
  return chain.reverse();
}

export function computeCheckpointHash(
  checkpoint: Omit<SearchCheckpoint, 'checkpointHash'>,
): string {
  return createHash('sha256').update(canonicalJson(checkpoint)).digest('hex');
}

export function verifyCheckpointHash(checkpoint: SearchCheckpoint): boolean {
  const { checkpointHash: _checkpointHash, ...content } = checkpoint;
  return computeCheckpointHash(content) === checkpoint.checkpointHash;
}

function validateChain(
  start: SearchCheckpoint,
  byHash: ReadonlyMap<string, SearchCheckpoint>,
  children: ReadonlyMap<string, readonly string[]>,
):
  | { readonly valid: true }
  | {
      readonly valid: false;
      readonly reason: 'missing-parent' | 'forked-chain' | 'cycle';
      readonly detail: string;
    } {
  const seen = new Set<string>();
  let current: SearchCheckpoint | undefined = start;
  while (current !== undefined) {
    if (seen.has(current.checkpointHash)) {
      return {
        valid: false,
        reason: 'cycle',
        detail: `Checkpoint chain cycles at ${current.checkpointHash}.`,
      };
    }
    seen.add(current.checkpointHash);
    const childCount = children.get(current.checkpointHash)?.length ?? 0;
    if (childCount > 1) {
      return {
        valid: false,
        reason: 'forked-chain',
        detail: `Checkpoint ${current.checkpointHash} has ${String(childCount)} children.`,
      };
    }
    const parentHash = current.previousCheckpointHash;
    if (parentHash === null) return { valid: true };
    const parent = byHash.get(parentHash);
    if (parent === undefined) {
      return {
        valid: false,
        reason: 'missing-parent',
        detail: `Checkpoint ${current.checkpointHash} references missing parent ${parentHash}.`,
      };
    }
    if (parent.createdAtSequence >= current.createdAtSequence) {
      return {
        valid: false,
        reason: 'cycle',
        detail:
          `Parent sequence ${String(parent.createdAtSequence)} is not earlier than ` +
          `child sequence ${String(current.createdAtSequence)}.`,
      };
    }
    current = parent;
  }
  return { valid: true };
}

function incompatibilityReason(
  checkpoint: SearchCheckpoint,
  compatibility: SearchCheckpointCompatibility,
): string | undefined {
  if (checkpoint.protocol !== 'adaptive-search-checkpoint/1') {
    return `Unsupported checkpoint protocol ${String(checkpoint.protocol)}.`;
  }
  if (checkpoint.architectureVersion !== compatibility.architectureVersion) {
    return (
      `Architecture ${checkpoint.architectureVersion} does not match ` +
      `${compatibility.architectureVersion}.`
    );
  }
  const keys = new Set([
    ...Object.keys(checkpoint.protocolVersions),
    ...Object.keys(compatibility.protocolVersions),
  ]);
  for (const key of [...keys].sort()) {
    if (checkpoint.protocolVersions[key] !== compatibility.protocolVersions[key]) {
      return (
        `Protocol ${key} differs: ${String(checkpoint.protocolVersions[key])} != ` +
        `${String(compatibility.protocolVersions[key])}.`
      );
    }
  }
  if (
    compatibility.configHash !== undefined &&
    checkpoint.configHash !== compatibility.configHash
  ) {
    return 'Adaptive configuration hash changed.';
  }
  if (
    compatibility.workspaceSnapshotHash !== undefined &&
    checkpoint.workspaceSnapshotHash !== compatibility.workspaceSnapshotHash
  ) {
    return 'Workspace snapshot hash changed.';
  }
  return undefined;
}

function rejection(
  checkpoint: SearchCheckpoint,
  reason: SearchCheckpointRejectionReason,
  detail: string,
): SearchCheckpointRejection {
  return {
    checkpointId: checkpoint.checkpointId,
    checkpointHash: checkpoint.checkpointHash,
    reason,
    detail,
  };
}

function deduplicateRejections(
  values: readonly SearchCheckpointRejection[],
): readonly SearchCheckpointRejection[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = `${value.checkpointHash}\u0000${value.reason}\u0000${value.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
