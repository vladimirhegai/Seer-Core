/**
 * WorkerPool — a fixed-size pool of parser workers with ordered draining,
 * bounded out-of-order buffering, per-job attempt limits, and crash recovery.
 *
 * Used by the indexer's parallel-parsing path. The pool owns:
 *   - N workers, each its own V8 isolate + WASM heap.
 *   - A FIFO queue of pending jobs.
 *   - A small bounded buffer for out-of-order completions (results that
 *     finished ahead of the current head seq are held until the head
 *     advances). The buffer is bounded by `maxLag` so a slow head can't
 *     pile up unbounded memory.
 *   - An "inflight" map: workerId → currently-assigned job. On worker
 *     death this is what gets requeued.
 *
 * Design discipline:
 *   - Workers parse only. The pool never touches the DB or graph.
 *   - The consumer callback is invoked strictly in input order. Symbol IDs
 *     in the indexer depend on this for cross-run determinism.
 *   - Crashes are recoverable but bounded: a job that has crashed `maxAttempts`
 *     workers in a row is reported as a parse-error and the run continues.
 *   - Shutdown is graceful: drain inflight, send `shutdown` to each worker,
 *     await exit. Terminate is the hammer for tests.
 */
import { Worker } from 'worker_threads';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { Language } from '../types.js';
import type { WorkerInput, WorkerOutput } from './worker.js';

// ── Public types ─────────────────────────────────────────────────────────────

export interface WorkerPoolOptions {
  /** Number of worker threads. Defaults to min(8, max(1, availableParallelism()-1)). */
  jobs?: number;
  /** Path to the compiled worker .js. Defaults to dist/parser/worker.js next to this module. */
  workerPath?: string;
  /**
   * Max gap between the head seq (next to drain) and any dispatched seq.
   * Bounds the out-of-order buffer at `maxLag` results in memory.
   * Default: `jobs * 4`.
   */
  maxLag?: number;
  /**
   * Max times the same seq can be reattempted after a worker crash before
   * we give up and mark it parse-error. Defaults to 3. (One legitimate try +
   * two retries through respawned workers.)
   */
  maxAttempts?: number;
}

export interface WorkItem {
  abs: string;
  lang: Language;
  /** Known DB hash for this file (null if no DB row). */
  expectedHash: string | null;
  /** Per-file byte cap. 0 = no cap. */
  maxFileBytes: number;
}

/** What the consumer callback receives. `result` is one of the worker output kinds (minus the lifecycle ones). */
export type PoolResult =
  | Extract<WorkerOutput, { kind: 'parsed' }>
  | Extract<WorkerOutput, { kind: 'parse-error' }>
  | Extract<WorkerOutput, { kind: 'cached' }>
  | Extract<WorkerOutput, { kind: 'too-large' }>
  | Extract<WorkerOutput, { kind: 'io-error' }>;

export type ResultCallback = (seq: number, result: PoolResult, item: WorkItem) => void | Promise<void>;

// ── Worker handle ────────────────────────────────────────────────────────────

interface WorkerHandle {
  id: number;
  worker: Worker;
  inflight: { seq: number; item: WorkItem } | null;
  ready: boolean;
  wasmResets: number;
}

// ── Default worker-path resolver ─────────────────────────────────────────────
//
// Workers always run from the compiled .js artifact. In dev (tsx) the source
// of this module is .ts; we reflect __dirname to dist. This means callers
// must `npm run build` before turning on parallel mode in dev — which matches
// the pattern already used by the MCP test suite. If the dist artifact is
// missing we throw with a clear message rather than silently fall back.

export function defaultWorkerPath(): string {
  const here = __filename;
  if (here.endsWith('.js')) {
    return path.join(__dirname, 'worker.js');
  }
  // Source mode: reflect src/parser/<this>.ts → dist/parser/worker.js.
  const distDir = __dirname
    .replace(`${path.sep}src${path.sep}parser`, `${path.sep}dist${path.sep}parser`)
    .replace('/src/parser', '/dist/parser');
  const distWorker = path.join(distDir, 'worker.js');
  if (!fs.existsSync(distWorker)) {
    throw new Error(
      `Parallel parsing requires the compiled worker at ${distWorker}. ` +
      `Run \`npm run build\` first, or set SEER_PARALLEL_PARSE=0.`,
    );
  }
  return distWorker;
}

// ── WorkerPool ───────────────────────────────────────────────────────────────

export class WorkerPool {
  private readonly workerPath: string;
  private readonly maxLag: number;
  private readonly maxAttempts: number;
  private readonly _jobs: number;

  private workers: WorkerHandle[] = [];
  private idle: WorkerHandle[] = [];
  private nextWorkerId = 0;

  /** Sequence number of the next result we expect to deliver via the callback. */
  private headSeq = 0;
  /** Total jobs in the current dispatch. */
  private totalJobs = 0;
  /** Next seq to send to a worker. */
  private nextDispatchSeq = 0;
  /** seq → WorkItem (for the entire dispatch). */
  private items: WorkItem[] = [];
  /** seq → attempt count. */
  private attempts = new Map<number, number>();
  /** Out-of-order buffer for seq > headSeq. */
  private buffered = new Map<number, PoolResult>();
  /** Awaiting-worker queue: seqs that need to be dispatched but no worker is free. */
  private pendingDispatch: number[] = [];
  /** Currently active dispatch — null when idle. */
  private active: {
    onResult: ResultCallback;
    resolve: () => void;
    reject: (err: Error) => void;
    delivering: Promise<void>;
  } | null = null;
  /**
   * Synchronous flag set the moment `dispatch()` is entered. Prevents two
   * synchronous `dispatch()` calls from both passing the `if (this.active)`
   * guard before the first reaches its `await this.ready()`. `this.active`
   * itself is set after that await, so it can't be the only guard.
   */
  private dispatching = false;
  /** A rolling promise chain so the consumer callback is invoked strictly serially. */
  private callbackChain: Promise<void> = Promise.resolve();
  private _wasmResets = 0;

  private terminated = false;

  constructor(opts: WorkerPoolOptions = {}) {
    this._jobs = Math.max(1, opts.jobs ?? defaultJobCount());
    this.workerPath = opts.workerPath ?? defaultWorkerPath();
    this.maxLag = Math.max(this._jobs, opts.maxLag ?? this._jobs * 4);
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
  }

  /** Number of workers actually spawned (after `ready()`). */
  get jobs(): number { return this._jobs; }

  /** Total worker-local ParserContext resets observed across this pool. */
  wasmResetCount(): number { return this._wasmResets; }

  /** Spawn workers and wait for all of them to post `ready`. */
  async ready(): Promise<void> {
    if (this.workers.length > 0) return; // already spawned
    const readyPromises: Array<Promise<void>> = [];
    for (let i = 0; i < this._jobs; i++) {
      const handle = this.spawnWorker();
      this.workers.push(handle);
      readyPromises.push(
        new Promise<void>((resolve, reject) => {
          handle.worker.once('error', reject);
          const onMsg = (msg: WorkerOutput): void => {
            if (msg.kind === 'ready') {
              handle.ready = true;
              this.idle.push(handle);
              handle.worker.off('message', onMsg);
              resolve();
            }
          };
          handle.worker.on('message', onMsg);
        }),
      );
    }
    await Promise.all(readyPromises);
  }

  /**
   * Dispatch every WorkItem to the pool. The callback is invoked exactly once
   * per item, in input order, regardless of which worker finished it.
   *
   * Resolves when every item has been delivered to the callback. Rejects if
   * the pool is terminated mid-dispatch.
   */
  async dispatch(items: WorkItem[], onResult: ResultCallback): Promise<void> {
    if (this.dispatching || this.active) {
      throw new Error('WorkerPool: dispatch already in progress');
    }
    if (this.terminated) {
      throw new Error('WorkerPool: terminated');
    }
    if (items.length === 0) return;
    this.dispatching = true;
    try {
      await this.ready();

      this.items = items;
      this.totalJobs = items.length;
      this.headSeq = 0;
      this.nextDispatchSeq = 0;
      this.attempts.clear();
      this.buffered.clear();
      this.pendingDispatch.length = 0;
      this.callbackChain = Promise.resolve();

      await new Promise<void>((resolve, reject) => {
        this.active = {
          onResult,
          resolve,
          reject,
          delivering: this.callbackChain,
        };
        this.pump();
      });

      // Wait for the callback chain to fully drain before returning.
      await this.callbackChain;
      this.active = null;
      this.items = [];
    } finally {
      this.dispatching = false;
    }
  }

  /** Shutdown: send 'shutdown' to each worker, await all exits. */
  async shutdown(): Promise<void> {
    if (this.terminated) return;
    this.terminated = true;
    const exits: Array<Promise<void>> = [];
    for (const h of this.workers) {
      exits.push(new Promise<void>(resolve => {
        h.worker.once('exit', () => resolve());
        try { h.worker.postMessage({ kind: 'shutdown' } satisfies WorkerInput); }
        catch { resolve(); }
      }));
    }
    await Promise.all(exits);
    this.workers = [];
    this.idle = [];
  }

  /** Hammer: force-terminate all workers. Use only when shutdown() can't. */
  async terminate(): Promise<void> {
    if (this.terminated && this.workers.length === 0) return;
    this.terminated = true;
    const exits: Array<Promise<number>> = [];
    for (const h of this.workers) exits.push(h.worker.terminate());
    await Promise.all(exits);
    this.workers = [];
    this.idle = [];
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  /** Pump dispatch + drain until either no work is left or no slack remains. */
  private pump(): void {
    // 1. Dispatch as many new seqs as backpressure allows.
    //    Constraint: seqDispatched < headSeq + maxLag, so the buffered out-of-order
    //    set can't grow past `maxLag` entries.
    while (
      this.idle.length > 0
      && this.nextDispatchSeq < this.totalJobs
      && this.nextDispatchSeq < this.headSeq + this.maxLag
    ) {
      const seq = this.nextDispatchSeq++;
      const handle = this.idle.pop()!;
      this.sendJob(handle, seq);
    }
    // 2. Also drain any pendingDispatch (requeued after a crash) while workers idle.
    while (this.idle.length > 0 && this.pendingDispatch.length > 0) {
      const seq = this.pendingDispatch.shift()!;
      const handle = this.idle.pop()!;
      this.sendJob(handle, seq);
    }
    // 3. If everything is delivered, finish the dispatch.
    if (this.active && this.headSeq >= this.totalJobs) {
      const a = this.active;
      // Resolve once the callback chain has drained the last buffered result.
      this.callbackChain.then(() => a.resolve(), err => a.reject(err));
    }
  }

  private sendJob(handle: WorkerHandle, seq: number): void {
    const item = this.items[seq];
    handle.inflight = { seq, item };
    const job: WorkerInput = {
      kind: 'parse',
      seq,
      abs: item.abs,
      lang: item.lang,
      expectedHash: item.expectedHash,
      maxFileBytes: item.maxFileBytes,
    };
    try {
      handle.worker.postMessage(job);
    } catch (err) {
      // Worker is gone — treat as crash.
      this.onWorkerCrash(handle, err as Error);
    }
  }

  private spawnWorker(): WorkerHandle {
    const id = this.nextWorkerId++;
    const worker = new Worker(this.workerPath);
    const handle: WorkerHandle = { id, worker, inflight: null, ready: false, wasmResets: 0 };

    worker.on('message', (msg: WorkerOutput) => this.onWorkerMessage(handle, msg));
    worker.on('error', err => this.onWorkerCrash(handle, err));
    worker.on('exit', code => {
      if (this.terminated) return;
      if (handle.inflight) {
        // Unexpected exit during a job.
        this.onWorkerCrash(handle, new Error(`worker ${id} exited with code ${code} mid-job`));
        return;
      }
      // Exited idle — only fine if we're tearing down. If we're still active,
      // respawn so the pool doesn't shrink under load.
      if (this.active && !this.terminated) {
        this.respawnWorker(handle);
      }
    });
    return handle;
  }

  private respawnWorker(dead: WorkerHandle): void {
    const idx = this.workers.indexOf(dead);
    if (idx >= 0) this.workers.splice(idx, 1);
    const idleIdx = this.idle.indexOf(dead);
    if (idleIdx >= 0) this.idle.splice(idleIdx, 1);

    const fresh = this.spawnWorker();
    this.workers.push(fresh);
    // Wait for fresh worker's ready message before counting it as idle.
    const onMsg = (msg: WorkerOutput): void => {
      if (msg.kind === 'ready') {
        fresh.ready = true;
        fresh.worker.off('message', onMsg);
        this.idle.push(fresh);
        if (this.active) this.pump();
      }
    };
    fresh.worker.on('message', onMsg);
  }

  private onWorkerCrash(handle: WorkerHandle, err: Error): void {
    const job = handle.inflight;
    handle.inflight = null;

    if (job) {
      const prior = this.attempts.get(job.seq) ?? 0;
      const attempts = prior + 1;
      this.attempts.set(job.seq, attempts);

      if (attempts >= this.maxAttempts) {
        // Give up on this seq — synthesize a parse-error so the dispatch can drain.
        this.deliver(job.seq, {
          kind: 'parse-error',
          seq: job.seq,
          hash: '',
          lines: 0,
          size: 0,
          wasmResets: handle.wasmResets,
        });
      } else {
        // Retry on another worker.
        this.pendingDispatch.push(job.seq);
      }
    }

    if (!this.terminated && this.active) {
      this.respawnWorker(handle);
    } else {
      // Out-of-band crash — surface only if no active dispatch is going to swallow it.
      if (this.active && !job) this.active.reject(err);
    }
  }

  private onWorkerMessage(handle: WorkerHandle, msg: WorkerOutput): void {
    if (msg.kind === 'ready' || msg.kind === 'shutdown-ack') return;

    const seq = (msg as { seq: number }).seq;
    // Worker becomes idle again right away.
    if (handle.inflight && handle.inflight.seq === seq) handle.inflight = null;
    if (!this.idle.includes(handle)) this.idle.push(handle);

    if ('wasmResets' in msg) {
      const total = msg.wasmResets;
      const delta = Math.max(0, total - handle.wasmResets);
      handle.wasmResets = total;
      this._wasmResets += delta;
    }

    this.deliver(seq, msg as PoolResult);
  }

  private deliver(seq: number, result: PoolResult): void {
    if (!this.active) return; // late message after shutdown
    if (seq === this.headSeq) {
      this.invokeCallback(seq, result);
      this.headSeq++;
      // Drain any contiguous buffered successors.
      while (this.buffered.has(this.headSeq)) {
        const next = this.buffered.get(this.headSeq)!;
        this.buffered.delete(this.headSeq);
        this.invokeCallback(this.headSeq, next);
        this.headSeq++;
      }
    } else {
      this.buffered.set(seq, result);
    }
    this.pump();
  }

  private invokeCallback(seq: number, result: PoolResult): void {
    if (!this.active) return;
    const a = this.active;
    const item = this.items[seq];
    this.callbackChain = this.callbackChain.then(() => Promise.resolve(a.onResult(seq, result, item)));
    // If the callback rejects, surface it through the active dispatch.
    this.callbackChain = this.callbackChain.catch(err => {
      if (this.active) this.active.reject(err);
    });
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function defaultJobCount(): number {
  // availableParallelism is the most accurate counter on cgroup-limited
  // containers; fall back to cpus().length on older Node where it's missing.
  const fn = (os as unknown as { availableParallelism?: () => number }).availableParallelism;
  const cores = typeof fn === 'function' ? fn() : os.cpus().length;
  return Math.min(8, Math.max(1, cores - 1));
}
