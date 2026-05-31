/**
 * v10 — Monorepo package/service boundary detection.
 *
 * Source signals (in priority order — earlier sources win on overlap):
 *   1. Nested manifest files:
 *      - package.json (npm/yarn/pnpm workspaces)
 *      - pyproject.toml
 *      - Cargo.toml
 *      - go.mod
 *      - composer.json
 *   2. Workspace-declared globs:
 *      - package.json:workspaces
 *      - pnpm-workspace.yaml
 *      - turbo.json / nx.json pipelines
 *      - go.work
 *      - Cargo workspace members (parent Cargo.toml [workspace])
 *   3. Convention fallback:
 *      - packages/<name>/
 *      - services/<name>/
 *      - apps/<name>/
 *      - libs/<name>/
 *
 * Each detected boundary owns a contiguous subtree of files. The TRUE root
 * is the deepest manifest/glob root — so `packages/core/src/lib/foo.ts`
 * belongs to `packages/core/` if a package.json sits there.
 *
 * Boundary `label` is derived from the manifest name (`@scope/pkg` → `pkg`,
 * etc.) when present, else from the root_rel_path segment.
 *
 * Boundary dependencies come from cross-boundary call/import/service edges
 * aggregated across resolved graphs. Strictly advisory — never gates anything.
 */

import fs from 'fs';
import path from 'path';
import { Store } from '../db/store.js';

export interface BoundaryDef {
  label: string;
  kind: 'package' | 'service' | 'app' | 'lib' | 'workspace-root' | 'convention';
  rootRelPath: string;
  manifestPath: string | null;
  ecosystem: string | null;
  fileIds: number[];
}

export interface BoundaryEdgeDef {
  fromIndex: number;
  toIndex: number;
  kind: 'call' | 'import' | 'service';
  weight: number;
}

export interface BoundaryBuildResult {
  boundaries: BoundaryDef[];
  edges: BoundaryEdgeDef[];
  /** Files that didn't match any boundary. */
  orphanFiles: number;
}

interface ManifestHit {
  relRoot: string;
  manifestPath: string;
  label: string;
  kind: BoundaryDef['kind'];
  ecosystem: string | null;
}

/**
 * Detect boundaries by walking the workspace once for manifests + convention
 * fallback, then assigning each indexed file to the deepest matching
 * boundary root.
 */
export function buildBoundaries(workspace: string, store: Store): BoundaryBuildResult {
  const absRoot = path.resolve(workspace);

  // Discover manifest hits.
  const hits = discoverManifests(absRoot);
  // Also seed convention-based hits when no manifest matches a directory.
  seedConventionRoots(absRoot, hits);

  // Materialize hits as boundary defs. De-dup by relRoot — manifest wins
  // over convention.
  const byRel = new Map<string, ManifestHit>();
  for (const h of hits) {
    const prev = byRel.get(h.relRoot);
    if (!prev || rank(h) > rank(prev)) byRel.set(h.relRoot, h);
  }
  const sortedHits = Array.from(byRel.values()).sort((a, b) =>
    b.relRoot.length - a.relRoot.length || (a.relRoot < b.relRoot ? -1 : 1));

  // Assign every indexed file to the deepest matching hit.
  const files = store.listFiles();
  const fileToHit = new Map<number, ManifestHit | null>();
  for (const f of files) {
    let assigned: ManifestHit | null = null;
    const rel = normalizePath(f.relPath);
    for (const h of sortedHits) {
      const root = h.relRoot;
      if (root === '' || root === '.') continue;
      if (rel === root || rel.startsWith(root + '/')) {
        assigned = h;
        break;
      }
    }
    fileToHit.set(f.id, assigned);
  }

  // Build boundary list (only include hits that own at least one file).
  const boundariesByRoot = new Map<string, BoundaryDef & { _index: number }>();
  const definitions: BoundaryDef[] = [];
  let nextIndex = 0;
  for (const h of sortedHits) {
    const def: BoundaryDef = {
      label: h.label, kind: h.kind, rootRelPath: h.relRoot,
      manifestPath: h.manifestPath || null, ecosystem: h.ecosystem,
      fileIds: [],
    };
    boundariesByRoot.set(h.relRoot, { ...def, _index: nextIndex });
    nextIndex++;
  }
  for (const [fileId, hit] of fileToHit) {
    if (!hit) continue;
    const b = boundariesByRoot.get(hit.relRoot);
    if (!b) continue;
    b.fileIds.push(fileId);
  }
  // Drop empty boundaries (e.g. convention `services/` parent with no files).
  for (const b of boundariesByRoot.values()) {
    if (b.fileIds.length === 0) continue;
    definitions.push({
      label: b.label, kind: b.kind, rootRelPath: b.rootRelPath,
      manifestPath: b.manifestPath, ecosystem: b.ecosystem, fileIds: b.fileIds,
    });
  }
  // Re-index after dropping.
  const indexByRoot = new Map<string, number>();
  definitions.forEach((d, i) => indexByRoot.set(d.rootRelPath, i));

  // Build boundary→boundary edges from the resolved file-call / file-import /
  // service-link graphs.
  const edges = aggregateBoundaryEdges(store, fileToHit, indexByRoot);

  let orphan = 0;
  for (const [_id, h] of fileToHit) if (!h) orphan++;

  return { boundaries: definitions, edges, orphanFiles: orphan };
}

function rank(h: ManifestHit): number {
  // Manifest > convention.
  return h.kind === 'convention' ? 0 : 1;
}

function aggregateBoundaryEdges(
  store: Store,
  fileToHit: Map<number, ManifestHit | null>,
  indexByRoot: Map<string, number>,
): BoundaryEdgeDef[] {
  const buckets = new Map<string, BoundaryEdgeDef>();
  const lookup = (fileId: number): number | null => {
    const h = fileToHit.get(fileId) ?? null;
    if (!h) return null;
    const idx = indexByRoot.get(h.relRoot);
    return idx == null ? null : idx;
  };
  const push = (from: number, to: number, kind: BoundaryEdgeDef['kind'], weight: number): void => {
    if (from === to) return;
    const key = `${from}|${to}|${kind}`;
    const existing = buckets.get(key);
    if (existing) existing.weight += weight;
    else buckets.set(key, { fromIndex: from, toIndex: to, kind, weight });
  };
  for (const e of store.fileCallEdgeWeights()) {
    const a = lookup(e.from); const b = lookup(e.to);
    if (a != null && b != null) push(a, b, 'call', e.weight);
  }
  for (const e of store.fileImportEdgeWeights()) {
    const a = lookup(e.from); const b = lookup(e.to);
    if (a != null && b != null) push(a, b, 'import', e.weight);
  }
  try {
    for (const e of store.fileServiceLinkEdgeWeights()) {
      const a = lookup(e.from); const b = lookup(e.to);
      if (a != null && b != null) push(a, b, 'service', e.weight);
    }
  } catch { /* */ }
  return Array.from(buckets.values()).sort((a, b) =>
    a.fromIndex - b.fromIndex || a.toIndex - b.toIndex || (a.kind < b.kind ? -1 : 1));
}

// ── Manifest discovery ──────────────────────────────────────────────────

function discoverManifests(absRoot: string): ManifestHit[] {
  const hits: ManifestHit[] = [];
  // Skip dirs that never own boundaries.
  const SKIP = new Set([
    'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt',
    'target', 'obj', '.gradle', '__pycache__', '.cache', '.idea',
    '.vs', '.seer',
  ]);

  function walk(absDir: string, relDir: string, depth: number): void {
    if (depth > 6) return; // bound recursion — boundaries beyond ~6 levels are rare
    let entries: string[];
    try { entries = fs.readdirSync(absDir); }
    catch { return; }
    const fileSet = new Set(entries);
    let claimed = false;

    // package.json — may declare workspaces.
    if (fileSet.has('package.json')) {
      const manifestRel = relDir === '' ? 'package.json' : `${relDir}/package.json`;
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(absDir, 'package.json'), 'utf8'));
        const label = derivePackageName(pkg, relDir);
        const isRoot = Array.isArray(pkg.workspaces) || (pkg.workspaces && Array.isArray(pkg.workspaces.packages));
        hits.push({
          relRoot: relDir,
          manifestPath: manifestRel,
          label,
          kind: isRoot ? 'workspace-root' : 'package',
          ecosystem: 'npm',
        });
        claimed = true;
      } catch { /* */ }
    }
    // pyproject.toml
    if (fileSet.has('pyproject.toml')) {
      const manifestRel = relDir === '' ? 'pyproject.toml' : `${relDir}/pyproject.toml`;
      hits.push({
        relRoot: relDir,
        manifestPath: manifestRel,
        label: derivePyProjectLabel(absDir, relDir),
        kind: 'package',
        ecosystem: 'pypi',
      });
      claimed = true;
    }
    // Cargo.toml
    if (fileSet.has('Cargo.toml')) {
      const manifestRel = relDir === '' ? 'Cargo.toml' : `${relDir}/Cargo.toml`;
      hits.push({
        relRoot: relDir,
        manifestPath: manifestRel,
        label: deriveCargoLabel(absDir, relDir),
        kind: 'package',
        ecosystem: 'cargo',
      });
      claimed = true;
    }
    // go.mod
    if (fileSet.has('go.mod')) {
      const manifestRel = relDir === '' ? 'go.mod' : `${relDir}/go.mod`;
      hits.push({
        relRoot: relDir,
        manifestPath: manifestRel,
        label: deriveGoModuleLabel(absDir, relDir),
        kind: 'package',
        ecosystem: 'go',
      });
      claimed = true;
    }
    // composer.json
    if (fileSet.has('composer.json')) {
      const manifestRel = relDir === '' ? 'composer.json' : `${relDir}/composer.json`;
      hits.push({
        relRoot: relDir,
        manifestPath: manifestRel,
        label: path.basename(relDir || '.'),
        kind: 'package',
        ecosystem: 'composer',
      });
      claimed = true;
    }
    void claimed;

    // Recurse into subdirectories. Always recurse if THIS level didn't
    // declare a non-root package — that's how packages/<x> work — but DO
    // recurse anyway through workspace-root or convention dirs.
    for (const entry of entries) {
      if (SKIP.has(entry)) continue;
      const abs = path.join(absDir, entry);
      let st: fs.Stats;
      try { st = fs.statSync(abs); }
      catch { continue; }
      if (!st.isDirectory()) continue;
      const sub = relDir === '' ? entry : `${relDir}/${entry}`;
      walk(abs, sub, depth + 1);
    }
  }

  walk(absRoot, '', 0);
  return hits;
}

function seedConventionRoots(absRoot: string, hits: ManifestHit[]): void {
  // For each <conventionDir>/<sub>/ that exists and isn't already a manifest
  // root, register a fallback boundary so services/* / packages/* still get
  // surfaced even without a manifest.
  const conventionDirs: Array<{ dir: string; kind: BoundaryDef['kind'] }> = [
    { dir: 'services', kind: 'service' },
    { dir: 'packages', kind: 'package' },
    { dir: 'apps',     kind: 'app' },
    { dir: 'libs',     kind: 'lib' },
  ];
  const existingRoots = new Set(hits.map(h => h.relRoot));
  for (const c of conventionDirs) {
    const abs = path.join(absRoot, c.dir);
    if (!fs.existsSync(abs)) continue;
    let entries: string[];
    try { entries = fs.readdirSync(abs); }
    catch { continue; }
    for (const e of entries) {
      const subAbs = path.join(abs, e);
      try {
        if (!fs.statSync(subAbs).isDirectory()) continue;
      } catch { continue; }
      const rel = `${c.dir}/${e}`;
      if (existingRoots.has(rel)) continue;
      hits.push({
        relRoot: rel,
        manifestPath: '',
        label: e,
        kind: c.kind,
        ecosystem: null,
      });
    }
  }
}

function derivePackageName(pkg: any, relDir: string): string {
  const name = (pkg && pkg.name && typeof pkg.name === 'string') ? pkg.name : null;
  if (!name) return path.basename(relDir || '.');
  // Strip @scope/
  const m = /^@[^/]+\/(.+)$/.exec(name);
  return m ? m[1] : name;
}

function derivePyProjectLabel(absDir: string, relDir: string): string {
  try {
    const text = fs.readFileSync(path.join(absDir, 'pyproject.toml'), 'utf8');
    const m = /^\s*name\s*=\s*['"]([^'"]+)['"]/m.exec(text);
    if (m) return m[1];
  } catch { /* */ }
  return path.basename(relDir || '.');
}

function deriveCargoLabel(absDir: string, relDir: string): string {
  try {
    const text = fs.readFileSync(path.join(absDir, 'Cargo.toml'), 'utf8');
    // Capture [package].name; skip [workspace] sections.
    const pkgSection = /^\s*\[package\][\s\S]*?(?=^\s*\[)/m.exec(text)?.[0] ?? text;
    const m = /^\s*name\s*=\s*['"]([^'"]+)['"]/m.exec(pkgSection);
    if (m) return m[1];
  } catch { /* */ }
  return path.basename(relDir || '.');
}

function deriveGoModuleLabel(absDir: string, relDir: string): string {
  try {
    const text = fs.readFileSync(path.join(absDir, 'go.mod'), 'utf8');
    const m = /^\s*module\s+([^\s]+)/m.exec(text);
    if (m) {
      // Take the last path segment.
      return path.basename(m[1]);
    }
  } catch { /* */ }
  return path.basename(relDir || '.');
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}
