import { createHash } from 'node:crypto';

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { basename, dirname, extname, join, normalize, relative } from 'pathe';
import ts from 'typescript';
import {
  ISessionCodeStructureService,
  type CodeStructureEdge,
  type CodeStructureEdgeKind,
  type CodeStructureKind,
  type CodeStructureNode,
  type CodeStructureQuery,
  type CodeStructureQueryResult,
  type CodeStructureSnapshot,
} from './codeStructure';

const INDEX_KEY = 'code-structure.json';
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const SKIPPED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
  '.cache',
]);
const FULL_REBUILD_FILES = new Set([
  'package.json',
  'pnpm-workspace.yaml',
  'tsconfig.json',
  'tsconfig.base.json',
]);

interface ParsedFile {
  readonly nodes: readonly CodeStructureNode[];
  readonly edges: readonly CodeStructureEdge[];
  readonly errors: readonly { readonly path: string; readonly message: string }[];
}

export class SessionCodeStructureService
  extends Disposable
  implements ISessionCodeStructureService
{
  declare readonly _serviceBrand: undefined;

  private readonly scope: string;
  private readonly readyPromise: Promise<void>;
  private current: CodeStructureSnapshot | undefined;
  private mutation: Promise<void> = Promise.resolve();

  constructor(
    @ISessionContext private readonly session: ISessionContext,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @IAtomicDocumentStore private readonly documents: IAtomicDocumentStore,
  ) {
    super();
    this.scope = session.scope('adaptive');
    this._register(this.documents.acquire(this.scope, INDEX_KEY));
    this.readyPromise = this.restore();
  }

  ready(): Promise<void> {
    return this.readyPromise;
  }

  rebuild(signal?: AbortSignal): Promise<CodeStructureSnapshot> {
    return this.enqueue(async () => {
      signal?.throwIfAborted();
      const files = await this.collectFiles(this.session.cwd, signal);
      const nodes: CodeStructureNode[] = [
        { id: workspaceId(this.session.cwd), kind: 'workspace', name: basename(this.session.cwd), path: this.session.cwd },
      ];
      const edges: CodeStructureEdge[] = [];
      const errors: Array<{ path: string; message: string }> = [];
      const packages = await this.discoverPackages(files);
      for (const pkg of packages) {
        nodes.push(pkg);
        edges.push(edge('contains', workspaceId(this.session.cwd), pkg.id));
      }
      for (const path of files) {
        signal?.throwIfAborted();
        const parsed = await this.parsePath(path);
        nodes.push(...parsed.nodes);
        edges.push(...parsed.edges);
        errors.push(...parsed.errors);
        const fileNode = parsed.nodes.find((node) => node.kind === 'file');
        if (fileNode !== undefined) {
          const owner = nearestPackage(packages, path);
          edges.push(edge('contains', owner?.id ?? workspaceId(this.session.cwd), fileNode.id));
        }
      }
      const snapshot = makeSnapshot(this.session.cwd, nodes, edges, errors);
      await this.persist(snapshot);
      return snapshot;
    });
  }

  updatePaths(paths: readonly string[], signal?: AbortSignal): Promise<CodeStructureSnapshot> {
    if (paths.some((path) => FULL_REBUILD_FILES.has(basename(path)))) {
      return this.rebuild(signal);
    }
    return this.enqueue(async () => {
      signal?.throwIfAborted();
      if (this.current === undefined) return this.rebuildOutsideQueue(signal);
      const normalizedPaths = new Set(paths.map((path) => normalizeAbsolute(this.session.cwd, path)));
      const removedIds = new Set(
        this.current.nodes
          .filter((node) => node.path !== undefined && normalizedPaths.has(normalize(node.path)))
          .map((node) => node.id),
      );
      const nodes = this.current.nodes.filter((node) => !removedIds.has(node.id));
      const edges = this.current.edges.filter(
        (candidate) => !removedIds.has(candidate.from) && !removedIds.has(candidate.to),
      );
      const errors = this.current.parseErrors.filter(
        (error) => !normalizedPaths.has(normalize(error.path)),
      );
      const packages = nodes.filter((node): node is CodeStructureNode => node.kind === 'package');
      for (const path of normalizedPaths) {
        signal?.throwIfAborted();
        if (!(await exists(this.fs, path))) continue;
        const parsed = await this.parsePath(path);
        nodes.push(...parsed.nodes);
        edges.push(...parsed.edges);
        errors.push(...parsed.errors);
        const fileNode = parsed.nodes.find((node) => node.kind === 'file');
        if (fileNode !== undefined) {
          const owner = nearestPackage(packages, path);
          edges.push(edge('contains', owner?.id ?? workspaceId(this.session.cwd), fileNode.id));
        }
      }
      const snapshot = makeSnapshot(this.session.cwd, nodes, edges, errors);
      await this.persist(snapshot);
      return snapshot;
    });
  }

  snapshot(): CodeStructureSnapshot | undefined {
    return this.current;
  }

  query(query: CodeStructureQuery): CodeStructureQueryResult {
    const snapshot = this.current;
    if (snapshot === undefined) return { nodes: [], edges: [] };
    const selected = new Set<string>();
    for (const node of snapshot.nodes) {
      if (query.nodeIds !== undefined && !query.nodeIds.includes(node.id)) continue;
      if (query.paths !== undefined && !query.paths.some((path) => normalizeAbsolute(this.session.cwd, path) === normalize(node.path ?? ''))) continue;
      if (query.kinds !== undefined && !query.kinds.includes(node.kind)) continue;
      selected.add(node.id);
    }
    if (query.nodeIds === undefined && query.paths === undefined && query.kinds === undefined) {
      for (const node of snapshot.nodes) selected.add(node.id);
    }
    const depth = Math.max(0, query.depth ?? 0);
    if (depth > 0) expandSelection(selected, snapshot.edges, depth, query.edgeKinds);
    const nodes = snapshot.nodes.filter((node) => selected.has(node.id));
    const edges = snapshot.edges.filter(
      (candidate) =>
        selected.has(candidate.from) &&
        selected.has(candidate.to) &&
        (query.edgeKinds === undefined || query.edgeKinds.includes(candidate.kind)),
    );
    return { nodes, edges };
  }

  affectedBy(nodeIds: readonly string[], maximumDepth = 4): CodeStructureQueryResult {
    const snapshot = this.current;
    if (snapshot === undefined) return { nodes: [], edges: [] };
    const selected = new Set(nodeIds);
    for (let depth = 0; depth < maximumDepth; depth += 1) {
      let changed = false;
      for (const candidate of snapshot.edges) {
        if (selected.has(candidate.to) && !selected.has(candidate.from)) {
          selected.add(candidate.from);
          changed = true;
        }
        if (candidate.kind === 'invalidates' && selected.has(candidate.from) && !selected.has(candidate.to)) {
          selected.add(candidate.to);
          changed = true;
        }
      }
      if (!changed) break;
    }
    return {
      nodes: snapshot.nodes.filter((node) => selected.has(node.id)),
      edges: snapshot.edges.filter((candidate) => selected.has(candidate.from) && selected.has(candidate.to)),
    };
  }

  private async restore(): Promise<void> {
    const stored = await this.documents.get<CodeStructureSnapshot>(this.scope, INDEX_KEY);
    if (stored?.protocol === 'code-structure/1' && stored.workspaceRoot === this.session.cwd) {
      this.current = stored;
    }
  }

  private enqueue(operation: () => Promise<CodeStructureSnapshot>): Promise<CodeStructureSnapshot> {
    let resolveResult!: (snapshot: CodeStructureSnapshot) => void;
    let rejectResult!: (error: unknown) => void;
    const result = new Promise<CodeStructureSnapshot>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    this.mutation = this.mutation
      .then(async () => {
        await this.readyPromise;
        resolveResult(await operation());
      })
      .catch(rejectResult);
    return result;
  }

  private async rebuildOutsideQueue(signal?: AbortSignal): Promise<CodeStructureSnapshot> {
    signal?.throwIfAborted();
    const files = await this.collectFiles(this.session.cwd, signal);
    const nodes: CodeStructureNode[] = [
      { id: workspaceId(this.session.cwd), kind: 'workspace', name: basename(this.session.cwd), path: this.session.cwd },
    ];
    const edges: CodeStructureEdge[] = [];
    const errors: Array<{ path: string; message: string }> = [];
    const packages = await this.discoverPackages(files);
    nodes.push(...packages);
    for (const pkg of packages) edges.push(edge('contains', workspaceId(this.session.cwd), pkg.id));
    for (const path of files) {
      const parsed = await this.parsePath(path);
      nodes.push(...parsed.nodes);
      edges.push(...parsed.edges);
      errors.push(...parsed.errors);
    }
    const snapshot = makeSnapshot(this.session.cwd, nodes, edges, errors);
    await this.persist(snapshot);
    return snapshot;
  }

  private async persist(snapshot: CodeStructureSnapshot): Promise<void> {
    await this.documents.set(this.scope, INDEX_KEY, snapshot);
    this.current = snapshot;
  }

  private async collectFiles(root: string, signal?: AbortSignal): Promise<readonly string[]> {
    const files: string[] = [];
    const visit = async (directory: string): Promise<void> => {
      signal?.throwIfAborted();
      const entries = [...(await this.fs.readdir(directory))].sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (entry.isSymbolicLink) continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory) {
          if (!SKIPPED_DIRECTORIES.has(entry.name)) await visit(path);
          continue;
        }
        if (!entry.isFile) continue;
        if (entry.name === 'package.json' || SOURCE_EXTENSIONS.has(extname(entry.name))) files.push(path);
      }
    };
    await visit(root);
    return files;
  }

  private async discoverPackages(files: readonly string[]): Promise<readonly CodeStructureNode[]> {
    const packages: CodeStructureNode[] = [];
    for (const path of files.filter((candidate) => basename(candidate) === 'package.json')) {
      try {
        const parsed = JSON.parse(await this.fs.readText(path)) as { name?: unknown };
        const root = dirname(path);
        const name = typeof parsed.name === 'string' ? parsed.name : basename(root);
        packages.push({
          id: `package:${normalize(root)}`,
          kind: 'package',
          name,
          path: root,
          metadata: { root },
        });
      } catch {
        // package parse errors are emitted by parsePath
      }
    }
    return packages.sort((a, b) => (a.path ?? '').localeCompare(b.path ?? ''));
  }

  private async parsePath(path: string): Promise<ParsedFile> {
    if (basename(path) === 'package.json') return this.parsePackageFile(path);
    if (!SOURCE_EXTENSIONS.has(extname(path))) return { nodes: [], edges: [], errors: [] };
    try {
      return parseSource(path, await this.fs.readText(path));
    } catch (error) {
      return {
        nodes: [{ id: fileId(path), kind: fileKind(path), name: basename(path), path }],
        edges: [],
        errors: [{ path, message: error instanceof Error ? error.message : String(error) }],
      };
    }
  }

  private async parsePackageFile(path: string): Promise<ParsedFile> {
    const node: CodeStructureNode = { id: fileId(path), kind: 'file', name: basename(path), path };
    try {
      JSON.parse(await this.fs.readText(path));
      return { nodes: [node], edges: [], errors: [] };
    } catch (error) {
      return {
        nodes: [node],
        edges: [],
        errors: [{ path, message: error instanceof Error ? error.message : String(error) }],
      };
    }
  }
}

function parseSource(path: string, text: string): ParsedFile {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKind(path));
  const fileNode: CodeStructureNode = {
    id: fileId(path),
    kind: fileKind(path),
    name: basename(path),
    path,
  };
  const nodes: CodeStructureNode[] = [fileNode];
  const edges: CodeStructureEdge[] = [];
  const errors = source.parseDiagnostics.map((diagnostic) => ({
    path,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
  }));

  const addNode = (kind: CodeStructureKind, name: string, node: ts.Node): CodeStructureNode => {
    const structure: CodeStructureNode = {
      id: `${kind}:${normalize(path)}:${name}:${node.getStart(source)}`,
      kind,
      name,
      path,
      start: node.getStart(source),
      end: node.getEnd(),
    };
    nodes.push(structure);
    edges.push(edge('contains', fileNode.id, structure.id));
    return structure;
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const target = moduleId(node.moduleSpecifier.text);
      nodes.push({ id: target, kind: 'module', name: node.moduleSpecifier.text });
      edges.push(edge('imports', fileNode.id, target));
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
      const target = moduleId(node.moduleSpecifier.text);
      nodes.push({ id: target, kind: 'module', name: node.moduleSpecifier.text });
      edges.push(edge('exports', fileNode.id, target));
    } else if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
      addNode('function', node.name.text, node);
    } else if (ts.isClassDeclaration(node) && node.name !== undefined) {
      const structure = addNode('class', node.name.text, node);
      addHeritageEdges(node, structure.id, nodes, edges, source);
    } else if (ts.isInterfaceDeclaration(node)) {
      const structure = addNode('interface', node.name.text, node);
      addHeritageEdges(node, structure.id, nodes, edges, source);
    } else if (ts.isTypeAliasDeclaration(node)) {
      addNode('type', node.name.text, node);
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      addNode('symbol', node.name.text, node);
    } else if (ts.isCallExpression(node)) {
      recognizeCall(node, source, fileNode, nodes, edges);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { nodes: dedupeNodes(nodes), edges: dedupeEdges(edges), errors };
}

function recognizeCall(
  call: ts.CallExpression,
  source: ts.SourceFile,
  fileNode: CodeStructureNode,
  nodes: CodeStructureNode[],
  edges: CodeStructureEdge[],
): void {
  const name = callName(call.expression);
  const recognized = recognizedCallKind(name);
  if (recognized !== undefined) {
    const label = stringArgument(call.arguments[0]) ?? call.arguments[0]?.getText(source) ?? name;
    const id = `${recognized}:${normalize(source.fileName)}:${label}:${call.getStart(source)}`;
    nodes.push({ id, kind: recognized, name: label, path: source.fileName, start: call.getStart(source), end: call.getEnd() });
    edges.push(edge('registers', fileNode.id, id));
  }
  if (name.endsWith('.publish') || name === 'publish') {
    const eventName = eventTypeFromArgument(call.arguments[0], source);
    if (eventName !== undefined) {
      const eventId = `event-type:${eventName}`;
      const publisherId = `event-publisher:${normalize(source.fileName)}:${call.getStart(source)}`;
      nodes.push({ id: eventId, kind: 'event-type', name: eventName });
      nodes.push({ id: publisherId, kind: 'event-publisher', name: eventName, path: source.fileName, start: call.getStart(source), end: call.getEnd() });
      edges.push(edge('contains', fileNode.id, publisherId));
      edges.push(edge('publishes', publisherId, eventId));
    }
  }
  if (name.endsWith('.subscribe') || name === 'subscribe') {
    const eventName = stringArgument(call.arguments[0]);
    if (eventName !== undefined) {
      const eventId = `event-type:${eventName}`;
      const subscriberId = `event-subscriber:${normalize(source.fileName)}:${call.getStart(source)}`;
      nodes.push({ id: eventId, kind: 'event-type', name: eventName });
      nodes.push({ id: subscriberId, kind: 'event-subscriber', name: eventName, path: source.fileName, start: call.getStart(source), end: call.getEnd() });
      edges.push(edge('contains', fileNode.id, subscriberId));
      edges.push(edge('subscribes', subscriberId, eventId));
    }
  }
  if (ts.isIdentifier(call.expression) || ts.isPropertyAccessExpression(call.expression)) {
    const target = `symbol-ref:${name}`;
    nodes.push({ id: target, kind: 'symbol', name });
    edges.push(edge('calls', fileNode.id, target));
  }
}

function recognizedCallKind(name: string): CodeStructureKind | undefined {
  const terminal = name.split('.').at(-1);
  switch (terminal) {
    case 'registerScopedService':
      return 'service-registration';
    case 'registerConfigSection':
      return 'configuration-section';
    case 'defineModel':
      return 'wire-model';
    case 'defineOp':
      return 'wire-operation';
    case 'registerAgentToolService':
      return 'tool-registration';
    default:
      return undefined;
  }
}

function addHeritageEdges(
  declaration: ts.ClassDeclaration | ts.InterfaceDeclaration,
  from: string,
  nodes: CodeStructureNode[],
  edges: CodeStructureEdge[],
  source: ts.SourceFile,
): void {
  for (const clause of declaration.heritageClauses ?? []) {
    for (const type of clause.types) {
      const name = type.expression.getText(source);
      const target = `symbol-ref:${name}`;
      nodes.push({ id: target, kind: 'symbol', name });
      edges.push(edge(clause.token === ts.SyntaxKind.ImplementsKeyword ? 'implements' : 'extends', from, target));
    }
  }
}

function eventTypeFromArgument(argument: ts.Expression | undefined, source: ts.SourceFile): string | undefined {
  if (argument === undefined || !ts.isObjectLiteralExpression(argument)) return undefined;
  const property = argument.properties.find(
    (candidate): candidate is ts.PropertyAssignment =>
      ts.isPropertyAssignment(candidate) && candidate.name.getText(source).replaceAll(/["']/g, '') === 'type',
  );
  return property === undefined ? undefined : stringArgument(property.initializer);
}

function stringArgument(node: ts.Expression | undefined): string | undefined {
  return node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : undefined;
}

function callName(expression: ts.LeftHandSideExpression): string {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return `${callName(expression.expression)}.${expression.name.text}`;
  return expression.getText();
}

function scriptKind(path: string): ts.ScriptKind {
  switch (extname(path)) {
    case '.tsx': return ts.ScriptKind.TSX;
    case '.jsx': return ts.ScriptKind.JSX;
    case '.js':
    case '.mjs':
    case '.cjs': return ts.ScriptKind.JS;
    default: return ts.ScriptKind.TS;
  }
}

function fileKind(path: string): CodeStructureKind {
  const name = basename(path);
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(name)) return 'test';
  if (/manifest|generated/i.test(name)) return 'generated-artifact';
  return 'file';
}

function nearestPackage(packages: readonly CodeStructureNode[], path: string): CodeStructureNode | undefined {
  return packages
    .filter((candidate) => candidate.path !== undefined && normalize(path).startsWith(`${normalize(candidate.path)}/`))
    .sort((left, right) => (right.path?.length ?? 0) - (left.path?.length ?? 0))[0];
}

function expandSelection(
  selected: Set<string>,
  edges: readonly CodeStructureEdge[],
  depth: number,
  kinds?: readonly CodeStructureEdgeKind[],
): void {
  for (let index = 0; index < depth; index += 1) {
    const additions = new Set<string>();
    for (const candidate of edges) {
      if (kinds !== undefined && !kinds.includes(candidate.kind)) continue;
      if (selected.has(candidate.from)) additions.add(candidate.to);
      if (selected.has(candidate.to)) additions.add(candidate.from);
    }
    let changed = false;
    for (const id of additions) {
      if (!selected.has(id)) {
        selected.add(id);
        changed = true;
      }
    }
    if (!changed) break;
  }
}

function makeSnapshot(
  workspaceRoot: string,
  nodes: readonly CodeStructureNode[],
  edges: readonly CodeStructureEdge[],
  errors: readonly { readonly path: string; readonly message: string }[],
): CodeStructureSnapshot {
  const normalizedNodes = dedupeNodes(nodes).sort((a, b) => a.id.localeCompare(b.id));
  const normalizedEdges = dedupeEdges(edges).sort((a, b) => a.id.localeCompare(b.id));
  const material = JSON.stringify({ nodes: normalizedNodes, edges: normalizedEdges, errors });
  return {
    protocol: 'code-structure/1',
    workspaceRoot,
    hash: createHash('sha256').update(material).digest('hex'),
    generatedAt: Date.now(),
    nodes: normalizedNodes,
    edges: normalizedEdges,
    parseErrors: [...errors].sort((a, b) => a.path.localeCompare(b.path)),
  };
}

function dedupeNodes(nodes: readonly CodeStructureNode[]): CodeStructureNode[] {
  return [...new Map(nodes.map((node) => [node.id, node])).values()];
}

function dedupeEdges(edges: readonly CodeStructureEdge[]): CodeStructureEdge[] {
  return [...new Map(edges.map((candidate) => [candidate.id, candidate])).values()];
}

function edge(kind: CodeStructureEdgeKind, from: string, to: string): CodeStructureEdge {
  return { id: `${kind}:${from}->${to}`, kind, from, to };
}

function fileId(path: string): string {
  return `file:${normalize(path)}`;
}

function moduleId(specifier: string): string {
  return `module:${specifier}`;
}

function workspaceId(root: string): string {
  return `workspace:${normalize(root)}`;
}

function normalizeAbsolute(root: string, path: string): string {
  return normalize(path.startsWith('/') ? path : join(root, path));
}

async function exists(fs: IHostFileSystem, path: string): Promise<boolean> {
  try {
    await fs.lstat(path);
    return true;
  } catch {
    return false;
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionCodeStructureService,
  SessionCodeStructureService,
  ScopeActivation.OnScopeCreated,
  'codeStructure',
);
