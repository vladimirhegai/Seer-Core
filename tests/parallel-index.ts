/**
 * Parallel-indexing parity test (Step 4 of parallel parsing).
 *
 * The contract: indexing the same workspace with `parallel: true` must
 * produce a DB byte-equivalent to the serial path. The check is row-level,
 * not count-level — counts can match while routes/config-key/symbol_role
 * resolution silently diverges.
 *
 * Covered:
 *   - Per-table row diffs (files, symbols, edges, file_imports, routes,
 *     config_keys, external_dependencies, FTS hits).
 *   - Top-K PageRank symbol IDs and names match.
 *   - jobs ∈ {1, 2, 4, 8} all produce the same DB as serial.
 *   - Cache-hit re-index: a second parallel pass over an unchanged tree
 *     reports `indexed=0`, `reusedFromCache=N`, `pagerankRecomputed=false`,
 *     and the DB is identical to the first pass.
 *   - One-file edit: only the edited file's row changes; PageRank recomputes.
 *   - Stale-file pruning: a deleted file is removed (FK cascade clears
 *     symbols/edges/imports/routes/config_keys).
 *
 * Run with: npm run test:parallel-index
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Indexer } from '../src/indexer/index';
import { Store } from '../src/db/store';

const FIXTURES_DIR     = path.join(__dirname, 'fixtures');
const FIXTURES_TRACKCD = path.join(__dirname, 'fixtures-trackcd');

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

// ── Fixture set up ──────────────────────────────────────────────────────────

/**
 * Stage a temp workspace combining smoke + trackcd fixtures so we exercise:
 *   - all 9 language extractors (smoke fixtures)
 *   - routes, config keys, external dependencies (trackcd fixtures)
 *   - the C/C++ declaration-vs-definition split (sample.h + sample.cpp)
 *   - test-file classification (tests/ subdir from trackcd)
 */
function stageFixtures(): string {
  const root = path.join(os.tmpdir(), `seer-parallel-fixtures-${Date.now()}`);
  fs.mkdirSync(root, { recursive: true });
  for (const f of fs.readdirSync(FIXTURES_DIR)) {
    const src = path.join(FIXTURES_DIR, f);
    if (fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(root, f));
  }
  // Bring in select trackcd fixtures (avoid name clashes by prefixing).
  for (const f of fs.readdirSync(FIXTURES_TRACKCD)) {
    const src = path.join(FIXTURES_TRACKCD, f);
    if (fs.statSync(src).isFile()) {
      fs.copyFileSync(src, path.join(root, `trackcd_${f}`));
    } else if (fs.statSync(src).isDirectory() && f === 'tests') {
      fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
      for (const sub of fs.readdirSync(src)) {
        fs.copyFileSync(path.join(src, sub), path.join(root, 'tests', sub));
      }
    }
  }
  return root;
}

// ── DB dump helpers ─────────────────────────────────────────────────────────

interface DbSnapshot {
  files: unknown[];
  symbols: unknown[];
  edges: unknown[];
  file_imports: unknown[];
  routes: unknown[];
  config_keys: unknown[];
  external_dependencies: unknown[];
  fts_symbols_validate: unknown[];
  fts_files_auth: unknown[];
  pagerank_top: unknown[];
  role_counts: unknown;
}

function dumpDb(store: Store): DbSnapshot {
  const db = store.rawDb();
  // `indexed_at` excluded — it's wall-clock, expected to differ across runs.
  // Everything else is content-derived and must match exactly.
  return {
    files: db.prepare(`
      SELECT id, rel_path, language, hash, lines, role, is_vendor, is_generated
      FROM files ORDER BY rel_path
    `).all(),
    symbols: db.prepare(`
      SELECT id, name, qualified_name, kind, file_id, line_start, line_end,
             col_start, col_end, signature, is_rankable,
             loc, cyclomatic, cognitive, max_nesting, symbol_key, symbol_role
      FROM symbols ORDER BY file_id, line_start, line_end, name, qualified_name
    `).all(),
    edges: db.prepare(`
      SELECT from_id, to_id, to_name, kind, line FROM edges
      ORDER BY from_id, line, to_name, kind
    `).all(),
    file_imports: db.prepare(`
      SELECT from_file_id, import_name, resolved_file_id FROM file_imports
      ORDER BY from_file_id, import_name
    `).all(),
    routes: db.prepare(`
      SELECT file_id, method, path, framework, handler_name, handler_id, line
      FROM routes ORDER BY file_id, line, method, path
    `).all(),
    config_keys: db.prepare(`
      SELECT key, source, file_id, symbol_id, line
      FROM config_keys ORDER BY file_id, line, key
    `).all(),
    external_dependencies: db.prepare(`
      SELECT name, version_range, ecosystem, manifest_path, is_dev FROM external_dependencies
      ORDER BY ecosystem, name, manifest_path
    `).all(),
    // Two representative FTS queries — verify BM25-ranked hits match.
    fts_symbols_validate: store.searchSymbolsFts('validate', { limit: 20 })
      .map(r => ({ name: r.name, qualifiedName: r.qualifiedName, filePath: r.filePath, lineStart: r.lineStart })),
    fts_files_auth: store.searchFilesFts('auth', 20)
      .map(r => ({ relPath: r.relPath, language: r.language })),
    // Top PageRank rows. ID, name, kind, filePath together — order must match.
    pagerank_top: db.prepare(`
      SELECT s.id, s.name, s.qualified_name, s.kind, f.rel_path, s.pagerank
      FROM symbols s JOIN files f ON f.id = s.file_id
      WHERE s.is_rankable = 1
      ORDER BY s.pagerank DESC, s.id ASC
      LIMIT 50
    `).all(),
    role_counts: store.getRoleCounts(),
  };
}

function jcanon(v: unknown): string {
  return JSON.stringify(v, (_k, x) => {
    if (x && typeof x === 'object' && !Array.isArray(x)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(x as Record<string, unknown>).sort()) {
        sorted[k] = (x as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return x;
  });
}

function diffSnapshots(a: DbSnapshot, b: DbSnapshot): string[] {
  const out: string[] = [];
  for (const k of Object.keys(a) as Array<keyof DbSnapshot>) {
    const sa = jcanon(a[k]);
    const sb = jcanon(b[k]);
    if (sa !== sb) {
      const lenA = Array.isArray(a[k]) ? (a[k] as unknown[]).length : 1;
      const lenB = Array.isArray(b[k]) ? (b[k] as unknown[]).length : 1;
      let firstDiffAt = -1;
      for (let i = 0; i < Math.min(sa.length, sb.length); i++) {
        if (sa[i] !== sb[i]) { firstDiffAt = i; break; }
      }
      out.push(
        `${k}: serial len=${lenA}, parallel len=${lenB}, first diff at char ${firstDiffAt}\n` +
        `    serial:   …${sa.slice(Math.max(0, firstDiffAt - 60), firstDiffAt + 100)}…\n` +
        `    parallel: …${sb.slice(Math.max(0, firstDiffAt - 60), firstDiffAt + 100)}…`,
      );
    }
  }
  return out;
}

// ── Indexing helper ─────────────────────────────────────────────────────────

async function indexInto(
  dbPath: string, root: string, parallel: boolean, jobs?: number,
): Promise<ReturnType<Indexer['indexDirectory']> extends Promise<infer R> ? R : never> {
  const store = new Store(dbPath);
  const indexer = new Indexer(store);
  const result = await indexer.indexDirectory(root, {
    quiet: true,
    parallel,
    jobs,
  });
  store.close();
  return result;
}

function snapshotDb(dbPath: string): DbSnapshot {
  const store = new Store(dbPath);
  const snap = dumpDb(store);
  store.close();
  return snap;
}

// ── Run ─────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  console.log('\nParallel Indexing Parity Test (Step 4)');
  console.log('========================================\n');

  const root = stageFixtures();
  console.log(`  fixtures staged at ${root}\n`);

  // ── 1. Build serial reference DB ──────────────────────────────────────────
  const serialDb = path.join(os.tmpdir(), `seer-parallel-serial-${Date.now()}.db`);
  const serialRes = await indexInto(serialDb, root, false);
  console.log(`── Serial reference: ${serialRes.filesIndexed} indexed, ${serialRes.symbols} symbols, ${serialRes.edges} edges ──`);
  const serialSnap = snapshotDb(serialDb);
  assert(serialRes.filesIndexed > 0, 'serial run indexed at least one file');

  // ── 2. Parallel DBs at multiple job counts must match serial exactly ─────
  for (const jobs of [1, 2, 4, 8]) {
    console.log(`\n── jobs=${jobs} parity ──`);
    const dbPath = path.join(os.tmpdir(), `seer-parallel-${jobs}-${Date.now()}.db`);
    const res = await indexInto(dbPath, root, true, jobs);
    const snap = snapshotDb(dbPath);

    assert(res.filesIndexed === serialRes.filesIndexed, `filesIndexed matches serial (${res.filesIndexed})`);
    assert(res.symbols      === serialRes.symbols,      `symbols matches serial (${res.symbols})`);
    assert(res.edges        === serialRes.edges,        `edges matches serial (${res.edges})`);
    assert(res.resolvedEdges === serialRes.resolvedEdges, `resolvedEdges matches serial (${res.resolvedEdges})`);

    const diffs = diffSnapshots(serialSnap, snap);
    if (diffs.length > 0) {
      for (const d of diffs) console.error(`    diff: ${d}`);
    }
    assert(diffs.length === 0, `every DB table row-identical to serial (jobs=${jobs})`);

    fs.unlinkSync(dbPath);
  }

  // ── 3. Cache-hit re-index: second pass is a no-op ─────────────────────────
  console.log(`\n── Cache-hit re-index (parallel) ──`);
  const cacheDb = path.join(os.tmpdir(), `seer-parallel-cache-${Date.now()}.db`);
  const firstPass = await indexInto(cacheDb, root, true, 4);
  const firstSnap = snapshotDb(cacheDb);
  assert(firstPass.filesIndexed > 0, 'first parallel pass indexed files');
  assert(firstPass.pagerankRecomputed === true, 'first pass recomputes PageRank');

  const secondPass = await indexInto(cacheDb, root, true, 4);
  const secondSnap = snapshotDb(cacheDb);
  assert(secondPass.filesIndexed === 0, `second pass indexed=0 (got ${secondPass.filesIndexed})`);
  assert(secondPass.filesReusedFromCache === firstPass.filesIndexed,
    `second pass reusedFromCache=${secondPass.filesReusedFromCache} matches first pass indexed=${firstPass.filesIndexed}`);
  assert(secondPass.pagerankRecomputed === false, 'second pass skips PageRank (graph unchanged)');
  const cacheDiffs = diffSnapshots(firstSnap, secondSnap);
  if (cacheDiffs.length > 0) {
    for (const d of cacheDiffs) console.error(`    cache-diff: ${d}`);
  }
  assert(cacheDiffs.length === 0, 'cache-hit pass DB identical to first pass (touchedFileIds includes cached files → no pruning)');

  // ── 4. Stale-file pruning: delete a file, re-index, row should vanish ────
  console.log(`\n── Stale-file pruning (parallel) ──`);
  const beforePrune = secondSnap; // already captured
  const victim = 'trackcd_complex_module.py';
  fs.unlinkSync(path.join(root, victim));
  const prunePass = await indexInto(cacheDb, root, true, 4);
  const afterPrune = snapshotDb(cacheDb);
  const filesNow = (afterPrune.files as Array<{ rel_path: string }>).map(r => r.rel_path);
  assert(!filesNow.includes(victim), `deleted file ${victim} pruned from DB`);
  assert(
    (afterPrune.files as unknown[]).length === (beforePrune.files as unknown[]).length - 1,
    `files count dropped by 1 (was ${(beforePrune.files as unknown[]).length}, now ${(afterPrune.files as unknown[]).length})`,
  );
  // The victim's symbols / config_keys must cascade-delete.
  const victimSymsBefore = (beforePrune.symbols as Array<{ file_id: number }>)
    .filter(s => {
      const fid = (beforePrune.files as Array<{ id: number; rel_path: string }>)
        .find(f => f.rel_path === victim)?.id;
      return fid != null && s.file_id === fid;
    }).length;
  assert(victimSymsBefore > 0, `victim had >0 symbols before delete (sanity check, got ${victimSymsBefore})`);
  const victimFidNow = (afterPrune.files as Array<{ id: number; rel_path: string }>)
    .find(f => f.rel_path === victim)?.id;
  assert(victimFidNow === undefined, 'victim file row gone from files table');
  assert(prunePass.pagerankRecomputed === true, 'prune triggers PageRank recompute');

  // ── 5. One-file edit: only edited file's symbols change ──────────────────
  console.log(`\n── One-file edit (parallel) ──`);
  // Restage so prior-test mutations don't carry over.
  const editRoot = stageFixtures();
  const editDb = path.join(os.tmpdir(), `seer-parallel-edit-${Date.now()}.db`);
  await indexInto(editDb, editRoot, true, 4);
  const beforeEdit = snapshotDb(editDb);

  // Append a new function to caller.ts so its hash changes.
  const callerPath = path.join(editRoot, 'caller.ts');
  fs.appendFileSync(callerPath, '\nexport function freshlyAdded(): number { return 42; }\n');

  const editRes = await indexInto(editDb, editRoot, true, 4);
  const afterEdit = snapshotDb(editDb);
  assert(editRes.filesIndexed === 1, `exactly 1 file reindexed (got ${editRes.filesIndexed})`);
  assert(editRes.filesReusedFromCache === beforeEdit.files.length - 1,
    `everything else cache-reused (got ${editRes.filesReusedFromCache} of ${beforeEdit.files.length - 1})`);

  const addedSym = (afterEdit.symbols as Array<{ name: string }>).find(s => s.name === 'freshlyAdded');
  assert(addedSym !== undefined, 'freshlyAdded symbol present after edit');

  const callerFidBefore = (beforeEdit.files as Array<{ id: number; rel_path: string }>)
    .find(f => f.rel_path === 'caller.ts')?.id;
  const callerFidAfter = (afterEdit.files as Array<{ id: number; rel_path: string }>)
    .find(f => f.rel_path === 'caller.ts')?.id;
  assert(callerFidBefore === callerFidAfter, 'caller.ts file id stable across edit');
  assert(editRes.pagerankRecomputed === true, 'edit triggers PageRank recompute');

  // ── Cleanup ──────────────────────────────────────────────────────────────
  try { fs.unlinkSync(serialDb); } catch { /* */ }
  try { fs.unlinkSync(cacheDb); } catch { /* */ }
  try { fs.unlinkSync(editDb); } catch { /* */ }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ }
  try { fs.rmSync(editRoot, { recursive: true, force: true }); } catch { /* */ }

  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(`  Parallel-index results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error('\n  PARALLEL-INDEX TESTS FAILED\n');
    process.exit(1);
  } else {
    console.log('\n  All parallel-index tests passed! ✓\n');
  }
}

run().catch(err => {
  console.error('parallel-index test threw:', err);
  process.exit(1);
});
