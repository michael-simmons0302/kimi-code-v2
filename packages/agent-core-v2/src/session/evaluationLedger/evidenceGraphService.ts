import { createHash, randomUUID } from 'node:crypto';

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import type { EvidenceId } from '#/agent/adaptiveRuntime/adaptiveProtocol';
import {
  EVIDENCE_GRAPH_PROTOCOL,
  ISessionEvidenceGraphService,
  type AppendEvidenceLinkInput,
  type EvidenceGraphSnapshot,
  type EvidenceLink,
  type EvidenceNode,
  type EvidenceNodeType,
  type EvidenceRelation,
  type EvidenceTraversalOptions,
} from './evidenceGraph';
import {
  ISessionEvaluationLedgerService,
  type EvaluationLedgerRecord,
  type EvaluationLedgerRecordType,
} from './evaluationLedger';

const NON_CAUSAL_RELATIONS = new Set<EvidenceRelation>(['references']);

interface PersistedLinkPayload {
  readonly protocol: typeof EVIDENCE_GRAPH_PROTOCOL;
  readonly linkId: string;
  readonly fromEvidenceId: EvidenceId;
  readonly toEvidenceId: EvidenceId;
  readonly relation: EvidenceRelation;
  readonly contentHash: string;
}

export class SessionEvidenceGraphService
  extends Disposable
  implements ISessionEvidenceGraphService
{
  declare readonly _serviceBrand: undefined;

  private readonly nodes = new Map<EvidenceId, EvidenceNode>();
  private readonly links = new Map<string, EvidenceLink>();
  private loadedSequence = 0;
  private synchronization: Promise<void> = Promise.resolve();

  constructor(
    @ISessionEvaluationLedgerService private readonly ledger: ISessionEvaluationLedgerService,
  ) {
    super();
  }

  ready(): Promise<void> {
    return this.synchronize();
  }

  appendLink(input: AppendEvidenceLinkInput): Promise<EvidenceLink> {
    return this.exclusive(async () => {
      await this.synchronizeNow();
      const from = this.nodes.get(input.fromEvidenceId);
      const to = this.nodes.get(input.toEvidenceId);
      if (from === undefined) {
        throw new Error(`Evidence link source does not exist: ${input.fromEvidenceId}`);
      }
      if (to === undefined) {
        throw new Error(`Evidence link target does not exist: ${input.toEvidenceId}`);
      }
      validateRelation(input.relation);
      const contentHash = hashCanonical({
        fromEvidenceId: input.fromEvidenceId,
        toEvidenceId: input.toEvidenceId,
        relation: input.relation,
      });
      const duplicate = [...this.links.values()].find(
        (link) => link.contentHash === contentHash,
      );
      if (duplicate !== undefined) return duplicate;
      if (
        !NON_CAUSAL_RELATIONS.has(input.relation) &&
        this.wouldCreateCausalCycle(input.fromEvidenceId, input.toEvidenceId)
      ) {
        throw new Error(
          `Causal evidence link would create a cycle: ${input.fromEvidenceId} -> ${input.toEvidenceId}`,
        );
      }
      const payload: PersistedLinkPayload = {
        protocol: EVIDENCE_GRAPH_PROTOCOL,
        linkId: randomUUID(),
        fromEvidenceId: input.fromEvidenceId,
        toEvidenceId: input.toEvidenceId,
        relation: input.relation,
        contentHash,
      };
      const record = await this.ledger.append({
        recordType: 'evidence.link.recorded',
        payload,
      });
      const link = linkFromRecord(record, payload);
      this.links.set(link.linkId, link);
      this.loadedSequence = Math.max(this.loadedSequence, record.sequence);
      return link;
    });
  }

  async getNode(evidenceId: EvidenceId): Promise<EvidenceNode | undefined> {
    await this.synchronize();
    return this.nodes.get(evidenceId);
  }

  async linksFor(evidenceId: EvidenceId): Promise<readonly EvidenceLink[]> {
    await this.synchronize();
    return [...this.links.values()]
      .filter(
        (link) =>
          link.fromEvidenceId === evidenceId || link.toEvidenceId === evidenceId,
      )
      .sort(compareLinks);
  }

  async traverse(
    evidenceId: EvidenceId,
    options: EvidenceTraversalOptions = {},
  ): Promise<readonly EvidenceNode[]> {
    await this.synchronize();
    if (!this.nodes.has(evidenceId)) return [];
    const maximumDepth = options.maximumDepth ?? Number.POSITIVE_INFINITY;
    if (!Number.isFinite(maximumDepth) && maximumDepth !== Number.POSITIVE_INFINITY) {
      throw new Error('Evidence traversal maximumDepth must be finite or positive infinity.');
    }
    if (maximumDepth < 0) {
      throw new Error('Evidence traversal maximumDepth must be non-negative.');
    }
    const relations = options.relations === undefined
      ? undefined
      : new Set(options.relations);
    const direction = options.direction ?? 'both';
    const visited = new Set<EvidenceId>([evidenceId]);
    const result: EvidenceNode[] = [];
    const queue: Array<{ readonly evidenceId: EvidenceId; readonly depth: number }> = [
      { evidenceId, depth: 0 },
    ];
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined || current.depth >= maximumDepth) continue;
      for (const link of this.links.values()) {
        if (relations !== undefined && !relations.has(link.relation)) continue;
        const neighbours: EvidenceId[] = [];
        if (
          (direction === 'outgoing' || direction === 'both') &&
          link.fromEvidenceId === current.evidenceId
        ) {
          neighbours.push(link.toEvidenceId);
        }
        if (
          (direction === 'incoming' || direction === 'both') &&
          link.toEvidenceId === current.evidenceId
        ) {
          neighbours.push(link.fromEvidenceId);
        }
        for (const neighbour of neighbours) {
          if (visited.has(neighbour)) continue;
          visited.add(neighbour);
          const node = this.nodes.get(neighbour);
          if (node === undefined) continue;
          result.push(node);
          queue.push({ evidenceId: neighbour, depth: current.depth + 1 });
        }
      }
    }
    return result.sort(compareNodes);
  }

  supportingEvidenceForClaim(
    claimEvidenceId: EvidenceId,
  ): Promise<readonly EvidenceNode[]> {
    return this.traverse(claimEvidenceId, {
      direction: 'incoming',
      relations: ['supported', 'verified', 'derived-from', 'evaluated'],
    });
  }

  counterexamplesForRule(
    ruleEvidenceId: EvidenceId,
  ): Promise<readonly EvidenceNode[]> {
    return this.traverse(ruleEvidenceId, {
      direction: 'incoming',
      relations: ['contradicted'],
    });
  }

  async snapshot(): Promise<EvidenceGraphSnapshot> {
    await this.synchronize();
    const nodes = [...this.nodes.values()].sort(compareNodes);
    const links = [...this.links.values()].sort(compareLinks);
    return {
      protocol: EVIDENCE_GRAPH_PROTOCOL,
      nodes,
      links,
      hash: hashCanonical({ nodes, links }),
    };
  }

  async flush(): Promise<void> {
    await this.synchronization;
    await this.ledger.flush();
  }

  private synchronize(): Promise<void> {
    return this.exclusive(() => this.synchronizeNow());
  }

  private async synchronizeNow(): Promise<void> {
    await this.ledger.ready();
    for await (const record of this.ledger.records()) {
      if (record.sequence <= this.loadedSequence) continue;
      this.consume(record);
      this.loadedSequence = record.sequence;
    }
  }

  private consume(record: EvaluationLedgerRecord): void {
    if (record.evidenceId !== undefined) {
      const node = nodeFromRecord(record);
      const existing = this.nodes.get(record.evidenceId);
      if (existing !== undefined && existing.recordHash !== record.recordHash) {
        throw new Error(`Evidence ID was reused by a different record: ${record.evidenceId}`);
      }
      this.nodes.set(record.evidenceId, node);
    }
    if (record.recordType === 'evidence.link.recorded') {
      const payload = parseLinkPayload(record.payload);
      const link = linkFromRecord(record, payload);
      const existing = this.links.get(link.linkId);
      if (existing !== undefined && existing.contentHash !== link.contentHash) {
        throw new Error(`Evidence link ID was reused with different content: ${link.linkId}`);
      }
      this.links.set(link.linkId, link);
    }
  }

  private wouldCreateCausalCycle(
    fromEvidenceId: EvidenceId,
    toEvidenceId: EvidenceId,
  ): boolean {
    if (fromEvidenceId === toEvidenceId) return true;
    const visited = new Set<EvidenceId>();
    const queue: EvidenceId[] = [toEvidenceId];
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined || visited.has(current)) continue;
      if (current === fromEvidenceId) return true;
      visited.add(current);
      for (const link of this.links.values()) {
        if (NON_CAUSAL_RELATIONS.has(link.relation)) continue;
        if (link.fromEvidenceId === current) queue.push(link.toEvidenceId);
      }
    }
    return false;
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    let resolveResult!: (value: T) => void;
    let rejectResult!: (error: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    this.synchronization = this.synchronization
      .then(async () => resolveResult(await operation()))
      .catch(rejectResult);
    return result;
  }
}

function nodeFromRecord(record: EvaluationLedgerRecord): EvidenceNode {
  const payload = asObject(record.payload);
  return {
    protocol: EVIDENCE_GRAPH_PROTOCOL,
    evidenceId: record.evidenceId as EvidenceId,
    nodeType: nodeTypeForRecord(record.recordType, payload),
    recordType: record.recordType,
    ledgerSequence: record.sequence,
    recordHash: record.recordHash,
    adaptiveRunId: record.adaptiveRunId,
    artifactHash: firstString(payload, ['artifactHash', 'resultHash', 'sha256']),
    subjectRefs: firstStringArray(payload, ['subjectRefs', 'structureRefs', 'affectedStructureIds']),
    payload: record.payload,
  };
}

function nodeTypeForRecord(
  recordType: EvaluationLedgerRecordType,
  payload: Readonly<Record<string, unknown>>,
): EvidenceNodeType {
  switch (recordType) {
    case 'request.recorded': return 'request';
    case 'tool.call.recorded': return 'tool-call';
    case 'tool.result.recorded':
      return payload['process'] === true ? 'process-execution' : 'tool-result';
    case 'baseline.captured': return 'workspace-snapshot';
    case 'evaluation.started':
    case 'evaluation.completed': return 'evaluation';
    case 'evaluation.replicate.completed': return 'evaluation-replicate';
    case 'counterexample.recorded': return 'counterexample';
    case 'world_model.posterior.updated': return 'world-model-prediction';
    case 'search.action.proposed':
    case 'search.action.selected': return 'search-decision';
    case 'task.action.executed':
      return payload['patchHash'] === undefined ? 'other' : 'candidate-patch';
    case 'final.claim.verified': return 'final-claim';
    case 'structural.signal.recorded': return 'structural-signal';
    case 'conflict.opened':
    case 'conflict.resolved': return 'conflict';
    case 'causal.rule.proposed':
    case 'causal.rule.superseded': return 'causal-rule';
    case 'world_model.proposed':
    case 'world_model.evaluated': return 'world-model';
    default: return 'other';
  }
}

function parseLinkPayload(value: unknown): PersistedLinkPayload {
  const object = asObject(value);
  if (object['protocol'] !== EVIDENCE_GRAPH_PROTOCOL) {
    throw new Error(`Unsupported evidence link protocol: ${String(object['protocol'])}`);
  }
  const linkId = requiredString(object, 'linkId');
  const fromEvidenceId = requiredString(object, 'fromEvidenceId') as EvidenceId;
  const toEvidenceId = requiredString(object, 'toEvidenceId') as EvidenceId;
  const relation = requiredString(object, 'relation') as EvidenceRelation;
  validateRelation(relation);
  const contentHash = requiredString(object, 'contentHash');
  const expected = hashCanonical({ fromEvidenceId, toEvidenceId, relation });
  if (contentHash !== expected) throw new Error(`Evidence link hash mismatch: ${linkId}`);
  return {
    protocol: EVIDENCE_GRAPH_PROTOCOL,
    linkId,
    fromEvidenceId,
    toEvidenceId,
    relation,
    contentHash,
  };
}

function linkFromRecord(
  record: EvaluationLedgerRecord,
  payload: PersistedLinkPayload,
): EvidenceLink {
  return {
    protocol: EVIDENCE_GRAPH_PROTOCOL,
    linkId: payload.linkId,
    sequence: record.sequence,
    fromEvidenceId: payload.fromEvidenceId,
    toEvidenceId: payload.toEvidenceId,
    relation: payload.relation,
    contentHash: payload.contentHash,
  };
}

function validateRelation(relation: EvidenceRelation): void {
  if (![
    'caused', 'evaluated', 'predicted', 'contradicted', 'supported',
    'derived-from', 'selected-by', 'verified', 'invalidated', 'references',
  ].includes(relation)) {
    throw new Error(`Unknown evidence relation: ${String(relation)}`);
  }
}

function asObject(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object'
    ? value as Readonly<Record<string, unknown>>
    : {};
}

function requiredString(object: Readonly<Record<string, unknown>>, key: string): string {
  const value = object[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Evidence graph field ${key} must be a non-empty string.`);
  }
  return value;
}

function firstString(
  object: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = object[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function firstStringArray(
  object: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): readonly string[] {
  for (const key of keys) {
    const value = object[key];
    if (Array.isArray(value)) {
      return value.filter((entry): entry is string => typeof entry === 'string');
    }
  }
  return [];
}

function compareNodes(left: EvidenceNode, right: EvidenceNode): number {
  return left.ledgerSequence - right.ledgerSequence ||
    left.evidenceId.localeCompare(right.evidenceId);
}

function compareLinks(left: EvidenceLink, right: EvidenceLink): number {
  return left.sequence - right.sequence || left.linkId.localeCompare(right.linkId);
}

function hashCanonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
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

registerScopedService(
  LifecycleScope.Session,
  ISessionEvidenceGraphService,
  SessionEvidenceGraphService,
  ScopeActivation.OnScopeCreated,
  'evidenceGraph',
);
