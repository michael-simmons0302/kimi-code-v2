import { mkdtemp, mkdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { describe, expect, it } from 'vitest';

import type { IDisposable } from '#/_base/di/lifecycle';
import type { Event } from '#/_base/event';
import type { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import type { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import type {
  AppendEvaluationLedgerInput,
  EvaluationLedgerHead,
  EvaluationLedgerRecord,
  ISessionEvaluationLedgerService,
} from '#/session/evaluationLedger/evaluationLedger';
import type { ISessionContext } from '#/session/sessionContext/sessionContext';
import { SessionLifecycleHooksService } from '#/session/sessionLifecycleHooks/sessionLifecycleHooks';
import type {
  ISessionMetadata,
  SessionMeta,
} from '#/session/sessionMetadata/sessionMetadata';
import type { IAgentAdaptiveLifecycleService } from '#/session/adaptiveLifecycle/adaptiveLifecycle';
import { SessionAdaptiveLifecycleService } from '#/session/adaptiveLifecycle/adaptiveLifecycleService';

class Documents implements IAtomicDocumentStore {
  declare readonly _serviceBrand: undefined;
  readonly values = new Map<string, unknown>();
  readonly deleted: string[] = [];
  async get<T>(scope: string, key: string): Promise<T | undefined> {
    return this.values.get(`${scope}/${key}`) as T | undefined;
  }
  async set<T>(scope: string, key: string, value: T): Promise<void> {
    this.values.set(`${scope}/${key}`, value);
  }
  async delete(scope: string, key: string): Promise<void> {
    this.values.delete(`${scope}/${key}`);
    this.deleted.push(`${scope}/${key}`);
  }
  async list(): Promise<readonly string[]> { return []; }
  watch(): Event<void> { return () => ({ dispose() {} }); }
  acquire(): IDisposable { return { dispose() {} }; }
}

class Ledger implements ISessionEvaluationLedgerService {
  declare readonly _serviceBrand: undefined;
  readonly appended: AppendEvaluationLedgerInput[] = [];
  async ready(): Promise<void> {}
  async append<TPayload>(
    input: AppendEvaluationLedgerInput<TPayload>,
  ): Promise<EvaluationLedgerRecord<TPayload>> {
    this.appended.push(input as AppendEvaluationLedgerInput);
    const sequence = this.appended.length;
    return {
      protocol: 'adaptive-ledger/1',
      sequence,
      previousRecordHash: sequence === 1 ? null : `hash-${String(sequence - 1)}`,
      recordHash: `hash-${String(sequence)}`,
      recordType: input.recordType,
      adaptiveRunId: input.adaptiveRunId,
      evidenceId: input.evidenceId,
      payload: input.payload,
    };
  }
  async *records(): AsyncIterable<EvaluationLedgerRecord> {}
  head(): EvaluationLedgerHead {
    return {
      protocol: 'adaptive-ledger/1',
      sequence: this.appended.length,
      recordHash: this.appended.length === 0 ? null : `hash-${String(this.appended.length)}`,
    };
  }
  async verify() { return { valid: true, records: this.appended.length, head: this.head() }; }
  async flush(): Promise<void> {}
}

function metadata(value: SessionMeta): ISessionMetadata {
  return {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    read: async () => value,
    update: async () => value,
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe('SessionAdaptiveLifecycleService', () => {
  it('removes transient fork state, clears stale documents, records lineage, and reconciles agents', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'adaptive-fork-'));
    const workspace = join(sessionDir, 'adaptive', 'workspaces', 'candidate');
    const hidden = join(sessionDir, 'adaptive', 'hidden-promotion');
    await mkdir(workspace, { recursive: true });
    await mkdir(hidden, { recursive: true });
    await writeFile(join(workspace, 'file.ts'), 'x');
    await writeFile(join(hidden, 'input.json'), '{}');

    const hooks = new SessionLifecycleHooksService();
    const documents = new Documents();
    const ledger = new Ledger();
    const reconciled: string[] = [];
    const flushed: string[] = [];
    const lifecycle: IAgentAdaptiveLifecycleService = {
      _serviceBrand: undefined,
      reconcileFork: async (source) => { reconciled.push(source); },
      flush: async () => { flushed.push('flush'); },
    };
    const agents = {
      _serviceBrand: undefined,
      list: () => [{
        agentId: 'main',
        accessor: {
          get: () => lifecycle,
        },
      }],
    } as unknown as IAgentLifecycleService;
    const session = {
      _serviceBrand: undefined,
      sessionId: 'target',
      sessionDir,
      cwd: '/workspace',
      scope: (key = '') => key.length === 0 ? 'sessions/target' : `sessions/target/${key}`,
    } as ISessionContext;

    new SessionAdaptiveLifecycleService(
      session,
      hooks,
      metadata({
        id: 'target',
        workspaceId: 'workspace',
        workspaceDir: '/workspace',
        title: 'Fork',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        forkedFrom: 'source',
      }),
      documents,
      ledger,
      agents,
    );

    await hooks.announceCreated({ kind: 'fork', sessionId: 'source' });

    expect(await exists(join(sessionDir, 'adaptive', 'workspaces'))).toBe(false);
    expect(await exists(join(sessionDir, 'adaptive', 'hidden-promotion'))).toBe(false);
    expect(documents.deleted).toEqual([
      'sessions/target/adaptive/baseline.json',
      'sessions/target/adaptive/evaluation-cache.json',
      'sessions/target/adaptive/manifest/adaptive-export-manifest.json',
    ]);
    expect(reconciled).toEqual(['source']);
    expect(ledger.appended.some(({ recordType }) => recordType === 'adaptive.session.forked'))
      .toBe(true);

    await hooks.announceWillClose();
    expect(flushed).toEqual(['flush']);
    expect(ledger.appended.some(({ recordType }) => recordType === 'adaptive.session.closed'))
      .toBe(true);
  });

  it('records resume only when adaptive evidence already exists', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'adaptive-resume-'));
    const hooks = new SessionLifecycleHooksService();
    const ledger = new Ledger();
    await ledger.append({ recordType: 'adaptive.run.started', payload: {} });
    const session = {
      _serviceBrand: undefined,
      sessionId: 'session',
      sessionDir,
      cwd: '/workspace',
      scope: (key = '') => key.length === 0 ? 'sessions/session' : `sessions/session/${key}`,
    } as ISessionContext;
    const agents = {
      _serviceBrand: undefined,
      list: () => [],
    } as unknown as IAgentLifecycleService;

    new SessionAdaptiveLifecycleService(
      session,
      hooks,
      metadata({
        id: 'session',
        workspaceId: 'workspace',
        workspaceDir: '/workspace',
        title: 'Resume',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
      new Documents(),
      ledger,
      agents,
    );

    await hooks.announceCreated({ kind: 'resume' });
    expect(ledger.appended.at(-1)?.recordType).toBe('adaptive.session.resumed');
  });
});
