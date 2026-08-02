import { createDecorator } from '#/_base/di/instantiation';

export type CodeStructureKind =
  | 'workspace'
  | 'package'
  | 'module'
  | 'file'
  | 'symbol'
  | 'function'
  | 'class'
  | 'interface'
  | 'type'
  | 'test'
  | 'configuration-section'
  | 'wire-model'
  | 'wire-operation'
  | 'event-type'
  | 'event-publisher'
  | 'event-subscriber'
  | 'service-registration'
  | 'tool-registration'
  | 'generated-artifact'
  | 'persistence-schema';

export type CodeStructureEdgeKind =
  | 'contains'
  | 'imports'
  | 'exports'
  | 'calls'
  | 'implements'
  | 'extends'
  | 'constructs'
  | 'reads'
  | 'writes'
  | 'serializes'
  | 'restores'
  | 'publishes'
  | 'subscribes'
  | 'registers'
  | 'generates'
  | 'tests'
  | 'depends-on'
  | 'invalidates';

export interface CodeStructureNode {
  readonly id: string;
  readonly kind: CodeStructureKind;
  readonly name: string;
  readonly path?: string;
  readonly start?: number;
  readonly end?: number;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

export interface CodeStructureEdge {
  readonly id: string;
  readonly kind: CodeStructureEdgeKind;
  readonly from: string;
  readonly to: string;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

export interface CodeStructureSnapshot {
  readonly protocol: 'code-structure/1';
  readonly workspaceRoot: string;
  readonly hash: string;
  readonly generatedAt: number;
  readonly nodes: readonly CodeStructureNode[];
  readonly edges: readonly CodeStructureEdge[];
  readonly parseErrors: readonly {
    readonly path: string;
    readonly message: string;
  }[];
}

export interface CodeStructureQuery {
  readonly nodeIds?: readonly string[];
  readonly paths?: readonly string[];
  readonly kinds?: readonly CodeStructureKind[];
  readonly edgeKinds?: readonly CodeStructureEdgeKind[];
  readonly depth?: number;
}

export interface CodeStructureQueryResult {
  readonly nodes: readonly CodeStructureNode[];
  readonly edges: readonly CodeStructureEdge[];
}

export interface ISessionCodeStructureService {
  readonly _serviceBrand: undefined;
  ready(): Promise<void>;
  rebuild(signal?: AbortSignal): Promise<CodeStructureSnapshot>;
  updatePaths(paths: readonly string[], signal?: AbortSignal): Promise<CodeStructureSnapshot>;
  snapshot(): CodeStructureSnapshot | undefined;
  query(query: CodeStructureQuery): CodeStructureQueryResult;
  affectedBy(nodeIds: readonly string[], maximumDepth?: number): CodeStructureQueryResult;
}

export const ISessionCodeStructureService = createDecorator<ISessionCodeStructureService>(
  'sessionCodeStructureService',
);
