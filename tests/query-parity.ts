/**
 * Tree-Sitter query candidate-collection parity test.
 *
 * Parses each fixture twice — once with the query-assisted candidate walker
 * (default) and once with the baseline walker forced — and asserts the two
 * extractions are identical for every category: definitions, references,
 * imports, routes, config keys.
 *
 * If parity ever fails, the candidate node-type list is missing a type that
 * the corresponding tryExtract* handler accepts.
 *
 * Run with: npx tsx tests/query-parity.ts  (also runs from `npm test`)
 */

import path from 'path';
import fs from 'fs';
import { parseFile, setForceBaselineWalker } from '../src/parser/index';
import type { FileExtraction } from '../src/types';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

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

function canonicalize(extraction: FileExtraction): string {
  // Sort each list deterministically so order-of-traversal differences (which
  // there shouldn't be — but defensively) don't fail the comparison.
  const defs = [...extraction.definitions].sort((a, b) =>
    (a.lineStart - b.lineStart) ||
    (a.name.localeCompare(b.name)) ||
    ((a.qualifiedName ?? '').localeCompare(b.qualifiedName ?? ''))
  );
  const refs = [...extraction.references].sort((a, b) =>
    (a.line - b.line) || a.calleeName.localeCompare(b.calleeName) || a.callerName.localeCompare(b.callerName)
  );
  const imports = [...extraction.importedModules].sort();
  const routes = [...(extraction.routes ?? [])].sort((a, b) =>
    (a.line - b.line) || a.method.localeCompare(b.method) || a.path.localeCompare(b.path)
  );
  const configKeys = [...(extraction.configKeys ?? [])].sort((a, b) =>
    (a.line - b.line) || a.key.localeCompare(b.key)
  );
  return JSON.stringify({
    language: extraction.language,
    definitions: defs.map(d => ({
      name: d.name,
      qualifiedName: d.qualifiedName,
      kind: d.kind,
      lineStart: d.lineStart,
      lineEnd: d.lineEnd,
      cyclomatic: d.cyclomatic ?? null,
      cognitive: d.cognitive ?? null,
      maxNesting: d.maxNesting ?? null,
      loc: d.loc ?? null,
    })),
    references: refs.map(r => ({
      calleeName: r.calleeName,
      callerName: r.callerName,
      kind: r.kind,
      line: r.line,
    })),
    imports,
    routes: routes.map(r => ({
      method: r.method,
      path: r.path,
      framework: r.framework,
      handlerName: r.handlerName ?? null,
      line: r.line,
    })),
    configKeys: configKeys.map(c => ({
      key: c.key,
      source: c.source,
      callerName: c.callerName ?? '',
      line: c.line,
    })),
  }, null, 2);
}

async function compareFile(filePath: string): Promise<void> {
  const content = fs.readFileSync(filePath, 'utf8');
  const rel = path.relative(FIXTURES_DIR, filePath);

  setForceBaselineWalker(false);
  const queryAssisted = await parseFile(content, filePath);

  setForceBaselineWalker(true);
  const baseline = await parseFile(content, filePath);
  setForceBaselineWalker(false);

  if (!queryAssisted && !baseline) {
    // Both null (probably an unsupported extension) — skip without counting.
    return;
  }

  assert(
    queryAssisted !== null && baseline !== null,
    `[${rel}] both walkers succeed`,
  );
  if (!queryAssisted || !baseline) return;

  const queryStr = canonicalize(queryAssisted);
  const baselineStr = canonicalize(baseline);

  const equal = queryStr === baselineStr;
  assert(equal, `[${rel}] query-assisted ≡ baseline (${queryAssisted.definitions.length} defs, ${queryAssisted.references.length} refs, ${queryAssisted.importedModules.length} imports, ${queryAssisted.routes?.length ?? 0} routes, ${queryAssisted.configKeys?.length ?? 0} configKeys)`);
  if (!equal) {
    // Locate the first differing section for a useful failure message.
    const diff = firstDiff(queryStr, baselineStr);
    console.error(`    First difference at offset ${diff.offset}:`);
    console.error(`      query:    ${diff.queryLine}`);
    console.error(`      baseline: ${diff.baselineLine}`);
  }
}

function firstDiff(a: string, b: string): { offset: number; queryLine: string; baselineLine: string } {
  let off = 0;
  while (off < a.length && off < b.length && a[off] === b[off]) off++;
  const lineStart = Math.max(0, a.lastIndexOf('\n', off));
  const aEnd = a.indexOf('\n', off);
  const bEnd = b.indexOf('\n', off);
  return {
    offset: off,
    queryLine: a.slice(lineStart, aEnd === -1 ? a.length : aEnd).trim(),
    baselineLine: b.slice(lineStart, bEnd === -1 ? b.length : bEnd).trim(),
  };
}

async function walkFixtures(dir: string, out: string[]): Promise<void> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkFixtures(p, out);
    } else if (entry.isFile()) {
      out.push(p);
    }
  }
}

async function run(): Promise<void> {
  console.log('\nSeer Query-Assisted Walker Parity Test');
  console.log('========================================\n');

  const all: string[] = [];
  await walkFixtures(FIXTURES_DIR, all);
  // Also include the Track-C/D fixtures so we exercise the route + configKey
  // extractors against the same parity check.
  const trackcdDir = path.join(__dirname, 'fixtures-trackcd');
  if (fs.existsSync(trackcdDir)) await walkFixtures(trackcdDir, all);

  for (const f of all) {
    const ext = path.extname(f).toLowerCase();
    if (!['.py', '.pyw', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
          '.go', '.java', '.rs', '.c', '.cpp', '.cc', '.cxx', '.c++',
          '.hpp', '.hh', '.h++', '.h', '.cs'].includes(ext)) {
      continue;
    }
    await compareFile(f);
  }

  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    console.error('\n  QUERY PARITY FAILED\n');
    process.exit(1);
  } else {
    console.log('\n  All query-parity tests passed! ✓\n');
  }
}

run().catch(err => {
  console.error('Query parity test threw:', err);
  process.exit(1);
});
