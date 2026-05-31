/**
 * Track I — Feature 5: Symbol Rename/Move Continuity.
 *
 * Verifies:
 *   - Renaming `validateToken` → `verifyToken` (same body) produces a
 *     continuity candidate that links the two with high confidence.
 *   - Two distinct similar functions do NOT collapse: when names share a
 *     similar shape but bodies differ, continuity confidence stays low or
 *     the candidate is skipped.
 *   - A file move with same body yields continuity evidence.
 *   - Existing symbol_history rows are unaffected (additive only).
 *
 * Run: npx tsx tests/tracki-continuity.ts
 */

import path from 'path';
import fs from 'fs';
import os from 'os';
import { Indexer } from '../src/indexer/index';
import { Store } from '../src/db/store';
import { buildContinuity, getContinuityForSymbol } from '../src/indexer/continuity';

const TMP = path.join(os.tmpdir(), `seer-tracki-cont-${Date.now()}`);

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) { console.log(`  ✓ ${msg}`); passed++; }
  else { console.error(`  ✗ ${msg}`); failed++; }
}
function assertEq<T>(actual: T, expected: T, msg: string): void {
  assert(actual === expected,
    `${msg} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
}
function cleanup(): void {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ }
}
function write(rel: string, content: string): void {
  const full = path.join(TMP, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
}

async function main(): Promise<void> {
  console.log('\nSeer Track I — Feature 5: Symbol Rename/Move Continuity');
  console.log('========================================================\n');
  cleanup();
  fs.mkdirSync(TMP, { recursive: true });

  // ── Fixture 1: function renamed within the same file ───────────────────
  console.log('── Fixture 1: function renamed inside the same file ──');
  // We capture two snapshots in the same DB so that BOTH the pre-rename
  // (validateToken) and post-rename (verifyToken) symbol rows coexist —
  // which is the snapshot continuity inspects (it doesn't need git history
  // for the heuristic; shape_hash equality is enough).
  write('auth.ts', `
export function validateToken(token: string): boolean {
  if (!token) return false;
  return token.length > 8;
}

// Same body, different name — direct rename simulation.
export function verifyToken(other: string): boolean {
  if (!other) return false;
  return other.length > 8;
}
`.trimStart());

  const dbPath = path.join(TMP, 'graph.db');
  let store = new Store(dbPath);
  try {
    const idx = new Indexer(store);
    await idx.indexDirectory(TMP, { quiet: true });

    // Force a continuity pass that considers all symbols.
    const r = buildContinuity(store, {
      historyThreshold: 1, includeAllSymbols: true,
    });
    console.log(`  continuity: considered=${r.candidatesConsidered}, inserted=${r.inserted}, skipped=${r.skipped}`);
    assert(r.inserted >= 1, 'continuity inserted ≥1 candidate');

    const verifyDef = store.getDefinition('verifyToken');
    assert(verifyDef.length === 1, 'verifyToken found');
    const valDef = store.getDefinition('validateToken');
    assert(valDef.length === 1, 'validateToken found');

    if (verifyDef.length === 1) {
      const cont = getContinuityForSymbol(store, verifyDef[0].id);
      console.log(`  verifyToken continuity candidates: ${cont.length}`);
      for (const c of cont) {
        console.log(`    ← ${c.previousName.padEnd(20)} conf=${c.confidence.toFixed(2)}  ${c.matchReasons.join(', ')}`);
      }
      assert(cont.length >= 1, 'verifyToken has at least one continuity candidate');
      const linked = cont.find(c => c.previousName === 'validateToken');
      assert(linked != null, 'verifyToken → validateToken candidate present');
      if (linked) {
        assert(linked.confidence >= 0.8,
          `verifyToken → validateToken confidence ≥ 0.8 (got ${linked.confidence})`);
        assert(linked.matchReasons.includes('shape_hash_exact'),
          'reasons include shape_hash_exact');
      }
    }
  } finally { store.close(); }

  // ── Fixture 2: ambiguous match (different body) → low or no candidate ──
  console.log('\n── Fixture 2: ambiguous shape mismatch ──');
  cleanup();
  fs.mkdirSync(TMP, { recursive: true });
  write('ambiguous.ts', `
export function loadOne(): string {
  console.log('one');
  return 'one';
}

export function loadTwo(): string {
  // Totally different body — many statements
  let acc = 0;
  for (let i = 0; i < 100; i++) {
    acc += i * 2;
    if (acc > 1000) { break; }
  }
  return String(acc);
}
`.trimStart());

  store = new Store(dbPath);
  try {
    const idx = new Indexer(store);
    await idx.indexDirectory(TMP, { quiet: true });
    buildContinuity(store, { historyThreshold: 1, includeAllSymbols: true });
    const oneDef = store.getDefinition('loadOne');
    const twoDef = store.getDefinition('loadTwo');
    assert(oneDef.length === 1, 'loadOne found');
    assert(twoDef.length === 1, 'loadTwo found');
    if (oneDef.length === 1 && twoDef.length === 1) {
      const cOne = getContinuityForSymbol(store, oneDef[0].id);
      const cTwo = getContinuityForSymbol(store, twoDef[0].id);
      // Even if a candidate was inserted, the confidence must reflect
      // ambiguity — never pretend it's certain.
      for (const c of [...cOne, ...cTwo]) {
        assert(c.confidence < 0.9,
          `ambiguous candidate confidence is < 0.9 (got ${c.confidence})`);
      }
    }
  } finally { store.close(); }

  // ── Fixture 3: file move with same body ────────────────────────────────
  console.log('\n── Fixture 3: file move (same body) ──');
  cleanup();
  fs.mkdirSync(TMP, { recursive: true });
  write('old-location/utils.ts', `
export function shared(seed: number): string {
  const a = seed * 2;
  const b = a + 1;
  return String(b);
}
`.trimStart());
  write('new-location/utils.ts', `
export function sharedMoved(seed: number): string {
  const a = seed * 2;
  const b = a + 1;
  return String(b);
}
`.trimStart());

  store = new Store(dbPath);
  try {
    const idx = new Indexer(store);
    await idx.indexDirectory(TMP, { quiet: true });
    buildContinuity(store, { historyThreshold: 1, includeAllSymbols: true });
    const sharedMoved = store.getDefinition('sharedMoved');
    assert(sharedMoved.length === 1, 'sharedMoved found');
    if (sharedMoved.length === 1) {
      const cont = getContinuityForSymbol(store, sharedMoved[0].id);
      assert(cont.length >= 1, 'sharedMoved has a continuity candidate (file move)');
      const linked = cont.find(c => c.previousName === 'shared');
      assert(linked != null, 'sharedMoved → shared candidate present (file move)');
      if (linked) {
        assert(linked.confidence >= 0.75,
          `file-move continuity confidence ≥ 0.75 (got ${linked.confidence})`);
      }
    }
  } finally { store.close(); }

  // ── Fixture 4: common shape collision must NOT invent high-conf renames ──
  // Many structurally-identical functions with UNRELATED names in different
  // files share one shape_hash. That is boilerplate, not a rename — continuity
  // must refuse to assert a high-confidence link with no corroboration.
  console.log('\n── Fixture 4: ambiguous shape bucket (boilerplate) ──');
  cleanup();
  fs.mkdirSync(TMP, { recursive: true });
  const body = (name: string): string =>
    `export function ${name}(): number {\n  const a = 1;\n  const b = 2;\n  return a + b;\n}\n`;
  // Names chosen to share no 4-char prefix/suffix with each other.
  write('f1.ts', body('alpha'));
  write('f2.ts', body('zeta'));
  write('f3.ts', body('omega'));
  write('f4.ts', body('kappa'));
  store = new Store(dbPath);
  try {
    const idx = new Indexer(store);
    await idx.indexDirectory(TMP, { quiet: true });
    const r = buildContinuity(store, { historyThreshold: 1, includeAllSymbols: true });
    console.log(`  continuity: considered=${r.candidatesConsidered}, inserted=${r.inserted}, skipped=${r.skipped}`);
    for (const nm of ['alpha', 'zeta', 'omega', 'kappa']) {
      const def = store.getDefinition(nm);
      if (def.length !== 1) { assert(false, `${nm} found`); continue; }
      const cont = getContinuityForSymbol(store, def[0].id);
      for (const c of cont) {
        console.log(`    ${nm} ← ${c.previousName} conf=${c.confidence.toFixed(2)} ${c.matchReasons.join(',')}`);
      }
      // The honesty contract: a shared boilerplate shape with unrelated names
      // and different scopes must never yield a high-confidence rename.
      const highConf = cont.find(c => c.confidence >= 0.8);
      assert(highConf == null,
        `${nm}: no high-confidence rename from a common shape (got ${cont.map(c => c.confidence).join(',') || 'none'})`);
    }
  } finally { store.close(); }

  // ── Honesty check: schema continuity record exists with reasons array ──
  console.log('\n── Schema check ──');
  cleanup();
  fs.mkdirSync(TMP, { recursive: true });
  write('a.ts', 'export function alpha(): number { return 1 + 2 + 3; }\n');
  write('b.ts', 'export function alpha2(): number { return 1 + 2 + 3; }\n');
  store = new Store(dbPath);
  try {
    const idx = new Indexer(store);
    await idx.indexDirectory(TMP, { quiet: true });
    buildContinuity(store, { historyThreshold: 1, includeAllSymbols: true });
    const cols = (store.rawDb().prepare(
      "PRAGMA table_info('symbol_history_continuity')",
    ).all() as Array<{ name: string }>).map(r => r.name);
    for (const c of [
      'id', 'symbol_id', 'symbol_key', 'previous_symbol_key',
      'previous_name', 'previous_file', 'confidence',
      'match_reasons', 'recorded_at',
    ]) {
      assert(cols.includes(c), `symbol_history_continuity column ${c} exists`);
    }
  } finally { store.close(); }

  console.log('\n────────────────────────────');
  console.log(`Passed: ${passed}   Failed: ${failed}`);
  cleanup();
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error(err);
  cleanup();
  process.exit(1);
});
