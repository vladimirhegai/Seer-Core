/**
 * Worker-parity test (Step 2 of parallel parsing).
 *
 * Verifies that parsing a file inside a worker_threads `Worker` produces
 * byte-identical results to parsing the same file in-process via
 * `parseFile()`. Also exercises the cached / too-large / io-error result
 * kinds and clean shutdown.
 *
 * The worker is the compiled `dist/parser/worker.js` artifact — this test
 * requires `npm run build` to have run first (the `test:worker-parity`
 * package script chains them).
 *
 * Run with: npm run test:worker-parity
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { Worker } from 'worker_threads';
import { parseFile, detectLanguage } from '../src/parser/index';
import type { Language, FileExtraction } from '../src/types';
import type { WorkerInput, WorkerOutput } from '../src/parser/worker';

const FIXTURES_DIR        = path.join(__dirname, 'fixtures');
const FIXTURES_TRACKCD    = path.join(__dirname, 'fixtures-trackcd');
const WORKER_PATH         = path.join(__dirname, '..', 'dist', 'parser', 'worker.js');

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.error(`  ✗ ${message}`);
    failed++;
  }
}

function sha256Short(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
}

/** Walk a directory and collect all files (recursive). */
function listFiles(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}

/**
 * Canonicalize a FileExtraction for byte-equal comparison. JSON.stringify
 * with sorted keys is enough here — the walker emits arrays in a
 * deterministic traversal order so we don't need to sort them.
 */
function canon(obj: unknown): string {
  return JSON.stringify(obj, (_k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[k] = (v as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return v;
  });
}

// ── Worker controller ────────────────────────────────────────────────────────

interface PendingResolver {
  resolve: (out: WorkerOutput) => void;
  reject: (err: Error) => void;
}

class WorkerController {
  private worker: Worker;
  private pending = new Map<number, PendingResolver>();
  private ready: Promise<void>;
  private exitPromise: Promise<number>;
  private exitCode: number | null = null;

  constructor(workerPath: string) {
    this.worker = new Worker(workerPath);
    let readyResolve: () => void = () => {};
    this.ready = new Promise<void>(r => { readyResolve = r; });
    let exitResolve: (code: number) => void = () => {};
    this.exitPromise = new Promise<number>(r => { exitResolve = r; });

    this.worker.on('message', (msg: WorkerOutput) => {
      if (msg.kind === 'ready') { readyResolve(); return; }
      if (msg.kind === 'shutdown-ack') return; // we observe via 'exit'
      const seq = (msg as { seq: number }).seq;
      const pending = this.pending.get(seq);
      if (!pending) {
        console.error(`unexpected result for seq=${seq}: ${msg.kind}`);
        return;
      }
      this.pending.delete(seq);
      pending.resolve(msg);
    });

    this.worker.on('error', err => {
      for (const [, p] of this.pending) p.reject(err);
      this.pending.clear();
    });

    this.worker.on('exit', code => {
      this.exitCode = code;
      exitResolve(code);
      const reason = new Error(`worker exited with code ${code}`);
      for (const [, p] of this.pending) p.reject(reason);
      this.pending.clear();
    });
  }

  awaitReady(): Promise<void> { return this.ready; }
  awaitExit(): Promise<number> { return this.exitPromise; }
  getExitCode(): number | null { return this.exitCode; }

  send(job: Extract<WorkerInput, { kind: 'parse' }>): Promise<WorkerOutput> {
    return new Promise<WorkerOutput>((resolve, reject) => {
      this.pending.set(job.seq, { resolve, reject });
      this.worker.postMessage(job);
    });
  }

  shutdown(): void {
    this.worker.postMessage({ kind: 'shutdown' } satisfies WorkerInput);
  }

  terminate(): Promise<number> {
    return this.worker.terminate();
  }
}

// ── Run ──────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  console.log('\nWorker Parity Test (Step 2)');
  console.log('============================\n');

  if (!fs.existsSync(WORKER_PATH)) {
    console.error(`  ✗ ${WORKER_PATH} not found — run \`npm run build\` first.`);
    process.exit(1);
  }
  console.log(`  worker: ${WORKER_PATH}`);

  const ctrl = new WorkerController(WORKER_PATH);
  await ctrl.awaitReady();
  console.log('  worker ready\n');

  // ── 1. Parity over every fixture ───────────────────────────────────────────
  console.log('── Per-fixture parity (worker vs in-process parseFile) ──');

  const all = [...listFiles(FIXTURES_DIR), ...listFiles(FIXTURES_TRACKCD)];
  let seq = 0;
  let perFixtureChecks = 0;
  for (const abs of all) {
    const lang = detectLanguage(abs);
    if (!lang) continue;
    perFixtureChecks++;
    seq++;
    const content = fs.readFileSync(abs, 'utf8');
    const reference = await parseFile(content, abs, lang);
    const result = await ctrl.send({
      kind: 'parse', seq, abs, lang, expectedHash: null, maxFileBytes: 0,
    });

    const ok = reference !== null
      && result.kind === 'parsed'
      && canon((result as Extract<WorkerOutput, { kind: 'parsed' }>).extraction) === canon(reference);
    if (!ok) {
      console.error(`    seq=${seq} file=${path.relative(__dirname, abs)} kind=${result.kind}`);
      if (result.kind === 'parsed' && reference !== null) {
        // Print first 200 chars of diff for forensic value
        const r = canon((result as Extract<WorkerOutput, { kind: 'parsed' }>).extraction);
        const ref = canon(reference);
        for (let i = 0; i < Math.min(r.length, ref.length); i++) {
          if (r[i] !== ref[i]) {
            console.error(`    first diff at char ${i}:`);
            console.error(`      ref: …${ref.slice(Math.max(0, i - 40), i + 40)}…`);
            console.error(`      got: …${r.slice(Math.max(0, i - 40), i + 40)}…`);
            break;
          }
        }
      }
    }
    assert(ok, `parity ${path.relative(__dirname, abs)}`);
  }
  console.log(`  (checked ${perFixtureChecks} fixtures)\n`);

  // ── 2. Cached branch ───────────────────────────────────────────────────────
  console.log('── Cached branch (expectedHash === actual hash → skip parse) ──');

  // Pick a known fixture and exercise both cache-hit and cache-miss.
  const tsFixture = path.join(FIXTURES_DIR, 'sample.ts');
  if (fs.existsSync(tsFixture)) {
    const content = fs.readFileSync(tsFixture, 'utf8');
    const knownHash = sha256Short(content);

    seq++;
    const hit = await ctrl.send({
      kind: 'parse', seq, abs: tsFixture, lang: 'typescript',
      expectedHash: knownHash, maxFileBytes: 0,
    });
    assert(hit.kind === 'cached', `expectedHash matches → result.kind === 'cached'`);
    if (hit.kind === 'cached') {
      assert(hit.hash === knownHash, `cached result echoes the computed hash`);
      assert(hit.lines > 0, `cached result reports line count`);
      assert(hit.size > 0, `cached result reports byte size`);
    }

    seq++;
    const miss = await ctrl.send({
      kind: 'parse', seq, abs: tsFixture, lang: 'typescript',
      expectedHash: 'deadbeefdeadbeef', maxFileBytes: 0,
    });
    assert(miss.kind === 'parsed', `expectedHash mismatch → result.kind === 'parsed'`);
  }

  // ── 3. Too-large branch ────────────────────────────────────────────────────
  console.log('\n── Too-large branch (maxFileBytes < size) ──');

  if (fs.existsSync(tsFixture)) {
    seq++;
    const big = await ctrl.send({
      kind: 'parse', seq, abs: tsFixture, lang: 'typescript',
      expectedHash: null, maxFileBytes: 1,
    });
    assert(big.kind === 'too-large', `maxFileBytes=1 → 'too-large'`);
    if (big.kind === 'too-large') {
      assert(big.size > 1, `too-large reports the actual size (${big.size}B > 1B cap)`);
    }
  }

  // ── 4. IO-error branch ─────────────────────────────────────────────────────
  console.log('\n── IO-error branch (path does not exist) ──');

  seq++;
  const ghost = await ctrl.send({
    kind: 'parse', seq,
    abs: path.join(os.tmpdir(), 'seer-worker-parity-nonexistent-' + Date.now() + '.ts'),
    lang: 'typescript', expectedHash: null, maxFileBytes: 0,
  });
  assert(ghost.kind === 'io-error', `nonexistent path → 'io-error'`);

  // ── 5. Worker is still alive after an io-error ─────────────────────────────
  console.log('\n── Worker recovers from io-error (still parses next job) ──');

  if (fs.existsSync(tsFixture)) {
    seq++;
    const after = await ctrl.send({
      kind: 'parse', seq, abs: tsFixture, lang: 'typescript',
      expectedHash: null, maxFileBytes: 0,
    });
    assert(after.kind === 'parsed', `worker still parses after an io-error`);
  }

  // ── 6. Clean shutdown ──────────────────────────────────────────────────────
  console.log('\n── Clean shutdown ──');
  ctrl.shutdown();
  const code = await ctrl.awaitExit();
  assert(code === 0, `worker exits with code 0 after shutdown (got ${code})`);

  // ── Done ───────────────────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(`  Worker-parity results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error('\n  WORKER-PARITY TESTS FAILED\n');
    process.exit(1);
  } else {
    console.log('\n  All worker-parity tests passed! ✓\n');
  }
}

run().catch(err => {
  console.error('worker-parity test threw:', err);
  process.exit(1);
});
