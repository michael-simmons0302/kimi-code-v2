import { Worker } from 'node:worker_threads';

import type { WorldModelMethod } from './worldModel';

export interface WorldModelRuntimeOptions {
  readonly timeoutMs: number;
  readonly memoryLimitMb: number;
  readonly seed?: string;
  readonly signal?: AbortSignal;
}

interface WorkerSuccess {
  readonly ok: true;
  readonly value: unknown;
}

interface WorkerFailure {
  readonly ok: false;
  readonly error: string;
  readonly stack?: string;
}

type WorkerResult = WorkerSuccess | WorkerFailure;

const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const vm = require('node:vm');

function hashSeed(text) {
  let value = 2166136261 >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 16777619) >>> 0;
  }
  return value || 1;
}

function seededRandom(seedText) {
  let state = hashSeed(seedText || '0');
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

function safeMath(seed) {
  const target = {};
  for (const name of Object.getOwnPropertyNames(Math)) {
    const descriptor = Object.getOwnPropertyDescriptor(Math, name);
    if (descriptor) Object.defineProperty(target, name, descriptor);
  }
  Object.defineProperty(target, 'random', {
    value: seededRandom(seed),
    writable: false,
    configurable: false,
    enumerable: false,
  });
  return Object.freeze(target);
}

const context = vm.createContext(
  {
    Math: safeMath(workerData.seed),
    JSON,
    process: undefined,
    require: undefined,
    module: undefined,
    exports: undefined,
    fetch: undefined,
    WebSocket: undefined,
    Buffer: undefined,
    Date: undefined,
    setTimeout: undefined,
    setInterval: undefined,
    clearTimeout: undefined,
    clearInterval: undefined,
    console: undefined,
  },
  {
    name: 'world-model',
    codeGeneration: { strings: false, wasm: false },
  },
);

let model;
try {
  const script = new vm.Script(
    '"use strict";\n' + workerData.source + '\n;globalThis.worldModel;',
    { filename: 'world-model.candidate.js' },
  );
  model = script.runInContext(context, { timeout: workerData.initializationTimeoutMs });
  if (model === null || typeof model !== 'object') {
    throw new Error('Candidate must assign an object to globalThis.worldModel.');
  }
} catch (error) {
  parentPort.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error), stack: error && error.stack });
  return;
}

parentPort.on('message', async ({ method, args }) => {
  try {
    const fn = model[method];
    if (typeof fn !== 'function') throw new Error('World model method is not implemented: ' + method);
    const value = await fn.apply(undefined, args);
    parentPort.postMessage({ ok: true, value });
  } catch (error) {
    parentPort.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error), stack: error && error.stack });
  }
});
`;

export async function invokeWorldModelModule<T>(
  compiledSource: string,
  method: WorldModelMethod,
  args: readonly unknown[],
  options: WorldModelRuntimeOptions,
): Promise<T> {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new RangeError('World model timeout must be positive.');
  }
  if (!Number.isFinite(options.memoryLimitMb) || options.memoryLimitMb < 16) {
    throw new RangeError('World model memory limit must be at least 16 MiB.');
  }
  options.signal?.throwIfAborted();

  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: {
      source: compiledSource,
      seed: options.seed ?? '0',
      initializationTimeoutMs: Math.min(5_000, options.timeoutMs),
    },
    resourceLimits: {
      maxOldGenerationSizeMb: Math.floor(options.memoryLimitMb),
      maxYoungGenerationSizeMb: Math.max(8, Math.floor(options.memoryLimitMb / 4)),
      stackSizeMb: 4,
    },
  });

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      void worker.terminate();
      callback();
    };
    const onAbort = (): void => finish(() => reject(options.signal?.reason ?? new Error('World model invocation cancelled.')));
    const timer = setTimeout(
      () => finish(() => reject(new Error(`World model invocation timed out after ${options.timeoutMs}ms.`))),
      options.timeoutMs,
    );
    options.signal?.addEventListener('abort', onAbort, { once: true });
    worker.once('error', (error) => finish(() => reject(error)));
    worker.once('exit', (code) => {
      if (!settled && code !== 0) finish(() => reject(new Error(`World model worker exited with code ${code}.`)));
    });
    worker.once('message', (message: WorkerResult) => {
      if (message.ok) {
        finish(() => resolve(message.value as T));
      } else {
        const error = new Error(message.error);
        if (message.stack !== undefined) error.stack = message.stack;
        finish(() => reject(error));
      }
    });
    worker.postMessage({ method, args });
  });
}
