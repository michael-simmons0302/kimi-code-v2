import { createHash } from 'node:crypto';

import { ADAPTIVE_PROTOCOL_REGISTRY } from '#/agent/adaptiveRuntime/adaptiveProtocol';
import type {
  AdaptiveCheckpointCompatibility,
  AdaptiveSearchCheckpoint,
} from './searchCheckpoint';

export interface RecoverCheckpointInput {
  readonly checkpoints: readonly AdaptiveSearchCheckpoint[];
  readonly requestedHeadHash?: string;
  readonly durableLedgerSequence: number;
  readonly compatibility: AdaptiveCheckpointCompatibility;
}

export interface CheckpointRecoveryRejection {
  readonly checkpointHash: string;
  readonly reason:
    | 'invalid-hash'
    | 'duplicate-hash'
    | 'missing-parent'
    | 'forked-chain'
    | 'cycle'
    | 'ledger-ahead'
    | 'incompatible';
  readonly detail: string;
}

export interface RecoverCheckpointResult {
  readonly checkpoint?: AdaptiveSearchCheckpoint;
  readonly recoveredHeadHash?: string;
  readonly exactRequestedHead: boolean;
  readonly rejected: readonly CheckpointRecoveryRejection[];
}

export function recoverCheckpointTail(
  input: RecoverCheckpointInput,
): RecoverCheckpointResult {
  if (!Number.isInteger(input.durableLedgerSequence) || input.durableLedgerSequence < 0) {
    throw new Error('durableLedgerSequence must be a non-negative integer.');
  }
  const byHash = new Map<string, AdaptiveSearchCheckpoint>();
  const rejected: CheckpointRecoveryRejection[] = [];
  for (const checkpoint of input.checkpoints) {
    if (!verifyCheckpointHash(checkpoint)) {
      rejected.push(rejection(checkpoint, 'invalid-hash', 'Checkpoint content does not match checkpointHash.'));
      continue;
    }
    if (byHash.has(checkpoint.checkpointHash)) {
      rejected.push(rejection(checkpoint, 'duplicate-hash', 'The same checkpoint hash occurs more than once.'));
      continue;
    }
    byHash.set(checkpoint.checkpointHash, checkpoint);
  }

  const children = new Map<string, string[]>();
  for (const checkpoint of byHash.values()) {
    const parent = checkpoint.previousCheckpointHash;
    if (parent === null) continue;
    if (!byHash.has(parent)) {
      rejected.push(rejection(checkpoint, 'missing-parent', `Missing parent checkpoint ${parent}.`));
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
      rejected.push(rejection(checkpoint, 'forked-chain', `Checkpoint ${parent} has ${String(values.length)} children.`));
    }
  }

  const ordered = [...byHash.values()].sort((left, right) =>
    right.sequence - left.sequence || right.createdAtMs - left.createdAtMs ||
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
    if (checkpoint.ledgerHead.sequence > input.durableLedgerSequence) {
      rejected.push(rejection(
        checkpoint,
        'ledger-ahead',
        `Checkpoint ledger sequence ${String(checkpoint.ledgerHead.sequence)} exceeds durable sequence ${String(input.durableLedgerSequence)}.`,
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
      recoveredHeadHash: checkpoint.checkpointHash,
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

export function computeCheckpointHash(
  checkpoint: Omit<AdaptiveSearchCheckpoint, 'checkpointHash'>,
): string {
  return createHash('sha256').update(canonicalJson(checkpoint)).digest('hex');
}

export function verifyCheckpointHash(checkpoint: AdaptiveSearchCheckpoint): boolean {
  const { checkpointHash: _checkpointHash, ...content } = checkpoint;
  return computeCheckpointHash(content) === checkpoint.checkpointHash;
}

function validateChain(
  start: AdaptiveSearchCheckpoint,
  byHash: ReadonlyMap<string, AdaptiveSearchCheckpoint>,
  children: ReadonlyMap<string, readonly string[]>,
):
  | { readonly valid: true }
  | {
      readonly valid: false;
      readonly reason: 'missing-parent' | 'forked-chain' | 'cycle';
      readonly detail: string;
    } {
  const seen = new Set<string>();
  let current: AdaptiveSearchCheckpoint | undefined = start;
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
    if (parent.sequence >= current.sequence) {
      return {
        valid: false,
        reason: 'cycle',
        detail: `Parent sequence ${String(parent.sequence)} is not earlier than child sequence ${String(current.sequence)}.`,
      };
    }
    current = parent;
  }
  return { valid: true };
}

function incompatibilityReason(
  checkpoint: AdaptiveSearchCheckpoint,
  compatibility: AdaptiveCheckpointCompatibility,
): string | undefined {
  if (checkpoint.protocol !== 'adaptive-search-checkpoint/1') {
    return `Unsupported checkpoint protocol ${String(checkpoint.protocol)}.`;
  }
  if (checkpoint.architectureVersion !== compatibility.architectureVersion) {
    return `Architecture ${checkpoint.architectureVersion} does not match ${compatibility.architectureVersion}.`;
  }
  if (checkpoint.configHash !== compatibility.configHash) {
    return 'Adaptive configuration hash changed.';
  }
  if (checkpoint.workspaceSnapshotHash !== compatibility.workspaceSnapshotHash) {
    return 'Workspace snapshot hash changed.';
  }
  for (const [name, version] of Object.entries(ADAPTIVE_PROTOCOL_REGISTRY)) {
    const expected = compatibility.protocolVersions[name];
    if (expected !== undefined && expected !== version) {
      return `Runtime protocol registry is inconsistent for ${name}.`;
    }
    const persisted = checkpoint.protocolVersions[name];
    if (persisted !== undefined && persisted !== version) {
      return `Checkpoint protocol ${name}=${persisted} does not match ${version}.`;
    }
  }
  return undefined;
}

function rejection(
  checkpoint: AdaptiveSearchCheckpoint,
  reason: CheckpointRecoveryRejection['reason'],
  detail: string,
): CheckpointRecoveryRejection {
  return { checkpointHash: checkpoint.checkpointHash, reason, detail };
}

function deduplicateRejections(
  values: readonly CheckpointRecoveryRejection[],
): readonly CheckpointRecoveryRejection[] {
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
