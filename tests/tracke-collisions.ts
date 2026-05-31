/**
 * Track E short-name collision regression tests.
 *
 * Confirms that seer_behavior 2.0, seer_risk, and seer_context only
 * consider the EXACT target symbol id when computing callers / callees /
 * direct test edges — never the share-the-short-name siblings.
 *
 * The class of bug this guards against: pre-fix, the Track E helpers
 * filtered edges by `to_name = target.name`, so `Alpha.run` and
 * `Beta.run` were treated as the same symbol despite the indexer
 * correctly resolving them to distinct ids. That meant a query for
 * `Beta.run` returned `testAlphaRun` AND `testBetaRun`, attributed
 * Alpha.run's callers/callees to Beta.run, and computed wrong risk.
 *
 * Run with: npx tsx tests/tracke-collisions.ts
 */

import path from 'path';
import fs from 'fs';
import os from 'os';
import { Indexer } from '../src/indexer/index';
import { Store } from '../src/db/store';
import { rankedBehavior } from '../src/indexer/behavior';
import { computeRisk } from '../src/indexer/risk';
import { buildContext } from '../src/indexer/context';

const FIX_DIR = path.join(os.tmpdir(), `seer-tracke-coll-fix-${Date.now()}`);
const TMP_DB = path.join(os.tmpdir(), `seer-tracke-coll-${Date.now()}.db`);

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) { console.log(`  ✓ ${msg}`); passed++; }
  else { console.error(`  ✗ ${msg}`); failed++; }
}
function assertEq<T>(actual: T, expected: T, msg: string): void {
  assert(actual === expected, `${msg} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
}

function writeFixture(): void {
  fs.mkdirSync(FIX_DIR, { recursive: true });
  fs.mkdirSync(path.join(FIX_DIR, 'src'), { recursive: true });
  fs.mkdirSync(path.join(FIX_DIR, 'tests'), { recursive: true });
  // Two classes that share short method names (`run`, `helper`). They live
  // in DIFFERENT files so the edge resolver — without type inference — can
  // still attribute callers correctly via same-file (for in-file callers)
  // and imported-file (for cross-file callers) resolution. This is the
  // scenario where the id-based Track E helpers prove their worth: even
  // when there are multiple `run` symbols across the DB, queries against a
  // specific id never collapse with the other id's edges.
  fs.writeFileSync(path.join(FIX_DIR, 'src', 'alpha.ts'), `
export class Alpha {
  run(): number {
    return this.helper() + 1;
  }
  helper(): number { return 11; }
}

export function alphaOnly(): number {
  const a = new Alpha();
  return a.run();
}
`);
  fs.writeFileSync(path.join(FIX_DIR, 'src', 'beta.ts'), `
export class Beta {
  run(): number {
    return this.helper() + 2;
  }
  helper(): number { return 22; }
}

export function betaOnly(): number {
  const b = new Beta();
  return b.run();
}
`);
  fs.writeFileSync(path.join(FIX_DIR, 'tests', 'alpha.test.ts'), `
import { Alpha } from '../src/alpha';

function testAlphaRun() {
  const a = new Alpha();
  expect(a.run()).toBe(12);
}

function expect(_v: unknown) {
  return { toBe(_e: unknown): void { /* */ } };
}
`);
  fs.writeFileSync(path.join(FIX_DIR, 'tests', 'beta.test.ts'), `
import { Beta } from '../src/beta';

function testBetaRun() {
  const b = new Beta();
  expect(b.run()).toBe(24);
}

function expect(_v: unknown) {
  return { toBe(_e: unknown): void { /* */ } };
}
`);
}

function cleanup(): void {
  try { fs.rmSync(FIX_DIR, { recursive: true, force: true }); } catch { /* */ }
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB);
  ['-wal', '-shm'].forEach(suf => { try { fs.unlinkSync(TMP_DB + suf); } catch { /* */ } });
}

async function main(): Promise<void> {
  console.log('\nSeer Track E — Short-Name Collision Regression');
  console.log('================================================\n');

  writeFixture();
  const store = new Store(TMP_DB);
  const indexer = new Indexer(store);
  console.log(`Indexing ${FIX_DIR}...`);
  const r = await indexer.indexDirectory(FIX_DIR, { quiet: true });
  console.log(`  files=${r.filesIndexed} symbols=${r.symbols} edges=${r.edges}\n`);

  // Resolve the two distinct `run` methods by qualified name.
  const runMatches = store.getDefinition('run');
  const alphaRun = runMatches.find(s => s.qualifiedName === 'Alpha.run');
  const betaRun = runMatches.find(s => s.qualifiedName === 'Beta.run');
  assert(alphaRun !== undefined, 'Alpha.run is indexed');
  assert(betaRun !== undefined, 'Beta.run is indexed');
  assert(alphaRun!.id !== betaRun!.id, 'Alpha.run and Beta.run have distinct symbol ids');

  // ── seer_behavior 2.0 — direct tests must be id-scoped ──────────────────
  console.log('\n── seer_behavior collision isolation ──');
  const behAlpha = rankedBehavior(store, alphaRun!.id, {
    limit: 50, includeNamingConvention: false, includeSameFile: false, indirectDepth: 0,
  });
  const behBeta = rankedBehavior(store, betaRun!.id, {
    limit: 50, includeNamingConvention: false, includeSameFile: false, indirectDepth: 0,
  });
  assert(behAlpha !== null && behBeta !== null, 'rankedBehavior returns a result for both');
  if (behAlpha && behBeta) {
    const alphaNames = behAlpha.tests.map(t => t.testSymbol.name).sort();
    const betaNames = behBeta.tests.map(t => t.testSymbol.name).sort();
    console.log(`  behavior(Alpha.run) direct: ${alphaNames.join(', ')}`);
    console.log(`  behavior(Beta.run)  direct: ${betaNames.join(', ')}`);
    // The whole point: each method has exactly ONE direct test, not both.
    assertEq(behAlpha.direct, 1, 'Alpha.run has exactly 1 direct test (not 2)');
    assertEq(behBeta.direct, 1, 'Beta.run has exactly 1 direct test (not 2)');
    assert(alphaNames.includes('testAlphaRun') && !alphaNames.includes('testBetaRun'),
      'Alpha.run\'s direct tests are only testAlphaRun');
    assert(betaNames.includes('testBetaRun') && !betaNames.includes('testAlphaRun'),
      'Beta.run\'s direct tests are only testBetaRun');
  }

  // ── seer_risk — directCallers must be id-scoped ─────────────────────────
  console.log('\n── seer_risk collision isolation ──');
  const riskAlpha = computeRisk(store, alphaRun!.id);
  const riskBeta = computeRisk(store, betaRun!.id);
  assert(riskAlpha !== null && riskBeta !== null, 'computeRisk returns a result for both');
  if (riskAlpha && riskBeta) {
    console.log(`  risk(Alpha.run): directCallers=${riskAlpha.signals.directCallers} directTests=${riskAlpha.signals.directTests}`);
    console.log(`  risk(Beta.run):  directCallers=${riskBeta.signals.directCallers} directTests=${riskBeta.signals.directTests}`);
    // Each run() has 2 direct callers: its in-file alphaOnly/betaOnly plus
    // the test (testAlphaRun / testBetaRun). NOT the combined 4 from both
    // short-name siblings — that's the bug we're guarding against.
    assertEq(riskAlpha.signals.directCallers, 2,
      'risk(Alpha.run).directCallers = 2 (alphaOnly + testAlphaRun) — not the cross-collapsed 4');
    assertEq(riskBeta.signals.directCallers, 2,
      'risk(Beta.run).directCallers = 2 (betaOnly + testBetaRun) — not the cross-collapsed 4');
    // directTests must also be id-scoped (1 each).
    assertEq(riskAlpha.signals.directTests, 1, 'risk(Alpha.run).directTests = 1');
    assertEq(riskBeta.signals.directTests, 1, 'risk(Beta.run).directTests = 1');
  }

  // ── seer_context — callers / callees / blast radius must be id-scoped ──
  console.log('\n── seer_context collision isolation ──');
  const ctxAlpha = buildContext(store, alphaRun!.id);
  const ctxBeta = buildContext(store, betaRun!.id);
  assert(ctxAlpha !== null && ctxBeta !== null, 'buildContext returns packets for both');
  if (ctxAlpha && ctxBeta) {
    console.log(`  context(Alpha.run): callers.total=${ctxAlpha.callers.total} callees.total=${ctxAlpha.callees.total} blast=${ctxAlpha.blastRadius.directCallers}+${ctxAlpha.blastRadius.transitiveCallers}`);
    console.log(`  context(Beta.run):  callers.total=${ctxBeta.callers.total} callees.total=${ctxBeta.callees.total} blast=${ctxBeta.blastRadius.directCallers}+${ctxBeta.blastRadius.transitiveCallers}`);
    // callers.total: 2 each (in-file caller + dedicated test).
    assertEq(ctxAlpha.callers.total, 2, 'context(Alpha.run).callers.total = 2');
    assertEq(ctxBeta.callers.total, 2, 'context(Beta.run).callers.total = 2');
    // callers.preview must point at the right callers — no cross-class
    // leakage. Alpha's callers must be {alphaOnly, testAlphaRun}; Beta's
    // must be {betaOnly, testBetaRun}.
    const alphaCallerNames = ctxAlpha.callers.preview.map(c => c.name).sort();
    const betaCallerNames = ctxBeta.callers.preview.map(c => c.name).sort();
    assert(alphaCallerNames.includes('alphaOnly') && alphaCallerNames.includes('testAlphaRun'),
      'context(Alpha.run).callers.preview includes alphaOnly + testAlphaRun');
    assert(!alphaCallerNames.includes('betaOnly') && !alphaCallerNames.includes('testBetaRun'),
      'context(Alpha.run).callers.preview EXCLUDES betaOnly + testBetaRun (no cross-leak)');
    assert(betaCallerNames.includes('betaOnly') && betaCallerNames.includes('testBetaRun'),
      'context(Beta.run).callers.preview includes betaOnly + testBetaRun');
    assert(!betaCallerNames.includes('alphaOnly') && !betaCallerNames.includes('testAlphaRun'),
      'context(Beta.run).callers.preview EXCLUDES alphaOnly + testAlphaRun (no cross-leak)');
    // callees: each run() calls only its own helper() — 1 each.
    assertEq(ctxAlpha.callees.total, 1, 'context(Alpha.run).callees.total = 1');
    assertEq(ctxBeta.callees.total, 1, 'context(Beta.run).callees.total = 1');
    // blastRadius.directCallers must equal callers.total.
    assertEq(ctxAlpha.blastRadius.directCallers, ctxAlpha.callers.total,
      'blastRadius.directCallers(Alpha.run) matches callers.total');
    assertEq(ctxBeta.blastRadius.directCallers, ctxBeta.callers.total,
      'blastRadius.directCallers(Beta.run) matches callers.total');
    // Behavior preview inside the packet: the DIRECT-CALL relationship
    // must be id-scoped (the bug we're closing). Naming-convention is a
    // deliberate signal — "testBetaRun" contains "Run" so it WILL appear
    // as a naming-convention match for Alpha.run too, at lower
    // specificity. That's expected; we just need to make sure the direct
    // edges don't collapse.
    const alphaDirectBeh = ctxAlpha.behavior.preview
      .filter(t => t.relationship === 'direct-call').map(t => t.name);
    const betaDirectBeh = ctxBeta.behavior.preview
      .filter(t => t.relationship === 'direct-call').map(t => t.name);
    assert(alphaDirectBeh.includes('testAlphaRun') && !alphaDirectBeh.includes('testBetaRun'),
      'context(Alpha.run).behavior direct-call slice is testAlphaRun only');
    assert(betaDirectBeh.includes('testBetaRun') && !betaDirectBeh.includes('testAlphaRun'),
      'context(Beta.run).behavior direct-call slice is testBetaRun only');
    // The top-ranked test (highest specificity) should be the direct match.
    assertEq(ctxAlpha.behavior.preview[0]?.name, 'testAlphaRun',
      'context(Alpha.run).behavior preview top-ranked = testAlphaRun (direct beats naming)');
    assertEq(ctxBeta.behavior.preview[0]?.name, 'testBetaRun',
      'context(Beta.run).behavior preview top-ranked = testBetaRun (direct beats naming)');
  }

  // Sanity: existing legacy name-based APIs are intentionally broad. They
  // KEEP counting every edge whose to_name = 'run' — Track E's id-based
  // fix is additive, not a behavior change for the legacy by-name path.
  // The fixture has 4 such call edges: alphaOnly→run, betaOnly→run,
  // testAlphaRun→run, testBetaRun→run.
  console.log('\n── Legacy name-based queries still broad ──');
  assertEq(store.countCallers('run'), 4,
    'countCallers(\'run\') still returns 4 edges (legacy broad short-name lookup unchanged)');
  // And id-based count is correctly scoped to one symbol.
  const alphaCount = store.countCallersById(alphaRun!.id);
  const betaCount = store.countCallersById(betaRun!.id);
  assertEq(alphaCount, 2, 'countCallersById(Alpha.run) = 2 (alphaOnly + testAlphaRun)');
  assertEq(betaCount, 2, 'countCallersById(Beta.run) = 2 (betaOnly + testBetaRun)');

  store.close();
  cleanup();

  console.log(`\n══════════════════════════════════════════════════════════════`);
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error('\n  TRACK E COLLISION TEST FAILED\n');
    process.exit(1);
  } else {
    console.log('\n  All Track E collision regressions pinned. ✓\n');
  }
}

main().catch(err => {
  console.error('tracke-collisions crashed:', err);
  try { cleanup(); } catch { /* */ }
  process.exit(1);
});
