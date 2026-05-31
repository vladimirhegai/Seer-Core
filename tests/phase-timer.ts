/**
 * Per-phase timing diagnostic.
 * Usage: tsx tests/phase-timer.ts [path/to/repo]
 */

import path from 'path';
import fs from 'fs';
import os from 'os';
import { Store } from '../src/db/store';
import { Indexer } from '../src/indexer/index';
import { buildShapeHashes } from '../src/indexer/shapehash';
import { buildModules } from '../src/indexer/modules';
import { buildBoundaries } from '../src/indexer/boundaries';
import { buildContinuity } from '../src/indexer/continuity';
import { computePageRank } from '../src/graph/pagerank';
import { resolveServiceLinks } from '../src/indexer/serviceLinks';

function lap(label: string, ms: number) {
  const bar = '█'.repeat(Math.min(40, Math.round(ms / 25)));
  console.log(`  ${label.padEnd(36)} ${ms.toString().padStart(6)} ms  ${bar}`);
}

(async () => {
  const repoPath = process.argv[2] ?? path.join(process.cwd(), 'Large Codebases', 'helix-master');
  const absRepo = path.resolve(repoPath);

  if (!fs.existsSync(absRepo)) {
    console.error(`Repo not found: ${absRepo}`);
    process.exit(1);
  }

  const dbPath = path.join(os.tmpdir(), `phase-timer-${Date.now()}.db`);
  console.log(`Repo: ${absRepo}`);
  console.log('');

  // ── 1. Full fresh index ────────────────────────────────────────────────────
  {
    const store = new Store(dbPath);
    const indexer = new Indexer(store);
    const t = Date.now();
    const r = await indexer.indexDirectory(absRepo, { quiet: true });
    const fullMs = Date.now() - t;
    store.close();
    console.log(`Full fresh index: ${fullMs} ms`);
    console.log(`  files indexed: ${r.filesIndexed}   symbols: ${r.symbols}   edges: ${r.edges}`);
    console.log('');
  }

  // ── 2. Per-phase timing on the already-indexed DB ─────────────────────────
  const store = new Store(dbPath, true);

  console.log('Per-phase breakdown (on already-indexed DB):\n');

  { const t = Date.now(); store.resolveImports(); lap('resolveImports', Date.now() - t); }
  { const t = Date.now(); store.resolveEdges(); lap('resolveEdges', Date.now() - t); }

  {
    const t = Date.now();
    store.resolveRouteHandlers();
    store.resolveConfigKeySymbols();
    store.synthesizeTestEdges();
    lap('routes+config+testEdges', Date.now() - t);
  }

  {
    const t = Date.now();
    try { resolveServiceLinks(store, {}); } catch { /* */ }
    lap('resolveServiceLinks', Date.now() - t);
  }

  {
    const t = Date.now();
    try {
      const { extractExternalDependencies } = await import('../src/indexer/externaldeps');
      await extractExternalDependencies(absRepo, store);
    } catch { /* */ }
    lap('extractExternalDependencies', Date.now() - t);
  }

  {
    const t = Date.now();
    const symbolIds = store.getAllSymbolIds();
    const edges = store.getAllEdges();
    const ranks = computePageRank(symbolIds, edges);
    store.updatePageRanks(ranks);
    lap(`PageRank (${symbolIds.length} syms, ${edges.length} edges)`, Date.now() - t);
  }

  {
    const t = Date.now();
    buildModules(store);
    const files = store.listFileSummaries().length;
    lap(`buildModules (${files} files)`, Date.now() - t);
  }

  {
    const t = Date.now();
    const r = buildBoundaries(absRepo, store);
    store.replaceBoundaries(r.boundaries, r.edges);
    lap(`buildBoundaries (${r.boundaries.length} boundaries)`, Date.now() - t);
  }

  {
    const t = Date.now();
    const r = buildShapeHashes(store, { force: true });
    lap(`buildShapeHashes (${r.symbolsHashed} symbols)`, Date.now() - t);
  }

  {
    const t = Date.now();
    buildContinuity(store, {});
    lap('buildContinuity (lazy)', Date.now() - t);
  }

  store.close();
  try { fs.unlinkSync(dbPath); } catch { /* */ }

  console.log('\nDone.');
})();
