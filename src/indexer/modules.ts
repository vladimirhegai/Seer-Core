import path from 'path';
import { Store } from '../db/store.js';

/**
 * Track-E module clustering.
 *
 * We cluster the FILE graph (one node per indexed file) using Louvain
 * modularity maximization. The edge weight between two files is a deterministic
 * mix of:
 *   - cross-file call edges (weight 1 per call)
 *   - resolved import edges  (weight 2 per import — imports are a stronger
 *     architectural signal than a single call)
 *   - synthesized test edges (weight 3 per edge — test→prod is a very strong
 *     cohesion signal: agents want tests grouped with the production code
 *     they exercise)
 *
 * The Louvain pass is deliberately deterministic: file ids are visited in
 * ascending order, modularity-gain ties resolve to the lower-id community,
 * and the final community labels are remapped to 0..K-1 in the order their
 * representative file id was first encountered. Two builds against the same
 * DB therefore produce identical module ids — which the test suite asserts.
 *
 * After clustering we compute:
 *   - label: dominant top-level directory of the module's files; if two
 *     modules share the same dominant dir we append a numeric suffix
 *     (`auth`, `auth#1`, …) so labels stay unique without inventing a name.
 *   - primary_language: most common files.language among members
 *   - cohesion: intra-module weight / total weight touching the module
 *   - centrality: sum of PageRank of rankable symbols in the module
 *
 * And we cache cross-module edge weights into `module_edges` so
 * `seer_module_dependencies` is a single indexed lookup, not a join over
 * the full symbols/edges graph.
 */

export interface ModulesBuildResult {
  modules: number;
  files: number;
  passes: number;
  intraEdgesWeight: number;
  totalEdgesWeight: number;
  elapsedMs: number;
}

interface BuildOptions {
  /**
   * Cap on how many Louvain "move" sweeps we do at each level before
   * declaring convergence. 20 is well past what real graphs need; the cap
   * exists so a pathological graph can't burn the indexer's wall time.
   */
  maxSweeps?: number;
  /**
   * Minimum modularity gain that justifies recording another sweep. Below
   * this we treat the level as converged.
   */
  minGain?: number;
}

interface WeightedEdge { from: number; to: number; weight: number; kind: 'call' | 'import' | 'tests' | 'service' }

/**
 * Build (or rebuild) the modules / module_members / module_edges tables.
 *
 * Idempotent: re-running with the same DB state produces the same modules.
 * Cheap to call after every full index pass — empty graphs short-circuit.
 */
export function buildModules(store: Store, options: BuildOptions = {}): ModulesBuildResult {
  const start = Date.now();
  const maxSweeps = options.maxSweeps ?? 20;
  const minGain = options.minGain ?? 1e-6;

  const files = store.listFileSummaries();
  if (files.length === 0) {
    store.replaceModules([], []);
    return { modules: 0, files: 0, passes: 0, intraEdgesWeight: 0, totalEdgesWeight: 0, elapsedMs: Date.now() - start };
  }

  // ── Collect weighted file-level edges ────────────────────────────────────
  // Use a Map<string, edge> keyed by `${from}->${to}-${kind}` so duplicate
  // weights (same files connected via both calls and tests) coexist.
  const rawEdges: WeightedEdge[] = [];
  for (const e of store.fileCallEdgeWeights()) {
    rawEdges.push({ from: e.from, to: e.to, weight: e.weight, kind: 'call' });
  }
  for (const e of store.fileImportEdgeWeights()) {
    rawEdges.push({ from: e.from, to: e.to, weight: e.weight * 2, kind: 'import' });
  }
  for (const e of store.fileTestEdgeWeights()) {
    rawEdges.push({ from: e.from, to: e.to, weight: e.weight * 3, kind: 'tests' });
  }
  // v8 Track-G — service-link cross-file dependency. Same weight as tests
  // because a confirmed cross-service client→handler link is an
  // architecturally important coupling between modules.
  for (const e of store.fileServiceLinkEdgeWeights()) {
    rawEdges.push({ from: e.from, to: e.to, weight: e.weight * 3, kind: 'service' });
  }

  // ── Build symmetric adjacency for modularity. Louvain is defined on an
  //    undirected weighted graph, so collapse directed weights into a single
  //    weight per unordered pair. We keep the directed `rawEdges` around for
  //    the post-clustering module_edges aggregation.
  const allFileIds = files.map(f => f.id).sort((a, b) => a - b);
  const idIndex = new Map<number, number>();
  allFileIds.forEach((id, i) => idIndex.set(id, i));

  const n = allFileIds.length;
  const adjMap: Array<Map<number, number>> = Array.from({ length: n }, () => new Map());
  for (const e of rawEdges) {
    const fi = idIndex.get(e.from); const ti = idIndex.get(e.to);
    if (fi == null || ti == null || fi === ti) continue;
    adjMap[fi].set(ti, (adjMap[fi].get(ti) ?? 0) + e.weight);
    adjMap[ti].set(fi, (adjMap[ti].get(fi) ?? 0) + e.weight);
  }
  const adj = adjMap.map(m => Array.from(m.entries()).map(([j, w]) => ({ j, w })));
  const nodeWeight = adj.map(arr => arr.reduce((acc, x) => acc + x.w, 0));
  const totalWeight = nodeWeight.reduce((acc, x) => acc + x, 0);

  // ── Louvain single-level pass. We run one level — multi-level helps on
  //    graphs with millions of nodes, but for code modules the single level
  //    already produces clean clusters and runs in O(N * avg_degree) per
  //    sweep. The caller can always force more by raising maxSweeps.
  // Community assignment: starts at "every node its own community".
  let community = allFileIds.map((_, i) => i);
  let passes = 0;
  if (totalWeight > 0) {
    // Sum of weights inside each community (deg / inside).
    let commTot = nodeWeight.slice();
    let commIn = new Array<number>(n).fill(0);
    for (let sweep = 0; sweep < maxSweeps; sweep++) {
      passes++;
      let totalGain = 0;
      let movements = 0;
      // Visit nodes in ascending file-id order (== ascending index because
      // allFileIds is sorted). Deterministic.
      for (let i = 0; i < n; i++) {
        // Compute weights to neighboring communities.
        const ki = nodeWeight[i];
        const ciOld = community[i];
        // Sum of weights from i to nodes in each community (including own).
        const kiToComm = new Map<number, number>();
        let selfLoop = 0;
        for (const { j, w } of adj[i]) {
          if (j === i) { selfLoop += w; continue; }
          const c = community[j];
          kiToComm.set(c, (kiToComm.get(c) ?? 0) + w);
        }
        // Remove i from its current community.
        commTot[ciOld] -= ki;
        commIn[ciOld] -= 2 * (kiToComm.get(ciOld) ?? 0) + selfLoop;
        if (commIn[ciOld] < 0) commIn[ciOld] = 0;
        // Find best community to insert i. Candidate set = neighbor
        // communities + the singleton (own old community); ties favor the
        // lower community id so the result is deterministic.
        let bestComm = ciOld;
        let bestGain = 0;
        const candidates: number[] = Array.from(kiToComm.keys());
        candidates.sort((a, b) => a - b);
        // If ciOld isn't in candidates, include it so we can stay put.
        if (!kiToComm.has(ciOld)) candidates.push(ciOld);
        for (const c of candidates) {
          const kiInC = kiToComm.get(c) ?? 0;
          // ΔQ for moving i into community c (vs. its current isolation):
          //   gain = kiInC/m - (commTot[c] * ki) / (2 * m^2)
          const gain = (kiInC / totalWeight) - (commTot[c] * ki) / (2 * totalWeight * totalWeight);
          if (gain > bestGain + 1e-12 || (Math.abs(gain - bestGain) < 1e-12 && c < bestComm)) {
            bestGain = gain;
            bestComm = c;
          }
        }
        // Insert i into bestComm.
        commTot[bestComm] += ki;
        commIn[bestComm] += 2 * (kiToComm.get(bestComm) ?? 0) + selfLoop;
        if (bestComm !== ciOld) {
          community[i] = bestComm;
          movements++;
          totalGain += bestGain;
        }
      }
      if (movements === 0 || totalGain < minGain) break;
    }
  }

  // ── Remap community labels to 0..K-1 in encounter order ─────────────────
  // Encounter order = order of file-id ascending (= index order). Two builds
  // of the same DB therefore produce the same label numbers.
  const labelByOldComm = new Map<number, number>();
  let nextLabel = 0;
  const finalCluster = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const c = community[i];
    let lab = labelByOldComm.get(c);
    if (lab === undefined) {
      lab = nextLabel++;
      labelByOldComm.set(c, lab);
    }
    finalCluster[i] = lab;
  }
  const K = nextLabel;

  // ── Build per-module metadata ──────────────────────────────────────────
  const memberIds: number[][] = Array.from({ length: K }, () => []);
  const memberPaths: string[][] = Array.from({ length: K }, () => []);
  const memberLangs: string[][] = Array.from({ length: K }, () => []);
  for (let i = 0; i < n; i++) {
    const k = finalCluster[i];
    memberIds[k].push(allFileIds[i]);
    memberPaths[k].push(files[idIndex.get(allFileIds[i])!]?.relPath ?? '');
    memberLangs[k].push(files[idIndex.get(allFileIds[i])!]?.language ?? '');
  }

  // PageRank centrality per file id — one query, partitioned in JS.
  const prByFile = new Map<number, number>();
  const prRows = store.rawDb().prepare(`
    SELECT file_id AS fileId, SUM(pagerank) AS prSum
    FROM symbols WHERE is_rankable = 1
    GROUP BY file_id
  `).all() as Array<{ fileId: unknown; prSum: unknown }>;
  for (const r of prRows) {
    prByFile.set(Number(r.fileId), Number(r.prSum ?? 0));
  }

  const symbolCountByFile = new Map<number, number>();
  const symRows = store.rawDb().prepare(`
    SELECT file_id AS fileId, COUNT(*) AS c
    FROM symbols WHERE is_rankable = 1
    GROUP BY file_id
  `).all() as Array<{ fileId: unknown; c: unknown }>;
  for (const r of symRows) {
    symbolCountByFile.set(Number(r.fileId), Number(r.c));
  }

  // Module dominant directory → label. Two modules with the same dominant
  // dir get numeric suffixes (#1, #2, …) so labels stay unique.
  const labelUseCount = new Map<string, number>();
  const moduleEntries: Array<{
    label: string;
    sizeFiles: number;
    sizeSymbols: number;
    primaryLanguage: string | null;
    cohesion: number;
    centrality: number;
    fileIds: number[];
  }> = [];

  for (let k = 0; k < K; k++) {
    const dominantDir = dominantTopLevelDir(memberPaths[k]) ?? `module-${k}`;
    const used = labelUseCount.get(dominantDir) ?? 0;
    const label = used === 0 ? dominantDir : `${dominantDir}#${used}`;
    labelUseCount.set(dominantDir, used + 1);

    const primaryLanguage = dominantString(memberLangs[k]);
    let symCount = 0;
    let centrality = 0;
    for (const fid of memberIds[k]) {
      symCount += symbolCountByFile.get(fid) ?? 0;
      centrality += prByFile.get(fid) ?? 0;
    }
    moduleEntries.push({
      label,
      sizeFiles: memberIds[k].length,
      sizeSymbols: symCount,
      primaryLanguage,
      cohesion: 0, // computed below once we have aggregated edges
      centrality,
      fileIds: memberIds[k],
    });
  }

  // ── Aggregate cross-module edges (per kind) ───────────────────────────
  // We use the directed `rawEdges` here so call vs import vs tests stay
  // distinguishable in module_edges.
  const moduleByFile = new Map<number, number>();
  for (let i = 0; i < n; i++) moduleByFile.set(allFileIds[i], finalCluster[i]);

  const edgeAgg = new Map<string, { fromIndex: number; toIndex: number; kind: string; weight: number }>();
  const intraByModule = new Array<number>(K).fill(0);
  const totalByModule = new Array<number>(K).fill(0);
  for (const e of rawEdges) {
    const fm = moduleByFile.get(e.from);
    const tm = moduleByFile.get(e.to);
    if (fm == null || tm == null) continue;
    totalByModule[fm] += e.weight;
    if (fm === tm) {
      intraByModule[fm] += e.weight;
    } else {
      totalByModule[tm] += e.weight;
      const key = `${fm}->${tm}:${e.kind}`;
      const ex = edgeAgg.get(key);
      if (ex) ex.weight += e.weight;
      else edgeAgg.set(key, { fromIndex: fm, toIndex: tm, kind: e.kind, weight: e.weight });
    }
  }
  let intraTotal = 0;
  let allTotal = 0;
  for (let k = 0; k < K; k++) {
    const total = totalByModule[k];
    const intra = intraByModule[k];
    moduleEntries[k].cohesion = total > 0 ? intra / total : 1;
    intraTotal += intra;
    allTotal += total;
  }

  store.replaceModules(moduleEntries, Array.from(edgeAgg.values()));

  return {
    modules: K,
    files: n,
    passes,
    intraEdgesWeight: intraTotal,
    totalEdgesWeight: allTotal,
    elapsedMs: Date.now() - start,
  };
}

// ── helpers ─────────────────────────────────────────────────────────────────

/**
 * Most-frequent top-level directory of a list of relative file paths.
 * Files at the repo root return their basename's first identifier-like
 * chunk so we never end up with empty labels.
 */
function dominantTopLevelDir(paths: string[]): string | null {
  if (paths.length === 0) return null;
  const counts = new Map<string, number>();
  for (const p of paths) {
    const norm = p.replace(/\\/g, '/');
    const slash = norm.indexOf('/');
    const head = slash > 0 ? norm.slice(0, slash) : rootBasename(norm);
    if (!head) continue;
    counts.set(head, (counts.get(head) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  // Deterministic tie-break: lexicographic.
  const sorted = Array.from(counts.entries()).sort((a, b) =>
    b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
  );
  return sorted[0][0];
}

function rootBasename(p: string): string {
  const ext = path.extname(p);
  const base = ext ? p.slice(0, p.length - ext.length) : p;
  return base;
}

function dominantString(xs: string[]): string | null {
  if (xs.length === 0) return null;
  const counts = new Map<string, number>();
  for (const x of xs) {
    if (!x) continue;
    counts.set(x, (counts.get(x) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  const sorted = Array.from(counts.entries()).sort((a, b) =>
    b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
  );
  return sorted[0][0];
}
