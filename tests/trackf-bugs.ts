/**
 * Track F bug regression tests — pins fixes for the five issues caught in
 * the post-Track-F audit:
 *
 *   1. (HIGH) SCIP imports were not layer-additive. `clearScipProvenance(path)`
 *      globally wiped every SCIP row regardless of path, so importing two
 *      different SCIP files left only the last one's rows behind even though
 *      the scip_imports table listed both. Fix: scope the wipe by
 *      `scip_import_id` (v7.1 column on symbols + edges).
 *
 *   2. (MEDIUM) Cached/migrated DBs skipped the shape-hash backfill. The
 *      indexer ran `buildShapeHashes` only when `graphChanged` was true, but
 *      a v6→v7 migration leaves every file's content unchanged so the cached
 *      branch fired and shape hashes stayed NULL forever. Fix: also run when
 *      the store reports `hasMissingShapeHashes()`.
 *
 *   3. (MEDIUM) Bundle import did not enforce schema compatibility. Fix:
 *      reject manifests whose schemaVersion exceeds CURRENT_SCHEMA_VERSION.
 *
 *   4. (MEDIUM) MCP bundle import ignored the server's custom --db, always
 *      landing the bundle at <workspace>/.seer/graph.db. (Verified by code
 *      reading; pinned by a unit-style test below that exercises the same
 *      code path the MCP tool uses.)
 *
 *   5. (LOW) Bundle bytes were not deterministic — `builtAt = Date.now()`.
 *      Fix: allow callers to pin builtAt via options.builtAt.
 *
 * Run: npx tsx tests/trackf-bugs.ts
 */

import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import { Indexer } from '../src/indexer/index';
import { Store } from '../src/db/store';
import { CURRENT_SCHEMA_VERSION } from '../src/db/schema';
import { importScip } from '../src/scip/import';
import { exportBundle } from '../src/bundle/export';
import { importBundle, readBundleManifest } from '../src/bundle/import';

const FIX = path.join(__dirname, 'fixtures-trackf');
const TMP_DIR = path.join(os.tmpdir(), `seer-trackf-bugs-${Date.now()}`);

let passed = 0;
let failed = 0;
function safeStr(v: unknown): string {
  if (typeof v === 'bigint') return `0x${v.toString(16)}`;
  try { return JSON.stringify(v); }
  catch { return String(v); }
}
function assert(cond: boolean, msg: string): void {
  if (cond) { console.log(`  ✓ ${msg}`); passed++; }
  else { console.error(`  ✗ ${msg}`); failed++; }
}
function assertEq<T>(actual: T, expected: T, msg: string): void {
  assert(actual === expected, `${msg} (got ${safeStr(actual)}, expected ${safeStr(expected)})`);
}

function cleanup(): void {
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* */ }
}

async function freshlyIndexed(dbPath: string): Promise<void> {
  const s = new Store(dbPath);
  await new Indexer(s).indexDirectory(FIX, { quiet: true });
  s.close();
}

async function main(): Promise<void> {
  console.log('\nSeer Track F — Bug Regression Tests');
  console.log('=====================================\n');
  fs.mkdirSync(TMP_DIR, { recursive: true });

  // ── Bug 1 (HIGH): per-layer SCIP wipe ─────────────────────────────────
  console.log('── Bug 1: SCIP layer additivity ──');
  {
    const dbPath = path.join(TMP_DIR, 'bug1.db');
    await freshlyIndexed(dbPath);
    const store = new Store(dbPath);
    try {
      // Two SCIP layers, each contributing one SCIP-pure symbol in different
      // (non-overlapping) line ranges so neither merges with tree-sitter
      // rows. Both target the same file because that's the only file we
      // index for the fixture — what matters for the test is that the two
      // imports have different paths so they're tracked as separate layers.
      const layerA = {
        tool: 'layer-a/1.0',
        documents: [{
          relativePath: 'src/auth.ts',
          symbols: [{
            symbolId: 'a#alphaOnly', displayName: 'alphaOnly', kind: 'function',
            relativePath: 'src/auth.ts',
            range: { startLine: 50, startCharacter: 0, endLine: 52, endCharacter: 1 },
          }],
          occurrences: [],
        }],
      };
      const layerB = {
        tool: 'layer-b/1.0',
        documents: [{
          relativePath: 'src/auth.ts',
          symbols: [{
            symbolId: 'b#betaOnly', displayName: 'betaOnly', kind: 'function',
            relativePath: 'src/auth.ts',
            range: { startLine: 60, startCharacter: 0, endLine: 62, endCharacter: 1 },
          }],
          occurrences: [],
        }],
      };
      const aPath = path.join(TMP_DIR, 'a.scip.json');
      const bPath = path.join(TMP_DIR, 'b.scip.json');
      fs.writeFileSync(aPath, JSON.stringify(layerA));
      fs.writeFileSync(bPath, JSON.stringify(layerB));

      // Import layer A.
      await importScip(aPath, store, { repoRoot: FIX });
      const afterA = store.getProvenanceCounts();
      assertEq(afterA.symbols.scip, 1, 'after A: 1 SCIP symbol');
      assertEq(store.listScipImports().length, 1, 'after A: 1 scip_imports row');

      // Import layer B — should be ADDITIVE.
      await importScip(bPath, store, { repoRoot: FIX });
      const afterB = store.getProvenanceCounts();
      assertEq(afterB.symbols.scip, 2,
        'after B: 2 SCIP symbols (layer A row survived layer B import)');
      assertEq(store.listScipImports().length, 2, 'after B: 2 scip_imports rows');

      // Each SCIP row should be linked to the correct scip_imports.id.
      const scipRows = store.rawDb().prepare(`
        SELECT s.name, s.scip_import_id, si.tool
        FROM symbols s
        JOIN scip_imports si ON si.id = s.scip_import_id
        WHERE s.provenance = 'scip'
        ORDER BY s.name
      `).all() as Array<{ name: string; tool: string }>;
      assertEq(scipRows.length, 2, 'both SCIP-pure rows linked to their importer');
      assert(scipRows.some(r => r.name === 'alphaOnly' && r.tool === 'layer-a/1.0'),
        'alphaOnly linked to layer-a');
      assert(scipRows.some(r => r.name === 'betaOnly' && r.tool === 'layer-b/1.0'),
        'betaOnly linked to layer-b');

      // Clearing layer A by path should leave layer B intact.
      const cleared = store.clearScipProvenance(aPath);
      assert(cleared >= 1, 'clearScipProvenance(aPath) removed at least one row');
      const afterClearA = store.getProvenanceCounts();
      assertEq(afterClearA.symbols.scip, 1,
        'after clear(a): exactly layer B remains');
      const remaining = store.listScipImports();
      assertEq(remaining.length, 1, 'after clear(a): 1 scip_imports row left');
      assertEq(remaining[0].tool, 'layer-b/1.0',
        'after clear(a): layer-b is the survivor');

      // Re-import A — additive again.
      await importScip(aPath, store, { repoRoot: FIX });
      assertEq(store.getProvenanceCounts().symbols.scip, 2,
        'after re-import(a): both layers back');

      // Global wipe (no path) clears everything.
      store.clearScipProvenance();
      const afterGlobal = store.getProvenanceCounts();
      assertEq(afterGlobal.symbols.scip, 0, 'global clear: zero SCIP-pure symbols');
      assertEq(store.listScipImports().length, 0, 'global clear: scip_imports empty');
    } finally { store.close(); }
  }

  // ── Bug 1 follow-up: per-layer wipe preserves scip-merge from sibling ─
  console.log('\n── Bug 1: scip-merge survives sibling layer wipe ──');
  {
    const dbPath = path.join(TMP_DIR, 'bug1-merge.db');
    await freshlyIndexed(dbPath);
    const store = new Store(dbPath);
    try {
      // Layer X merges with a tree-sitter row; layer Y adds a fresh SCIP row.
      // Clearing Y must NOT demote X's scip-merge.
      const layerX = {
        tool: 'x', documents: [{
          relativePath: 'src/auth.ts',
          symbols: [{
            symbolId: 'x#login', displayName: 'login', qualifiedName: 'AuthService.login',
            kind: 'method', relativePath: 'src/auth.ts',
            range: { startLine: 3, startCharacter: 0, endLine: 6, endCharacter: 1 },
          }],
          occurrences: [],
        }],
      };
      const layerY = {
        tool: 'y', documents: [{
          relativePath: 'src/auth.ts',
          symbols: [{
            symbolId: 'y#fresh', displayName: 'freshHelper', kind: 'function',
            relativePath: 'src/auth.ts',
            range: { startLine: 70, startCharacter: 0, endLine: 72, endCharacter: 1 },
          }],
          occurrences: [],
        }],
      };
      const xPath = path.join(TMP_DIR, 'x.scip.json');
      const yPath = path.join(TMP_DIR, 'y.scip.json');
      fs.writeFileSync(xPath, JSON.stringify(layerX));
      fs.writeFileSync(yPath, JSON.stringify(layerY));
      await importScip(xPath, store, { repoRoot: FIX });
      await importScip(yPath, store, { repoRoot: FIX });
      assertEq(store.getProvenanceCounts().symbols['scip-merge'], 1,
        'pre-clear: 1 scip-merge row');
      assertEq(store.getProvenanceCounts().symbols.scip, 1,
        'pre-clear: 1 SCIP-pure row');

      store.clearScipProvenance(yPath);
      const after = store.getProvenanceCounts();
      assertEq(after.symbols['scip-merge'], 1,
        'after clear(y): layer X scip-merge survives');
      assertEq(after.symbols.scip, 0,
        'after clear(y): layer Y SCIP-pure rows gone');
    } finally { store.close(); }
  }

  // ── Bug 2: shape-hash backfill on cached/migrated re-index ───────────
  console.log('\n── Bug 2: shape-hash backfill on cached re-index ──');
  {
    const dbPath = path.join(TMP_DIR, 'bug2.db');
    await freshlyIndexed(dbPath);
    // Simulate the post-migration state: every shape_hash is NULL but the
    // file content hashes still match the indexer's view, so every file
    // would land in the "cached" path on re-index.
    const s1 = new Store(dbPath);
    s1.rawDb().exec('UPDATE symbols SET shape_hash = NULL');
    const preWipe = s1.getStats();
    assertEq(preWipe.shapeHashed ?? -1, 0, 'manually cleared: shapeHashed=0');
    s1.close();

    // Re-run the indexer — every file should be cached, no new files indexed.
    const s2 = new Store(dbPath);
    const r = await new Indexer(s2).indexDirectory(FIX, { quiet: true });
    assertEq(r.filesIndexed, 0,
      'all files cached (graphChanged=false: filesIndexed=0)');
    assert((r.shapeHashesAdded ?? 0) >= 3,
      `backfill ran even on cached re-index (shapeHashesAdded=${r.shapeHashesAdded})`);
    assert((s2.getStats().shapeHashed ?? 0) >= 3,
      `shape_hashed count restored (got ${s2.getStats().shapeHashed})`);

    // Now a second re-run with hashes already in place skips the backfill
    // (still graphChanged=false, but hasMissingShapeHashes()=false).
    const r2 = await new Indexer(s2).indexDirectory(FIX, { quiet: true });
    assertEq(r2.shapeHashesAdded ?? -1, 0,
      'second re-run skips backfill (already complete)');
    s2.close();
  }

  // ── Bug 3: bundle import enforces schema compatibility ───────────────
  console.log('\n── Bug 3: bundle schema compat check ──');
  {
    const dbPath = path.join(TMP_DIR, 'bug3.db');
    await freshlyIndexed(dbPath);
    const out = path.join(TMP_DIR, 'bug3.bundle');
    await exportBundle(dbPath, FIX, { out });

    // Tamper the manifest to claim schemaVersion=999. Format-version is
    // intentionally left at 1 so the format check (which we DID have) still
    // passes — only the schema-version gate stops this import.
    const buf = fs.readFileSync(out);
    const mLen = buf.readUInt32BE(8);
    const manifest = JSON.parse(buf.slice(12, 12 + mLen).toString('utf-8'));
    manifest.schemaVersion = 999;
    // Re-hash the DB so dbSha256 stays correct; that's not what we're testing.
    const newManifest = Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8');
    const tampered = Buffer.concat([
      buf.slice(0, 8),
      Buffer.alloc(4),
      newManifest,
      buf.slice(12 + mLen),
    ]);
    tampered.writeUInt32BE(newManifest.length, 8);
    const tamperPath = path.join(TMP_DIR, 'bug3-tampered.bundle');
    fs.writeFileSync(tamperPath, tampered);

    let threw = false;
    let msg = '';
    try {
      await importBundle(tamperPath, {
        repoRoot: FIX, dbOut: path.join(TMP_DIR, 'bug3-out.db'),
      });
    } catch (err) {
      msg = (err as Error).message;
      threw = msg.includes('schemaVersion') && msg.includes('newer');
    }
    assert(threw, `import refuses bundle with schemaVersion > CURRENT (msg: ${msg})`);

    // Bundles with valid (≤ CURRENT) schemaVersion still import.
    const validPath = path.join(TMP_DIR, 'bug3-valid.bundle');
    fs.copyFileSync(out, validPath);
    const ok = await importBundle(validPath, {
      repoRoot: FIX, dbOut: path.join(TMP_DIR, 'bug3-ok.db'),
    });
    assertEq(ok.manifest.schemaVersion, CURRENT_SCHEMA_VERSION,
      'untampered bundle imports cleanly');

    // Negative schemaVersion is rejected.
    const manifest2 = { ...manifest, schemaVersion: 0 };
    const newManifest2 = Buffer.from(JSON.stringify(manifest2, null, 2), 'utf-8');
    const tampered2 = Buffer.concat([
      buf.slice(0, 8),
      Buffer.alloc(4),
      newManifest2,
      buf.slice(12 + mLen),
    ]);
    tampered2.writeUInt32BE(newManifest2.length, 8);
    const zeroPath = path.join(TMP_DIR, 'bug3-zero.bundle');
    fs.writeFileSync(zeroPath, tampered2);
    let zeroThrew = false;
    try {
      await importBundle(zeroPath, {
        repoRoot: FIX, dbOut: path.join(TMP_DIR, 'bug3-zero-out.db'),
      });
    } catch (err) {
      zeroThrew = (err as Error).message.includes('invalid schemaVersion');
    }
    assert(zeroThrew, 'bundle with schemaVersion=0 is rejected');

    // skipSchemaCheck lets the user opt out.
    const opted = await importBundle(tamperPath, {
      repoRoot: FIX, dbOut: path.join(TMP_DIR, 'bug3-opt.db'),
      skipSchemaCheck: true,
    });
    assertEq(opted.manifest.schemaVersion, 999,
      'skipSchemaCheck=true lets the bogus version through (for forensics)');
  }

  // ── Bug 4: bundle import lands at the requested dbOut ────────────────
  // This pins the unit-level contract the MCP fix relies on: importBundle()
  // must write to options.dbOut when supplied, never to a default. The MCP
  // server now always supplies this.dbPath, which is what's broken pre-fix.
  console.log('\n── Bug 4: bundle import respects custom dbOut ──');
  {
    const dbPath = path.join(TMP_DIR, 'bug4.db');
    await freshlyIndexed(dbPath);
    const bundlePath = path.join(TMP_DIR, 'bug4.bundle');
    await exportBundle(dbPath, FIX, { out: bundlePath });

    // Land the bundle at a non-default path inside a fresh "workspace".
    const fakeWorkspace = path.join(TMP_DIR, 'fake-ws');
    fs.mkdirSync(fakeWorkspace, { recursive: true });
    const customDb = path.join(TMP_DIR, 'custom-elsewhere.db');
    const r = await importBundle(bundlePath, {
      repoRoot: fakeWorkspace, dbOut: customDb,
    });
    assertEq(r.dbPath, customDb, 'importBundle writes to options.dbOut');
    assert(fs.existsSync(customDb), 'custom dbOut file exists');
    // The default location must NOT have been touched.
    const defaultPath = path.join(fakeWorkspace, '.seer', 'graph.db');
    assert(!fs.existsSync(defaultPath),
      'default <repoRoot>/.seer/graph.db was NOT created when dbOut overrode it');
  }

  // ── Bug 5: deterministic bundle bytes with pinned builtAt ────────────
  console.log('\n── Bug 5: deterministic bundle bytes when builtAt is pinned ──');
  {
    const dbPath = path.join(TMP_DIR, 'bug5.db');
    await freshlyIndexed(dbPath);
    const fixedAt = 1_700_000_000_000;
    const out1 = path.join(TMP_DIR, 'bug5-a.bundle');
    const out2 = path.join(TMP_DIR, 'bug5-b.bundle');
    // Pin everything that can vary across runs.
    await exportBundle(dbPath, FIX, {
      out: out1, gitHead: 'fixedsha', gitBranch: 'main', builtAt: fixedAt,
    });
    // A small delay between exports — without builtAt override, this alone
    // produced different bytes pre-fix.
    await new Promise(r => setTimeout(r, 25));
    await exportBundle(dbPath, FIX, {
      out: out2, gitHead: 'fixedsha', gitBranch: 'main', builtAt: fixedAt,
    });
    const sha1 = crypto.createHash('sha256').update(fs.readFileSync(out1)).digest('hex');
    const sha2 = crypto.createHash('sha256').update(fs.readFileSync(out2)).digest('hex');
    assertEq(sha1, sha2,
      'two exports with pinned (gitHead, gitBranch, builtAt) produce identical bytes');

    // Sanity: omitting builtAt keeps the manifest mutable across calls (so
    // we don't accidentally make this property mandatory for normal use).
    const out3 = path.join(TMP_DIR, 'bug5-c.bundle');
    const out4 = path.join(TMP_DIR, 'bug5-d.bundle');
    await exportBundle(dbPath, FIX, { out: out3, gitHead: 'h', gitBranch: 'b' });
    await new Promise(r => setTimeout(r, 25));
    await exportBundle(dbPath, FIX, { out: out4, gitHead: 'h', gitBranch: 'b' });
    const m3 = readBundleManifest(out3);
    const m4 = readBundleManifest(out4);
    assert(m3.builtAt !== m4.builtAt,
      'without pin: builtAt differs across calls (Date.now() default preserved)');
  }

  cleanup();

  console.log(`\n══════════════════════════════════════════════════════════════`);
  console.log(`  Bug regressions: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error('\n  TRACK F BUG TESTS FAILED\n');
    process.exit(1);
  }
  console.log('\n  All Track F audit fixes pinned. ✓\n');
}

main().catch(err => {
  console.error('trackf-bugs crashed:', err);
  try { cleanup(); } catch { /* */ }
  process.exit(1);
});
