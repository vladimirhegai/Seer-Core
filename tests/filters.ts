/**
 * Filter-default tests for Task 2.
 *
 * Verifies that:
 *   - Default search/ranking excludes test-file symbols, declarations, and
 *     (vacuously) type_refs.
 *   - Explicit includeTests=true / includeDeclarations=true / includeTypeRefs=true
 *     re-include them.
 *   - C/C++ class-body method declarations and free-function prototypes are
 *     stored with symbol_role='declaration', distinct from the body-bearing
 *     out-of-line definitions.
 *   - seer_behavior (test-edges) still works regardless of the test-file
 *     filter — the relationship table doesn't go through the file-role gate.
 *
 * Run with: npx tsx tests/filters.ts
 */

import path from 'path';
import os from 'os';
import fs from 'fs';
import { Indexer } from '../src/indexer/index';
import { Store } from '../src/db/store';

const FIXTURES = path.join(__dirname, 'fixtures');
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

/**
 * Build a temp fixture dir that combines the C/C++ sample (for declaration
 * tests) and the trackcd auth_service + tests/ subdir (for test-file filter
 * tests). `indexDirectory` prunes files not seen this run, so we need ONE
 * indexer pass over a single tree.
 */
function buildCombinedFixtures(): string {
  const root = path.join(os.tmpdir(), `seer-filters-fixtures-${Date.now()}`);
  fs.mkdirSync(root, { recursive: true });
  // C/C++ smoke samples — preserves the .h vs .cpp split that produces the
  // declaration / definition pair we want to test.
  for (const f of ['sample.h', 'sample.cpp']) {
    fs.copyFileSync(path.join(FIXTURES, f), path.join(root, f));
  }
  // Auth service from track-C/D fixtures + its test file. The test file MUST
  // live under a tests/ subdir for classifyFile to tag it 'test'.
  fs.copyFileSync(
    path.join(FIXTURES_TRACKCD, 'auth_service.ts'),
    path.join(root, 'auth_service.ts'),
  );
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.copyFileSync(
    path.join(FIXTURES_TRACKCD, 'tests', 'auth_service.test.ts'),
    path.join(root, 'tests', 'auth_service.test.ts'),
  );
  return root;
}

async function run(): Promise<void> {
  console.log('\nSeer Filter Tests (Task 2)');
  console.log('============================\n');

  const root = buildCombinedFixtures();
  const tmpDb = path.join(os.tmpdir(), `seer-filters-${Date.now()}.db`);

  const store = new Store(tmpDb);
  const indexer = new Indexer(store);
  console.log(`Indexing ${root}...`);
  await indexer.indexDirectory(root, { quiet: true });

  // ── C/C++ declarations vs definitions ──────────────────────────────────────
  console.log('\n── C/C++ class-body declarations ──');

  // sample.h has APickupItem class-body method declarations (field_declaration
  // with function_declarator). sample.cpp has the out-of-line definitions
  // (function_definition). Both should be indexed; their symbol_role should
  // differ.
  const onPickedUpAll = store.getDefinition('OnPickedUp', { includeDeclarations: true });
  console.log(`  getDefinition('OnPickedUp', includeDeclarations=true) → ${onPickedUpAll.length} row(s):`);
  for (const r of onPickedUpAll) {
    console.log(`    ${r.symbolRole ?? 'definition'}  ${path.basename(r.filePath)}:${r.lineStart + 1}  kind=${r.kind}`);
  }
  assert(onPickedUpAll.length >= 2, 'OnPickedUp has both declaration (.h) AND definition (.cpp)');
  assert(
    onPickedUpAll.some(r => r.symbolRole === 'declaration' && r.filePath.endsWith('sample.h')),
    `sample.h's OnPickedUp tagged as 'declaration'`,
  );
  assert(
    onPickedUpAll.some(r => (r.symbolRole === 'definition' || r.symbolRole == null) && r.filePath.endsWith('sample.cpp')),
    `sample.cpp's OnPickedUp tagged as 'definition'`,
  );

  const onPickedUpDefault = store.getDefinition('OnPickedUp');
  console.log(`  getDefinition('OnPickedUp') default → ${onPickedUpDefault.length} row(s):`);
  for (const r of onPickedUpDefault) {
    console.log(`    ${r.symbolRole ?? 'definition'}  ${path.basename(r.filePath)}:${r.lineStart + 1}`);
  }
  assert(
    onPickedUpDefault.every(r => r.symbolRole !== 'declaration'),
    `default getDefinition hides declarations (got ${onPickedUpDefault.map(r => r.symbolRole ?? 'definition').join(', ')})`,
  );
  assert(
    onPickedUpDefault.some(r => r.filePath.endsWith('sample.cpp')),
    'default getDefinition still returns the .cpp definition',
  );

  const onPickedUpFindDefault = store.findSymbols('OnPickedUp');
  assert(
    onPickedUpFindDefault.every(r => r.symbolRole !== 'declaration'),
    'default findSymbols hides declarations',
  );

  const onPickedUpFindAll = store.findSymbols('OnPickedUp', { includeDeclarations: true });
  assert(
    onPickedUpFindAll.some(r => r.symbolRole === 'declaration'),
    'findSymbols(includeDeclarations=true) returns declarations',
  );

  // ── Test-file symbols default filter ───────────────────────────────────────
  console.log('\n── Test-file symbols (file role: test) ──');

  const testFnDefault = store.findSymbols('testAuthServiceLogin');
  console.log(`  findSymbols('testAuthServiceLogin') default → ${testFnDefault.length}`);
  assert(
    testFnDefault.length === 0,
    'default findSymbols hides test-file symbols',
  );

  const testFnIncl = store.findSymbols('testAuthServiceLogin', { includeTests: true });
  console.log(`  findSymbols('testAuthServiceLogin', includeTests=true) → ${testFnIncl.length}`);
  assert(
    testFnIncl.length >= 1,
    'findSymbols(includeTests=true) returns test-file symbols',
  );

  const topDefault = store.getTopSymbols(50);
  const testInTop = topDefault.filter(s => s.filePath.includes(path.sep + 'tests' + path.sep) || s.filePath.includes('/tests/'));
  assert(
    testInTop.length === 0,
    `default getTopSymbols hides test-file symbols (got ${testInTop.length})`,
  );

  const topWithTests = store.getTopSymbols(50, { includeTests: true });
  assert(
    topWithTests.length >= topDefault.length,
    'getTopSymbols(includeTests=true) returns ≥ default count',
  );

  // countSymbols must respect both filters too — otherwise the MCP "total"
  // header would lie about visible result count.
  const cntDefault = store.countSymbols('testAuthServiceLogin');
  const cntWithTests = store.countSymbols('testAuthServiceLogin', { includeTests: true });
  assert(
    cntDefault === 0 && cntWithTests >= 1,
    `countSymbols respects includeTests (default=${cntDefault}, withTests=${cntWithTests})`,
  );

  // ── seer_behavior still works regardless of test-file filter ──────────────
  console.log('\n── seer_behavior (tests edges) bypasses test filter ──');

  const testsEdges = (store.rawDb().prepare(`
    SELECT s.name AS callerName, e.to_name AS calleeName, f.role AS callerRole
    FROM edges e
    JOIN symbols s ON s.id = e.from_id
    JOIN files f ON f.id = s.file_id
    WHERE e.kind = 'tests'
  `).all()) as Array<{ callerName: string; calleeName: string; callerRole: string }>;
  console.log(`  synthesized 'tests' edges:`);
  for (const e of testsEdges) console.log(`    ${e.callerName} → ${e.calleeName}  (callerRole=${e.callerRole})`);
  assert(
    testsEdges.length >= 1 && testsEdges.every(e => e.callerRole === 'test'),
    'tests edges originate from test-file symbols (intentional; seer_behavior queries them directly)',
  );

  // ── includeTypeRefs is forward-looking (no type_ref rows emitted yet) ────
  console.log('\n── includeTypeRefs (forward-looking) ──');

  const typeRefRows = (store.rawDb().prepare(`SELECT COUNT(*) AS c FROM symbols WHERE symbol_role = 'type_ref'`).get()) as { c: number };
  console.log(`  symbols with role='type_ref' in DB: ${typeRefRows.c}`);
  assert(
    typeRefRows.c === 0,
    'no extractor emits type_ref rows yet (filter slot is reserved for future use)',
  );

  const empty = store.findSymbols('OnPickedUp', { includeTypeRefs: true });
  assert(
    Array.isArray(empty),
    'findSymbols accepts includeTypeRefs without crashing',
  );

  // ── Vendor / generated defaults still respected ────────────────────────────
  console.log('\n── Vendor + generated filter still in place ──');

  const roles = store.getRoleCounts();
  console.log(`  role counts: project=${roles.project}, test=${roles.test}, vendor=${roles.vendor}, generated=${roles.generated}`);
  assert(roles.test >= 1, 'at least one test file classified as test');
  assert(roles.project >= 1, 'at least one project file');

  // ── symbol_role column populated for new rows ─────────────────────────────
  console.log('\n── symbol_role column populated ──');

  const sampleDef = (store.rawDb().prepare(
    `SELECT symbol_role FROM symbols WHERE name = 'OnPickedUp' AND file_id IN (SELECT id FROM files WHERE rel_path LIKE '%sample.cpp')`,
  ).get()) as { symbol_role: string } | undefined;
  assert(
    sampleDef !== undefined && sampleDef.symbol_role === 'definition',
    `sample.cpp OnPickedUp persisted as symbol_role='definition' (got ${sampleDef?.symbol_role ?? 'missing'})`,
  );

  const sampleDecl = (store.rawDb().prepare(
    `SELECT symbol_role FROM symbols WHERE name = 'OnPickedUp' AND file_id IN (SELECT id FROM files WHERE rel_path LIKE '%sample.h')`,
  ).get()) as { symbol_role: string } | undefined;
  assert(
    sampleDecl !== undefined && sampleDecl.symbol_role === 'declaration',
    `sample.h OnPickedUp persisted as symbol_role='declaration' (got ${sampleDecl?.symbol_role ?? 'missing'})`,
  );

  // ── PageRank discipline: declarations should be non-rankable ──────────────
  console.log('\n── Declarations are non-rankable (pinned to pr=0) ──');

  const declPagerank = (store.rawDb().prepare(
    `SELECT pagerank, is_rankable FROM symbols
     WHERE symbol_role = 'declaration' AND kind IN ('function','method','constructor','class')`,
  ).all()) as Array<{ pagerank: number; is_rankable: number }>;
  console.log(`  declaration rows with rankable kind: ${declPagerank.length}`);
  assert(
    declPagerank.every(r => r.is_rankable === 0 && r.pagerank === 0),
    'declarations are excluded from PageRank (is_rankable=0, pagerank=0)',
  );

  const defPagerank = (store.rawDb().prepare(
    `SELECT COUNT(*) AS c FROM symbols WHERE symbol_role = 'definition' AND kind IN ('function','method','constructor','class') AND is_rankable = 1`,
  ).get()) as { c: number };
  assert(defPagerank.c > 0, 'body-bearing definitions remain rankable');

  // ── Cleanup ──────────────────────────────────────────────────────────────
  store.close();
  if (fs.existsSync(tmpDb)) fs.unlinkSync(tmpDb);
  fs.rmSync(root, { recursive: true, force: true });

  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(`  Filter test results: ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    console.error('\n  FILTER TESTS FAILED\n');
    process.exit(1);
  } else {
    console.log('\n  All filter tests passed! ✓\n');
  }
}

run().catch(err => {
  console.error('Filter test threw:', err);
  process.exit(1);
});
