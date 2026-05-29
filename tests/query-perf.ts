/**
 * Micro-bench: compare query-assisted vs baseline walker on the same fixtures.
 * Not part of the standard test suite — run manually when changing the query
 * path:  npx tsx tests/query-perf.ts
 */
import path from 'path';
import fs from 'fs';
import { parseFile, setForceBaselineWalker } from '../src/parser/index';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const REPEATS = 5;

async function walkFixtures(dir: string, out: string[]): Promise<void> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) await walkFixtures(p, out);
    else out.push(p);
  }
}

async function time(label: string, files: string[]): Promise<number> {
  // Warmup
  for (const f of files) await parseFile(fs.readFileSync(f, 'utf8'), f);
  const start = Date.now();
  for (let i = 0; i < REPEATS; i++) {
    for (const f of files) await parseFile(fs.readFileSync(f, 'utf8'), f);
  }
  const elapsed = Date.now() - start;
  console.log(`  ${label.padEnd(30)} ${elapsed}ms (${files.length} files × ${REPEATS} = ${files.length * REPEATS} parses)`);
  return elapsed;
}

async function run(): Promise<void> {
  const all: string[] = [];
  await walkFixtures(FIXTURES_DIR, all);
  const tcd = path.join(__dirname, 'fixtures-trackcd');
  if (fs.existsSync(tcd)) await walkFixtures(tcd, all);
  const fixtures = all.filter(f => /\.(ts|tsx|js|py|go|java|rs|c|cpp|cs|h|hpp)$/.test(f));
  console.log(`\nQuery vs baseline walker micro-bench`);
  console.log(`====================================\n`);
  console.log(`  fixtures: ${fixtures.length}`);

  setForceBaselineWalker(false);
  const queryMs = await time('query-assisted', fixtures);

  setForceBaselineWalker(true);
  const baselineMs = await time('baseline', fixtures);

  setForceBaselineWalker(false);

  const ratio = queryMs / baselineMs;
  console.log(`\n  query / baseline = ${ratio.toFixed(2)}x  (${ratio < 1 ? 'query faster' : 'baseline faster'})`);
}

run().catch(err => { console.error(err); process.exit(1); });
