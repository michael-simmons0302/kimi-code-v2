import { createHash } from 'node:crypto';

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import type { CandidateId, WorkspaceSnapshotId } from '#/agent/adaptiveRuntime/adaptiveProtocol';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IBlobStore } from '#/persistence/interface/blobStore';
import { ISessionProcessRunner } from '#/session/process/processRunner';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { basename, dirname, join, normalize, relative } from 'pathe';
import {
  ISessionCandidateWorkspaceService,
  type BaselineFileEntry,
  type BaselineSnapshot,
  type CandidateWorkspace,
  type CandidateWorkspaceReconciliation,
} from './candidateWorkspace';

const BASELINE_KEY = 'baseline.json';
const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.next', '.turbo']);

export class SessionCandidateWorkspaceService
  extends Disposable
  implements ISessionCandidateWorkspaceService
{
  declare readonly _serviceBrand: undefined;

  private readonly scope: string;
  private readonly artifactScope: string;
  private readonly workspacesRoot: string;
  private readonly readyPromise: Promise<void>;
  private currentBaseline: BaselineSnapshot | undefined;
  private mutation: Promise<void> = Promise.resolve();

  constructor(
    @ISessionContext private readonly session: ISessionContext,
    @IBootstrapService bootstrap: IBootstrapService,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @ISessionProcessRunner private readonly processes: ISessionProcessRunner,
    @IBlobStore private readonly blobs: IBlobStore,
    @IAtomicDocumentStore private readonly documents: IAtomicDocumentStore,
  ) {
    super();
    this.scope = session.scope('adaptive');
    this.artifactScope = session.scope('adaptive/artifacts');
    this.workspacesRoot = join(bootstrap.homeDir, session.scope('adaptive/workspaces'));
    this._register(this.documents.acquire(this.scope, BASELINE_KEY));
    this.readyPromise = this.restore();
  }

  ready(): Promise<void> {
    return this.readyPromise;
  }

  captureBaseline(signal?: AbortSignal): Promise<BaselineSnapshot> {
    return this.mutate(async () => {
      signal?.throwIfAborted();
      const gitRootResult = await this.run(['git', '-C', this.session.cwd, 'rev-parse', '--show-toplevel'], this.session.cwd, signal, false);
      const gitRoot = gitRootResult.exitCode === 0 ? gitRootResult.stdout.trim() : undefined;
      const material = gitRoot === undefined
        ? await this.captureDirectory(this.session.cwd, signal)
        : await this.captureGit(gitRoot, signal);
      const hash = hashValue(material);
      const snapshot: BaselineSnapshot = {
        protocol: 'candidate-baseline/1',
        snapshotId: hash as WorkspaceSnapshotId,
        ...material,
        createdAt: Date.now(),
        hash,
      };
      await this.documents.set(this.scope, BASELINE_KEY, snapshot);
      this.currentBaseline = snapshot;
      return snapshot;
    });
  }

  baseline(): BaselineSnapshot | undefined {
    return this.currentBaseline;
  }

  materialize(
    candidateId: CandidateId,
    patch: string,
    signal?: AbortSignal,
  ): Promise<CandidateWorkspace> {
    return this.mutate(async () => {
      signal?.throwIfAborted();
      const baseline = this.requireBaseline();
      validatePatchPaths(patch);
      const safeCandidate = safeSegment(candidateId);
      const target = join(this.workspacesRoot, safeCandidate);
      await this.removeWorkspace(target, baseline, signal);
      await this.fs.mkdir(this.workspacesRoot, { recursive: true, mode: 0o700 });
      if (baseline.kind === 'git') {
        await this.run(
          ['git', '-C', baseline.root, 'worktree', 'add', '--detach', target, baseline.gitCommit!],
          baseline.root,
          signal,
          true,
        );
        if (baseline.dirtyPatchHash !== undefined) {
          const dirty = await this.requiredBlob(`patches/${baseline.dirtyPatchHash}`);
          await this.applyPatch(target, Buffer.from(dirty).toString('utf8'), `${safeCandidate}.baseline.patch`, signal);
        }
      } else {
        await this.fs.mkdir(target, { recursive: true, mode: 0o700 });
      }
      await this.restoreFiles(target, baseline.files);
      const patchHash = hashText(patch);
      if (patch.length > 0) {
        await this.putBlobOnce(`patches/${patchHash}`, Buffer.from(patch));
        await this.applyPatch(target, patch, `${safeCandidate}.candidate.patch`, signal);
      }
      const workspaceHash = await this.hashDirectory(target, signal);
      const workspace: CandidateWorkspace = {
        candidateId,
        baselineSnapshotId: baseline.snapshotId,
        path: target,
        workspaceHash,
        patchHash,
        createdAt: Date.now(),
      };
      await this.documents.set(this.scope, `workspace-${safeCandidate}.json`, workspace);
      return workspace;
    });
  }

  reconcileLive(patch: string, signal?: AbortSignal): Promise<CandidateWorkspaceReconciliation> {
    return this.mutate(async () => {
      const baseline = this.requireBaseline();
      const live = baseline.kind === 'git'
        ? await this.describeGit(baseline.root, signal)
        : await this.describeDirectory(baseline.root, signal);
      const liveHash = hashValue(live);
      const unchanged = liveHash === baseline.hash;
      const conflictedPaths = unchanged ? [] : await this.changedPaths(baseline, signal);
      if (patch.length > 0) validatePatchPaths(patch);
      return {
        unchanged,
        baselineHash: baseline.hash,
        liveHash,
        requiresRevalidation: !unchanged,
        conflictedPaths,
      };
    });
  }

  applyToLive(patch: string, signal?: AbortSignal): Promise<void> {
    return this.mutate(async () => {
      const reconciliation = await this.reconcileOutsideQueue(patch, signal);
      if (!reconciliation.unchanged) {
        throw new Error(
          `Live workspace changed after baseline capture: ${reconciliation.conflictedPaths.join(', ')}`,
        );
      }
      const baseline = this.requireBaseline();
      validatePatchPaths(patch);
      await this.applyPatch(baseline.root, patch, 'selected-live.patch', signal);
    });
  }

  cleanup(candidateId: CandidateId): Promise<void> {
    return this.mutate(async () => {
      const baseline = this.requireBaseline();
      const target = join(this.workspacesRoot, safeSegment(candidateId));
      await this.removeWorkspace(target, baseline);
      await this.documents.delete(this.scope, `workspace-${safeSegment(candidateId)}.json`);
    });
  }

  async flush(): Promise<void> {
    await this.readyPromise;
    await this.mutation;
  }

  override dispose(): void {
    void this.flush();
    super.dispose();
  }

  private async captureGit(
    root: string,
    signal?: AbortSignal,
  ): Promise<Omit<BaselineSnapshot, 'protocol' | 'snapshotId' | 'createdAt' | 'hash'>> {
    const description = await this.describeGit(root, signal);
    if (description.dirtyPatchHash !== undefined && !(await this.blobs.has(this.artifactScope, `patches/${description.dirtyPatchHash}`))) {
      const patch = await this.run(['git', '-C', root, 'diff', '--binary', 'HEAD'], root, signal, true);
      await this.putBlobOnce(`patches/${description.dirtyPatchHash}`, Buffer.from(patch.stdout));
    }
    return description;
  }

  private async describeGit(
    root: string,
    signal?: AbortSignal,
  ): Promise<Omit<BaselineSnapshot, 'protocol' | 'snapshotId' | 'createdAt' | 'hash'>> {
    const commit = (await this.run(['git', '-C', root, 'rev-parse', 'HEAD'], root, signal, true)).stdout.trim();
    const patch = (await this.run(['git', '-C', root, 'diff', '--binary', 'HEAD'], root, signal, true)).stdout;
    const dirtyPatchHash = patch.length === 0 ? undefined : hashText(patch);
    const untracked = (await this.run(
      ['git', '-C', root, 'ls-files', '--others', '--exclude-standard', '-z'],
      root,
      signal,
      true,
    )).stdout.split('\0').filter(Boolean).sort();
    const files: BaselineFileEntry[] = [];
    for (const relativePath of untracked) {
      const entry = await this.captureFile(root, relativePath);
      if (entry !== undefined) files.push(entry);
    }
    return {
      root,
      kind: 'git',
      gitCommit: commit,
      dirtyPatchHash,
      files,
    };
  }

  private async captureDirectory(
    root: string,
    signal?: AbortSignal,
  ): Promise<Omit<BaselineSnapshot, 'protocol' | 'snapshotId' | 'createdAt' | 'hash'>> {
    return this.describeDirectory(root, signal);
  }

  private async describeDirectory(
    root: string,
    signal?: AbortSignal,
  ): Promise<Omit<BaselineSnapshot, 'protocol' | 'snapshotId' | 'createdAt' | 'hash'>> {
    const files: BaselineFileEntry[] = [];
    const visit = async (directory: string): Promise<void> => {
      signal?.throwIfAborted();
      const entries = [...(await this.fs.readdir(directory))].sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory) {
          if (!SKIP_DIRECTORIES.has(entry.name)) await visit(path);
          continue;
        }
        const relativePath = relative(root, path);
        const captured = await this.captureFile(root, relativePath);
        if (captured !== undefined) files.push(captured);
      }
    };
    await visit(root);
    return { root, kind: 'directory', files };
  }

  private async captureFile(root: string, relativePath: string): Promise<BaselineFileEntry | undefined> {
    const path = join(root, relativePath);
    const stat = await this.fs.lstat(path);
    if (stat.isSymbolicLink()) {
      return {
        relativePath,
        sha256: hashText(await this.fs.readlink(path)),
        byteLength: 0,
        executable: false,
        symbolicLinkTarget: await this.fs.readlink(path),
      };
    }
    if (!stat.isFile()) return undefined;
    const data = await this.fs.readFile(path);
    const sha256 = hashBytes(data);
    await this.putBlobOnce(`files/${sha256}`, data);
    return {
      relativePath,
      sha256,
      byteLength: data.byteLength,
      executable: (stat.mode & 0o111) !== 0,
    };
  }

  private async restoreFiles(root: string, files: readonly BaselineFileEntry[]): Promise<void> {
    for (const entry of files) {
      const path = join(root, entry.relativePath);
      await this.fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await this.fs.rm(path, { force: true, recursive: true }).catch(() => undefined);
      if (entry.symbolicLinkTarget !== undefined) {
        await this.fs.symlink(entry.symbolicLinkTarget, path);
        continue;
      }
      const data = await this.requiredBlob(`files/${entry.sha256}`);
      await this.fs.writeFile(path, data, { mode: entry.executable ? 0o700 : 0o600 });
      if (entry.executable) await this.fs.chmod(path, 0o700);
    }
  }

  private async applyPatch(
    root: string,
    patch: string,
    patchName: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (patch.length === 0) return;
    validatePatchPaths(patch);
    const patchPath = join(this.workspacesRoot, patchName);
    await this.fs.mkdir(dirname(patchPath), { recursive: true, mode: 0o700 });
    await this.fs.writeText(patchPath, patch, { mode: 0o600 });
    try {
      await this.run(
        ['git', '-C', root, 'apply', '--binary', '--whitespace=nowarn', patchPath],
        root,
        signal,
        true,
      );
    } finally {
      await this.fs.rm(patchPath, { force: true });
    }
  }

  private async removeWorkspace(
    target: string,
    baseline: BaselineSnapshot,
    signal?: AbortSignal,
  ): Promise<void> {
    if (baseline.kind === 'git' && await exists(this.fs, target)) {
      await this.run(
        ['git', '-C', baseline.root, 'worktree', 'remove', '--force', target],
        baseline.root,
        signal,
        false,
      );
    }
    await this.fs.rm(target, { recursive: true, force: true });
  }

  private async changedPaths(
    baseline: BaselineSnapshot,
    signal?: AbortSignal,
  ): Promise<readonly string[]> {
    if (baseline.kind !== 'git') return ['<directory-tree>'];
    const tracked = (await this.run(
      ['git', '-C', baseline.root, 'diff', '--name-only', 'HEAD'],
      baseline.root,
      signal,
      false,
    )).stdout.split('\n').filter(Boolean);
    const untracked = (await this.run(
      ['git', '-C', baseline.root, 'ls-files', '--others', '--exclude-standard'],
      baseline.root,
      signal,
      false,
    )).stdout.split('\n').filter(Boolean);
    return [...new Set([...tracked, ...untracked])].sort();
  }

  private async reconcileOutsideQueue(
    patch: string,
    signal?: AbortSignal,
  ): Promise<CandidateWorkspaceReconciliation> {
    const baseline = this.requireBaseline();
    const live = baseline.kind === 'git'
      ? await this.describeGit(baseline.root, signal)
      : await this.describeDirectory(baseline.root, signal);
    const liveHash = hashValue(live);
    const unchanged = liveHash === baseline.hash;
    return {
      unchanged,
      baselineHash: baseline.hash,
      liveHash,
      requiresRevalidation: !unchanged,
      conflictedPaths: unchanged ? [] : await this.changedPaths(baseline, signal),
    };
  }

  private async hashDirectory(root: string, signal?: AbortSignal): Promise<string> {
    const description = await this.describeDirectory(root, signal);
    return hashValue(description.files.map((entry) => ({
      relativePath: entry.relativePath,
      sha256: entry.sha256,
      executable: entry.executable,
      symbolicLinkTarget: entry.symbolicLinkTarget,
    })));
  }

  private requireBaseline(): BaselineSnapshot {
    if (this.currentBaseline === undefined) throw new Error('Adaptive baseline has not been captured.');
    return this.currentBaseline;
  }

  private async putBlobOnce(key: string, data: Uint8Array): Promise<void> {
    if (await this.blobs.has(this.artifactScope, key)) {
      const existing = await this.blobs.get(this.artifactScope, key);
      if (existing === undefined || hashBytes(existing) !== hashBytes(data)) {
        throw new Error(`Content-addressed blob mismatch: ${key}`);
      }
      return;
    }
    await this.blobs.put(this.artifactScope, key, data);
  }

  private async requiredBlob(key: string): Promise<Uint8Array> {
    const data = await this.blobs.get(this.artifactScope, key);
    if (data === undefined) throw new Error(`Missing adaptive artifact: ${key}`);
    return data;
  }

  private async run(
    args: readonly string[],
    cwd: string,
    signal: AbortSignal | undefined,
    requireSuccess: boolean,
  ): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
    signal?.throwIfAborted();
    const process = await this.processes.exec(args, { cwd });
    const abort = (): void => { void process.kill().catch(() => undefined); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const stdoutPromise = collect(process.stdout);
      const stderrPromise = collect(process.stderr);
      const exitCode = await process.wait();
      const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
      if (requireSuccess && exitCode !== 0) {
        throw new Error(`Command failed (${exitCode}): ${args.join(' ')}\n${stderr}`);
      }
      return { exitCode, stdout, stderr };
    } finally {
      signal?.removeEventListener('abort', abort);
      await process.dispose();
    }
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    let resolveResult!: (value: T) => void;
    let rejectResult!: (error: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
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

  private async restore(): Promise<void> {
    const baseline = await this.documents.get<BaselineSnapshot>(this.scope, BASELINE_KEY);
    if (baseline?.protocol === 'candidate-baseline/1') this.currentBaseline = baseline;
  }
}

async function collect(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function validatePatchPaths(patch: string): void {
  for (const line of patch.split('\n')) {
    if (!line.startsWith('+++ ') && !line.startsWith('--- ')) continue;
    const raw = line.slice(4).split('\t')[0]!.trim();
    if (raw === '/dev/null') continue;
    const stripped = raw.startsWith('a/') || raw.startsWith('b/') ? raw.slice(2) : raw;
    const normalized = normalize(stripped);
    if (normalized.startsWith('/') || normalized === '..' || normalized.startsWith('../')) {
      throw new Error(`Patch path escapes the workspace: ${raw}`);
    }
  }
}

function safeSegment(value: string): string {
  const safe = String(value).replaceAll(/[^A-Za-z0-9._-]/g, '_');
  if (safe.length === 0 || safe === '.' || safe === '..') throw new Error('Invalid candidate identifier.');
  return safe.slice(0, 128);
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function hashBytes(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function hashValue(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, current: unknown) => {
    if (current !== null && typeof current === 'object' && !Array.isArray(current)) {
      const source = current as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(source)
          .sort()
          .filter((key) => source[key] !== undefined)
          .map((key) => [key, source[key]]),
      );
    }
    return current;
  });
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
  ISessionCandidateWorkspaceService,
  SessionCandidateWorkspaceService,
  ScopeActivation.OnScopeCreated,
  'candidateWorkspace',
);
