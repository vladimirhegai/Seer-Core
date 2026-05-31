/**
 * WorkerPool parity test (Step 3 of parallel parsing).
 *
 * Verifies that the pool produces results byte-identical to in-process
 * `parseFile()` for every fixture, that the consumer callback is invoked in
 * input order regardless of worker scheduling, that bounded out-of-order
 * buffering works under load, and that shutdown is clean.
 *
 * Crash recovery is exercised lightly here (mismatched expectedHash, missing
 * paths) — the heavier stress and worker-death tests live in Step 5
 * (`tests/parallel-recovery.ts`).
 *
 * Run with: npm run test:worker-pool
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { parseFile, detectLanguage } from '../src/parser/index';
import type { Language } from '../src/types';
import { WorkerPool, defaultWorkerPath, WorkItem, PoolResult } from '../src/parser/workerpool';

const FIXTURES_DIR        = path.join(__dirname, 'fixtures');
const FIXTURES_TRACKCD    = path.join(__dirname, 'fixtures-trackcd');

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

// ── Run ──────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  console.log('\nWorker Pool Parity Test (Step 3)');
  console.log('==================================\n');

  if (!fs.existsSync(defaultWorkerPath())) {
    console.error(`  ✗ ${defaultWorkerPath()} not found — run \`npm run build\` first.`);
    process.exit(1);
  }

  // Build the canonical reference set: serial parseFile for every fixture.
  console.log('Building serial reference set...');
  const allFiles = [...listFiles(FIXTURES_DIR), ...listFiles(FIXTURES_TRACKCD)];
  const items: WorkItem[] = [];
  const referenceCanon: Array<string | null> = [];
  for (const abs of allFiles) {
    const lang = detectLanguage(abs);
    if (!lang) continue;
    const content = fs.readFileSync(abs, 'utf8');
    const ref = await parseFile(content, abs, lang);
    items.push({ abs, lang: lang as Language, expectedHash: null, maxFileBytes: 0 });
    referenceCanon.push(ref ? canon(ref) : null);
  }
  console.log(`  ${items.length} fixtures in reference set\n`);

  // ── 1. Pool dispatch matches serial reference (in-order callback) ─────────
  for (const jobs of [1, 2, 4, 8]) {
    console.log(`── Pool with jobs=${jobs} — per-fixture parity ──`);
    const pool = new WorkerPool({ jobs });
    await pool.ready();
    assert(pool.jobs === jobs, `pool spawned ${jobs} worker(s)`);

    let inOrder = true;
    let lastSeq = -1;
    const got: PoolResult[] = new Array(items.length);
    await pool.dispatch(items, (seq, result) => {
      if (seq !== lastSeq + 1) inOrder = false;
      lastSeq = seq;
      got[seq] = result;
    });

    assert(inOrder, `callback invoked strictly in input order (jobs=${jobs})`);
    assert(lastSeq === items.length - 1, `every item delivered exactly once (jobs=${jobs})`);

    let parityHits = 0;
    let parityMisses = 0;
    for (let i = 0; i < items.length; i++) {
      const r = got[i];
      const ref = referenceCanon[i];
      if (r.kind === 'parsed' && ref !== null && canon(r.extraction) === ref) parityHits++;
      else {
        parityMisses++;
        console.error(`    miss seq=${i} file=${path.relative(__dirname, items[i].abs)} kind=${r.kind}`);
      }
    }
    assert(parityMisses === 0, `all ${items.length} fixtures byte-equal to serial (jobs=${jobs})`);

    await pool.shutdown();
    console.log('');
  }

  // ── 2. Empty dispatch is a no-op (no workers spawned, returns immediately) ─
  console.log('── Empty dispatch ──');
  {
    const pool = new WorkerPool({ jobs: 4 });
    let invoked = 0;
    await pool.dispatch([], () => { invoked++; });
    assert(invoked === 0, 'empty dispatch invokes callback zero times');
    await pool.shutdown();
  }

  // ── 3. Bounded out-of-order buffer holds under load (maxLag tiny) ─────────
  console.log('\n── Bounded out-of-order buffer (maxLag=3, 200 jobs) ──');
  {
    const pool = new WorkerPool({ jobs: 4, maxLag: 3 });
    await pool.ready();
    // Repeat one cheap fixture many times so we get genuine concurrency.
    const tsFixture = path.join(FIXTURES_DIR, 'sample.ts');
    const refContent = fs.readFileSync(tsFixture, 'utf8');
    const ref = await parseFile(refContent, tsFixture, 'typescript');
    const refStr = canon(ref);
    const N = 200;
    const items: WorkItem[] = [];
    for (let i = 0; i < N; i++) {
      items.push({ abs: tsFixture, lang: 'typescript', expectedHash: null, maxFileBytes: 0 });
    }
    let inOrder = true;
    let lastSeq = -1;
    let allMatched = true;
    await pool.dispatch(items, (seq, result) => {
      if (seq !== lastSeq + 1) inOrder = false;
      lastSeq = seq;
      if (result.kind !== 'parsed' || canon(result.extraction) !== refStr) allMatched = false;
    });
    assert(inOrder, '200-job dispatch stays in-order under maxLag=3');
    assert(allMatched, 'every result still byte-equal under bounded backpressure');
    await pool.shutdown();
  }

  // ── 4. Cached / too-large / io-error route through correctly ──────────────
  console.log('\n── Mixed result kinds route through pool callback ──');
  {
    const pool = new WorkerPool({ jobs: 2 });
    await pool.ready();
    const tsFixture = path.join(FIXTURES_DIR, 'sample.ts');
    const knownHash = sha256Short(fs.readFileSync(tsFixture, 'utf8'));
    const ghost    = path.join(os.tmpdir(), 'seer-pool-nonexistent-' + Date.now() + '.ts');

    const items: WorkItem[] = [
      { abs: tsFixture, lang: 'typescript', expectedHash: knownHash, maxFileBytes: 0 },        // → cached
      { abs: tsFixture, lang: 'typescript', expectedHash: null,      maxFileBytes: 1 },        // → too-large
      { abs: ghost,     lang: 'typescript', expectedHash: null,      maxFileBytes: 0 },        // → io-error
      { abs: tsFixture, lang: 'typescript', expectedHash: null,      maxFileBytes: 0 },        // → parsed
    ];
    const kinds: string[] = [];
    await pool.dispatch(items, (seq, result) => { kinds[seq] = result.kind; });
    assert(kinds[0] === 'cached',    `seq 0 → cached  (got ${kinds[0]})`);
    assert(kinds[1] === 'too-large', `seq 1 → too-large (got ${kinds[1]})`);
    assert(kinds[2] === 'io-error',  `seq 2 → io-error (got ${kinds[2]})`);
    assert(kinds[3] === 'parsed',    `seq 3 → parsed (got ${kinds[3]})`);
    await pool.shutdown();
  }

  // ── 5. Clean shutdown leaves no live workers ──────────────────────────────
  console.log('\n── Worker-local WASM reset aggregation ──');
  {
    process.env.SEER_WORKER_TEST_FAKE_WASM_RESET_ON = 'FAKE_WASM_RESET';
    const pool = new WorkerPool({ jobs: 2 });
    try {
      await pool.ready();
      const src = path.join(FIXTURES_DIR, 'sample.ts');
      const resetFixture = path.join(os.tmpdir(), `FAKE_WASM_RESET-${Date.now()}.ts`);
      fs.copyFileSync(src, resetFixture);
      const items: WorkItem[] = [
        { abs: resetFixture, lang: 'typescript', expectedHash: null, maxFileBytes: 0 },
        { abs: src,          lang: 'typescript', expectedHash: null, maxFileBytes: 0 },
        { abs: resetFixture, lang: 'typescript', expectedHash: null, maxFileBytes: 0 },
      ];
      await pool.dispatch(items, () => {});
      assert(pool.wasmResetCount() === 2, `pool aggregates worker-local wasm resets (got ${pool.wasmResetCount()})`);
      fs.rmSync(resetFixture, { force: true });
      await pool.shutdown();
    } finally {
      delete process.env.SEER_WORKER_TEST_FAKE_WASM_RESET_ON;
      await pool.terminate().catch(() => { /* */ });
    }
  }

  // ── 6. Clean shutdown leaves no live workers ──────────────────────────────
  console.log('\n── Clean shutdown ──');
  {
    const pool = new WorkerPool({ jobs: 4 });
    await pool.ready();
    await pool.shutdown();
    // Second shutdown is a safe no-op (idempotent).
    await pool.shutdown();
    assert(true, 'shutdown() is idempotent');
  }

  // ── 7. Reject double-dispatch ─────────────────────────────────────────────
  console.log('\n── Reject overlapping dispatch ──');
  {
    const pool = new WorkerPool({ jobs: 2 });
    await pool.ready();
    const tsFixture = path.join(FIXTURES_DIR, 'sample.ts');
    const items: WorkItem[] = new Array(20).fill(null).map(() => ({
      abs: tsFixture, lang: 'typescript' as Language, expectedHash: null, maxFileBytes: 0,
    }));
    const first = pool.dispatch(items, () => {});
    let secondThrew = false;
    try {
      await pool.dispatch(items, () => {});
    } catch {
      secondThrew = true;
    }
    assert(secondThrew, 'overlapping dispatch() rejects');
    await first;
    await pool.shutdown();
  }

  // ── Done ───────────────────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(`  Worker-pool results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error('\n  WORKER-POOL TESTS FAILED\n');
    process.exit(1);
  } else {
    console.log('\n  All worker-pool tests passed! ✓\n');
  }
}

run().catch(err => {
  console.error('worker-pool test threw:', err);
  process.exit(1);
});
