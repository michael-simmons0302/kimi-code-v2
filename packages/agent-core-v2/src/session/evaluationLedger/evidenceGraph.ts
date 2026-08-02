import { createDecorator } from '#/_base/di/instantiation';
import type { AdaptiveRunId, EvidenceId } from '#/agent/adaptiveRuntime/adaptiveProtocol';
import type { EvaluationLedgerRecordType } from './evaluationLedger';

export const EVIDENCE_GRAPH_PROTOCOL = 'adaptive-evidence-graph/1' as const;

export type EvidenceNodeType =
  | 'request'
  | 'tool-call'
  | 'tool-result'
  | 'process-execution'
  | 'workspace-snapshot'
  | 'file-content'
  | 'evaluation'
  | 'evaluation-replicate'
  | 'counterexample'
  | 'world-model-prediction'
  | 'search-decision'
  | 'candidate-patch'
  | 'final-claim'
  | 'structural-signal'
  | 'conflict'
  | 'causal-rule'
  | 'world-model'
  | 'other';

export type EvidenceRelation =
  | 'caused'
  | 'evaluated'
  | 'predicted'
  | 'contradicted'
  | 'supported'
  | 'derived-from'
  | 'selected-by'
  | 'verified'
  | 'invalidated'
  | 'references';

export interface EvidenceNode {
  readonly protocol: typeof EVIDENCE_GRAPH_PROTOCOL;
  readonly evidenceId: EvidenceId;
  readonly nodeType: EvidenceNodeType;
  readonly recordType: EvaluationLedgerRecordType;
  readonly ledgerSequence: number;
  readonly recordHash: string;
  readonly adaptiveRunId?: AdaptiveRunId;
  readonly artifactHash?: string;
  readonly subjectRefs: readonly string[];
  readonly payload: unknown;
}

export interface EvidenceLink {
  readonly protocol: typeof EVIDENCE_GRAPH_PROTOCOL;
  readonly linkId: string;
  readonly sequence: number;
  readonly fromEvidenceId: EvidenceId;
  readonly toEvidenceId: EvidenceId;
  readonly relation: EvidenceRelation;
  readonly contentHash: string;
}

export interface AppendEvidenceLinkInput {
  readonly fromEvidenceId: EvidenceId;
  readonly toEvidenceId: EvidenceId;
  readonly relation: EvidenceRelation;
}

export interface EvidenceTraversalOptions {
  readonly relations?: readonly EvidenceRelation[];
  readonly maximumDepth?: number;
  readonly direction?: 'incoming' | 'outgoing' | 'both';
}

export interface EvidenceGraphSnapshot {
  readonly protocol: typeof EVIDENCE_GRAPH_PROTOCOL;
  readonly nodes: readonly EvidenceNode[];
  readonly links: readonly EvidenceLink[];
  readonly hash: string;
}

export interface ISessionEvidenceGraphService {
  readonly _serviceBrand: undefined;

  ready(): Promise<void>;
  appendLink(input: AppendEvidenceLinkInput): Promise<EvidenceLink>;
  getNode(evidenceId: EvidenceId): Promise<EvidenceNode | undefined>;
  linksFor(evidenceId: EvidenceId): Promise<readonly EvidenceLink[]>;
  traverse(
    evidenceId: EvidenceId,
    options?: EvidenceTraversalOptions,
  ): Promise<readonly EvidenceNode[]>;
  supportingEvidenceForClaim(
    claimEvidenceId: EvidenceId,
  ): Promise<readonly EvidenceNode[]>;
  counterexamplesForRule(
    ruleEvidenceId: EvidenceId,
  ): Promise<readonly EvidenceNode[]>;
  snapshot(): Promise<EvidenceGraphSnapshot>;
  flush(): Promise<void>;
}

export const ISessionEvidenceGraphService = createDecorator<ISessionEvidenceGraphService>(
  'sessionEvidenceGraphService',
);
