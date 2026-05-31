/**
 * Parser worker — runs in its own V8 isolate via `worker_threads`.
 *
 * Each worker owns ONE `ParserContext` (its own WASM heap + grammar cache).
 * Workers do their own file I/O so the main thread keeps no prefetcher,
 * just dispatches paths and drains results.
 *
 * Protocol (see `WorkerInput` / `WorkerOutput`):
 *   main → worker: { kind: 'parse', seq, abs, lang, expectedHash, maxFileBytes }
 *   main → worker: { kind: 'shutdown' }
 *   worker → main: { kind: 'ready' }                                          (once, on startup)
 *   worker → main: { kind: 'parsed' | 'parse-error' | 'cached' | 'too-large' | 'io-error', seq, wasmResets, ... }
 *   worker → main: { kind: 'shutdown-ack' }                                   (just before exit)
 *
 * The worker is intentionally dumb about WHAT to do with extractions — it
 * just returns the FileExtraction. All DB writes happen on the main thread.
 *
 * Failure isolation: a WASM abort inside this worker is contained to this
 * isolate. The `ParserContext` already auto-resets the WASM runtime after
 * three consecutive failures. If the worker crashes outright the pool
 * detects the exit and requeues the inflight job (subject to a per-job
 * attempt limit so a poison file can't crash workers forever).
 */
import { parentPort } from 'worker_threads';
import fs from 'fs';
import crypto from 'crypto';
import type { FileExtraction, Language } from '../types.js';
import { ParserContext } from './parserContext.js';

// ── Protocol types (exported via re-export from index.ts for callers) ────────

export type WorkerInput =
  | {
      kind: 'parse';
      seq: number;
      abs: string;
      lang: Language;
      /** Known DB hash for this file; if the just-read hash matches, skip parse. */
      expectedHash: string | null;
      /** 0 = no cap. */
      maxFileBytes: number;
    }
  | { kind: 'shutdown' };

export type WorkerOutput =
  /** Posted exactly once, after `Parser.init()` has succeeded. */
  | { kind: 'ready' }
  /** Read + hashed + parsed successfully. */
  | {
      kind: 'parsed';
      seq: number;
      hash: string;
      lines: number;
      size: number;
      /** Cumulative ParserContext reset count in this worker isolate. */
      wasmResets: number;
      extraction: FileExtraction;
    }
  /** Read + hashed but parse returned null (tree-sitter gave up). */
  | { kind: 'parse-error'; seq: number; hash: string; lines: number; size: number; wasmResets: number }
  /** Read + hash matched `expectedHash` — no parse performed. */
  | { kind: 'cached'; seq: number; hash: string; lines: number; size: number; wasmResets: number }
  /** stat() reported size > maxFileBytes; file was not read. */
  | { kind: 'too-large'; seq: number; size: number; wasmResets: number }
  /** readFile or stat threw. */
  | { kind: 'io-error'; seq: number; error: string; wasmResets: number }
  /** Posted just before the worker calls process.exit(0) in response to shutdown. */
  | { kind: 'shutdown-ack' };

// ── Worker bootstrap ─────────────────────────────────────────────────────────

if (!parentPort) {
  throw new Error('parser/worker.ts must be loaded via worker_threads, not require()');
}

const port = parentPort;
const ctx = new ParserContext();

// Test-only crash hook. When `SEER_WORKER_TEST_CRASH_ON=<substr>` is set in
// the environment of the spawning process, the worker hard-crashes on any
// parse job whose `abs` contains `<substr>`. Used by `tests/parallel-recovery.ts`
// to verify that pool crash recovery (respawn + retry, attempt limit) works.
// Production never sets this variable.
const TEST_CRASH_ON: string | null =
  (typeof process !== 'undefined' && process.env && process.env.SEER_WORKER_TEST_CRASH_ON)
    ? process.env.SEER_WORKER_TEST_CRASH_ON
    : null;

// Test-only reset hook. It lets worker-pool/indexer tests verify reset-count
// aggregation deterministically without inducing a real tree-sitter WASM abort.
// Production never sets this variable.
const TEST_FAKE_WASM_RESET_ON: string | null =
  (typeof process !== 'undefined' && process.env && process.env.SEER_WORKER_TEST_FAKE_WASM_RESET_ON)
    ? process.env.SEER_WORKER_TEST_FAKE_WASM_RESET_ON
    : null;
let testExtraWasmResets = 0;

function post(msg: WorkerOutput): void {
  port.postMessage(msg);
}

function sha256Short(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
}

function wasmResetCount(): number {
  return ctx.wasmResetCount() + testExtraWasmResets;
}

async function handleParse(job: Extract<WorkerInput, { kind: 'parse' }>): Promise<void> {
  const { seq, abs, lang, expectedHash, maxFileBytes } = job;

  // Test-only crash hook.
  if (TEST_CRASH_ON && abs.includes(TEST_CRASH_ON)) {
    // Hard-exit so the parent observes a non-zero `exit` event — the pool's
    // crash path runs and we exercise respawn + retry + attempt-limit.
    process.exit(13);
  }
  if (TEST_FAKE_WASM_RESET_ON && abs.includes(TEST_FAKE_WASM_RESET_ON)) {
    testExtraWasmResets++;
  }

  // Size gate: only stat when a cap is in force, so the default-no-cap path
  // is one syscall (the readFile) per file.
  if (maxFileBytes > 0) {
    let size: number;
    try {
      size = (await fs.promises.stat(abs)).size;
    } catch (err) {
      post({ kind: 'io-error', seq, error: String((err as Error)?.message ?? err), wasmResets: wasmResetCount() });
      return;
    }
    if (size > maxFileBytes) {
      post({ kind: 'too-large', seq, size, wasmResets: wasmResetCount() });
      return;
    }
  }

  let content: string;
  try {
    content = await fs.promises.readFile(abs, 'utf8');
  } catch (err) {
    post({ kind: 'io-error', seq, error: String((err as Error)?.message ?? err), wasmResets: wasmResetCount() });
    return;
  }

  const hash = sha256Short(content);
  const lines = content.split('\n').length;
  const size = Buffer.byteLength(content, 'utf8');

  // Cache hit — main thread gave us a known hash for this path, and it
  // matches. Skip parsing entirely; main thread will still upsertFileWithCache
  // (so touchedFileIds is updated and pruneFilesNotIn does not delete this).
  if (expectedHash !== null && hash === expectedHash) {
    post({ kind: 'cached', seq, hash, lines, size, wasmResets: wasmResetCount() });
    return;
  }

  const extraction = await ctx.parseFile(content, abs, lang);
  if (!extraction) {
    post({ kind: 'parse-error', seq, hash, lines, size, wasmResets: wasmResetCount() });
    return;
  }
  post({ kind: 'parsed', seq, hash, lines, size, wasmResets: wasmResetCount(), extraction });
}

port.on('message', (msg: WorkerInput) => {
  if (msg.kind === 'shutdown') {
    post({ kind: 'shutdown-ack' });
    // Give the message a tick to flush before exit.
    setImmediate(() => process.exit(0));
    return;
  }
  // Errors inside handleParse must not crash the worker — they're caught,
  // logged through the protocol, and the worker stays alive for the next job.
  handleParse(msg).catch(err => {
    post({ kind: 'io-error', seq: msg.seq, error: `worker internal: ${String((err as Error)?.message ?? err)}`, wasmResets: wasmResetCount() });
  });
});

post({ kind: 'ready' });
