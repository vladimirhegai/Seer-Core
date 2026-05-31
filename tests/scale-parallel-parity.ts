/**
 * Scale parallel-parity check (Step 6 gate).
 *
 * Indexes a real codebase twice — once serial, once parallel — and asserts
 * row-level equality across every interesting table. Also reports wall-clock
 * timing so we can see whether parallel actually pays off at scale.
 *
 * Run with:
 *   npm run test:scale-parallel-parity -- --only helix
 *   npm run test:scale-parallel-parity -- --only cbm,helix --jobs 6
 *
 * Existence: this is the gate for flipping the default to parallel-on. If
 * any row diff fires here, do NOT change the default.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Indexer } from '../src/indexer/index';
import { Store } from '../src/db/store';

interface Target {
  name: string;
  relativePath: string;
}

const ALL_TARGETS: Target[] = [
  { name: 'cbm',       relativePath: 'Large Codebases/codebase-memory-mcp-main' },
  { name: 'helix',     relativePath: 'Large Codebases/helix-master' },
  { name: 'client-go', relativePath: 'Large Codebases/client-go-master' },
  { name: 'react',     relativePath: 'Large Codebases/react-main' },
];

function parseArgs(): { targets: Target[]; jobs: number | undefined } {
  let only: string | null = null;
  let jobs: number | undefined;
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === '--only') only = process.argv[++i];
    else if (a === '--jobs') jobs = Number(process.argv[++i]);
  }
  const wanted = only ? new Set(only.split(',').map(s => s.trim())) : null;
  const targets = wanted ? ALL_TARGETS.filter(t => wanted.has(t.name)) : ALL_TARGETS;
  if (targets.length === 0) throw new Error(`no matching --only targets: ${only}`);
  return { targets, jobs };
}

// ── DB snapshot (same shape as tests/parallel-index.ts) ─────────────────────

interface DbSnapshot {
  files:                 unknown[];
  symbols:               unknown[];
  edges:                 unknown[];
  file_imports:          unknown[];
  routes:                unknown[];
  config_keys:           unknown[];
  external_dependencies: unknown[];
  pagerank_top:          unknown[];
  role_counts:           unknown;
}

function dumpDb(dbPath: string): DbSnapshot {
  const store = new Store(dbPath);
  const db = store.rawDb();
  const snap = {
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
    pagerank_top: db.prepare(`
      SELECT s.id, s.name, s.qualified_name, s.kind, f.rel_path, s.pagerank
      FROM symbols s JOIN files f ON f.id = s.file_id
      WHERE s.is_rankable = 1
      ORDER BY s.pagerank DESC, s.id ASC
      LIMIT 50
    `).all(),
    role_counts: store.getRoleCounts(),
  };
  store.close();
  return snap;
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
        `    serial:   …${sa.slice(Math.max(0, firstDiffAt - 80), firstDiffAt + 120)}…\n` +
        `    parallel: …${sb.slice(Math.max(0, firstDiffAt - 80), firstDiffAt + 120)}…`,
      );
    }
  }
  return out;
}

// ── Run ─────────────────────────────────────────────────────────────────────

async function indexOnce(repoRoot: string, parallel: boolean, jobs?: number): Promise<{
  dbPath: string;
  durationMs: number;
  filesIndexed: number;
  symbols: number;
  edges: number;
}> {
  const dbPath = path.join(
    os.tmpdir(),
    `seer-scale-parity-${parallel ? 'p' : 's'}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.db`,
  );
  const store = new Store(dbPath);
  const indexer = new Indexer(store);
  const t0 = Date.now();
  const res = await indexer.indexDirectory(repoRoot, { quiet: true, parallel, jobs });
  const dt = Date.now() - t0;
  store.close();
  return {
    dbPath,
    durationMs: dt,
    filesIndexed: res.filesIndexed,
    symbols: res.symbols,
    edges: res.edges,
  };
}

async function run(): Promise<void> {
  const { targets, jobs } = parseArgs();
  console.log('\nScale Parallel-Parity Check (Step 6 gate)');
  console.log('===========================================\n');
  console.log(`  jobs override: ${jobs ?? '(default)'}`);
  console.log(`  targets: ${targets.map(t => t.name).join(', ')}\n`);

  let totalFailed = 0;
  for (const t of targets) {
    const repoRoot = path.resolve(t.relativePath);
    if (!fs.existsSync(repoRoot)) {
      console.error(`  ✗ ${t.name}: ${t.relativePath} not found, skipping`);
      totalFailed++;
      continue;
    }
    console.log(`── ${t.name} (${t.relativePath}) ──`);

    const serial   = await indexOnce(repoRoot, false);
    console.log(`  serial:   ${serial.durationMs.toLocaleString().padStart(7)}ms  ` +
      `(${serial.filesIndexed} files, ${serial.symbols} symbols, ${serial.edges} edges)`);

    const parallel = await indexOnce(repoRoot, true, jobs);
    console.log(`  parallel: ${parallel.durationMs.toLocaleString().padStart(7)}ms  ` +
      `(${parallel.filesIndexed} files, ${parallel.symbols} symbols, ${parallel.edges} edges)`);
    const speedup = serial.durationMs / parallel.durationMs;
    console.log(`  speedup:  ${speedup.toFixed(2)}x`);

    const snapS = dumpDb(serial.dbPath);
    const snapP = dumpDb(parallel.dbPath);
    const diffs = diffSnapshots(snapS, snapP);
    if (diffs.length > 0) {
      for (const d of diffs) console.error(`    diff: ${d}`);
      console.error(`  ✗ ${t.name}: ${diffs.length} table(s) diverged\n`);
      totalFailed++;
    } else {
      console.log(`  ✓ ${t.name}: every table row-identical\n`);
    }

    try { fs.unlinkSync(serial.dbPath); } catch { /* */ }
    try { fs.unlinkSync(parallel.dbPath); } catch { /* */ }
  }

  console.log('═══════════════════════════════════════════════════════════════');
  if (totalFailed > 0) {
    console.error(`  ${totalFailed} target(s) FAILED parity. DO NOT flip default-on.\n`);
    process.exit(1);
  } else {
    console.log(`  All ${targets.length} target(s) parity ✓ — safe to flip default-on.\n`);
  }
}

run().catch(err => {
  console.error('scale-parallel-parity threw:', err);
  process.exit(1);
});
