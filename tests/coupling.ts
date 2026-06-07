/**
 * Temporal coupling (seer_changes_with) + call-site snippets (seer_callers
 * includeSnippets).
 *
 * Phase 1 (in-process): build a purpose-made git repo where two cross-file
 * symbols co-change in several focused commits, plus a huge "sweeping" commit
 * and a giant initial file-addition commit that must BOTH be dropped as noise.
 * Index it, build symbol history, and assert the coupling miner finds the real
 * pair, respects minSupport / maxCommitSymbols / includeSameFile, and excludes
 * the unrelated symbol.
 *
 * Phase 2 (spawned MCP server over stdio): assert seer_changes_with surfaces
 * the same coupling, and seer_callers includeSnippets returns the real source
 * at a call site.
 *
 * Run: npm run build && npx tsx tests/coupling.ts
 */

import path from 'path';
import fs from 'fs';
import os from 'os';
import { spawn, spawnSync } from 'child_process';
import { Indexer } from '../src/indexer/index';
import { Store } from '../src/db/store';
import { buildSymbolHistory } from '../src/indexer/symbolhistory';
import { computeCoupling } from '../src/indexer/coupling';

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'dist/cli/index.js');
const TMP = path.join(os.tmpdir(), `seer-coupling-${Date.now()}`);
const REPO = path.join(TMP, 'repo');
const DB = path.join(REPO, '.seer', 'graph.db');

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string, extra?: unknown): void {
  if (cond) { console.log(`  ✓ ${msg}`); passed++; }
  else { console.error(`  ✗ ${msg}` + (extra !== undefined ? ` :: ${JSON.stringify(extra).slice(0, 300)}` : '')); failed++; }
}

function git(...args: string[]): { stdout: string; status: number } {
  const r = spawnSync('git', ['-C', REPO, ...args], { encoding: 'utf8', windowsHide: true });
  return { stdout: r.stdout ?? '', status: r.status ?? 1 };
}
function commit(message: string, isoDate?: string): string {
  git('add', '.');
  const env = { ...process.env } as Record<string, string>;
  if (isoDate) { env.GIT_AUTHOR_DATE = isoDate; env.GIT_COMMITTER_DATE = isoDate; }
  const r = spawnSync('git', ['-C', REPO,
    '-c', 'user.email=dev@example.com', '-c', 'user.name=Dev',
    'commit', '-m', message, '--no-gpg-sign'],
    { encoding: 'utf8', windowsHide: true, env });
  if (r.status !== 0) throw new Error(`git commit failed: ${r.stderr}`);
  return git('rev-parse', 'HEAD').stdout.trim();
}
function write(rel: string, content: string): void {
  const full = path.join(REPO, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
}

// core.ts holds serialize + serializeMeta (same-file partner) + coreHelper.
function coreFile(serializeBody: string, metaBody: string): string {
  return [
    'export function serialize(x: number): string {',
    `  ${serializeBody}`,
    '}',
    '',
    'export function serializeMeta(x: number): string {',
    `  ${metaBody}`,
    '}',
    '',
    'export function coreHelper(): number {',
    '  return 7;',
    '}',
    '',
  ].join('\n');
}

async function phase1(): Promise<void> {
  console.log('\n── Phase 1: in-process coupling miner ──\n');

  fs.mkdirSync(REPO, { recursive: true });
  if (spawnSync('git', ['-C', REPO, 'init', '-q', '-b', 'main'], { encoding: 'utf8' }).status !== 0) {
    spawnSync('git', ['-C', REPO, 'init', '-q'], { encoding: 'utf8' });
  }
  git('config', 'commit.gpgsign', 'false');

  // c1 — giant initial file-addition commit. Every symbol is attributed to it,
  // so its breadth is large and the noise filter must drop it.
  write('core.ts', coreFile('return "v1:" + x;', 'return "m1:" + x;'));
  write('wire.ts', [
    'export function deserialize(s: string): number {',
    '  return Number(s.split(":")[1]);',
    '}',
    '',
  ].join('\n'));
  write('misc.ts', [
    'export function unrelated(): number {',
    '  return 0;',
    '}',
    '',
  ].join('\n'));
  // caller.ts gives serialize a real call site for the snippet test.
  write('caller.ts', [
    'import { serialize } from "./core";',
    'export function callsIt(): string {',
    '  return serialize(99);',
    '}',
    '',
  ].join('\n'));
  // bulk.ts: ten functions modified together in the sweeping commit.
  const bulk = Array.from({ length: 10 }, (_, i) =>
    `export function bulk${i}(): number {\n  return ${i};\n}\n`).join('\n');
  write('bulk.ts', bulk);
  const c1 = commit('initial: add all modules', '2020-01-01T00:00:00Z');

  // c2 — serialize + serializeMeta + deserialize change together (format bump).
  write('core.ts', coreFile('return "v2|" + x;', 'return "m2|" + x;'));
  write('wire.ts', [
    'export function deserialize(s: string): number {',
    '  return Number(s.split("|")[1]);',
    '}',
    '',
  ].join('\n'));
  const c2 = commit('format v2: serialize/serializeMeta/deserialize', '2020-02-01T00:00:00Z');

  // c3 — same trio changes again.
  write('core.ts', coreFile('return "v3#" + x;', 'return "m3#" + x;'));
  write('wire.ts', [
    'export function deserialize(s: string): number {',
    '  return Number(s.split("#")[1]);',
    '}',
    '',
  ].join('\n'));
  const c3 = commit('format v3: serialize/serializeMeta/deserialize', '2020-03-01T00:00:00Z');

  // c4 — serialize + deserialize change (NOT serializeMeta this time).
  write('core.ts', coreFile('return "v4@" + x;', 'return "m3#" + x;'));
  write('wire.ts', [
    'export function deserialize(s: string): number {',
    '  return Number(s.split("@")[1]);',
    '}',
    '',
  ].join('\n'));
  const c4 = commit('format v4: serialize/deserialize only', '2020-04-01T00:00:00Z');

  // c5 — sweeping commit: every bulk fn + serialize. Breadth 11 → noise.
  write('bulk.ts', Array.from({ length: 10 }, (_, i) =>
    `export function bulk${i}(): number {\n  return ${i} + 1;\n}\n`).join('\n'));
  write('core.ts', coreFile('return "v5%" + x;', 'return "m3#" + x;'));
  const c5 = commit('sweeping refactor across bulk + serialize', '2020-05-01T00:00:00Z');

  console.log(`  commits: ${[c1, c2, c3, c4, c5].map(s => s.slice(0, 7)).join(' ')}`);

  fs.mkdirSync(path.dirname(DB), { recursive: true });
  const store = new Store(DB);
  const indexer = new Indexer(store);
  await indexer.indexDirectory(REPO, { quiet: true });
  const hist = await buildSymbolHistory(REPO, store, { skipIfHeadUnchanged: false, log: () => {} });
  console.log(`  history rows inserted: ${hist.historyRowsInserted}`);

  const serialize = store.getDefinition('serialize', { filePath: 'core.ts' })[0];
  assert(serialize !== undefined, 'serialize resolves');

  // ── Default coupling: noise filter drops the 15-symbol initial + 11-symbol
  // sweeping commit; only the focused v2/v3/v4 commits remain. ──
  const res = computeCoupling(store, serialize.id, { maxCommitSymbols: 6, minSupport: 2 });
  const names = res.partners.map(p => `${p.symbol.name}(${p.sharedCommits},sf=${p.sameFile})`);
  console.log(`  targetCommits=${res.targetCommits} effective=${res.effectiveCommits} noisy=${res.noisyCommitsIgnored}`);
  console.log(`  partners: ${names.join(', ') || '(none)'}`);

  assert(res.targetCommits === 5, 'serialize touched in 5 commits', res.targetCommits);
  assert(res.effectiveCommits === 3, '3 non-noisy commits (v2,v3,v4)', res.effectiveCommits);
  assert(res.noisyCommitsIgnored === 2, '2 noisy commits dropped (initial + sweep)', res.noisyCommitsIgnored);

  const de = res.partners.find(p => p.symbol.name === 'deserialize');
  assert(de !== undefined, 'deserialize is a coupled partner');
  assert(de?.sharedCommits === 3, 'deserialize shares 3 commits', de?.sharedCommits);
  assert(de?.confidence === 1, 'deserialize confidence = 1.0 (every serialize commit)', de?.confidence);
  assert(de?.sameFile === false, 'deserialize flagged cross-file', de?.sameFile);

  const meta = res.partners.find(p => p.symbol.name === 'serializeMeta');
  assert(meta !== undefined, 'serializeMeta (same-file partner) present');
  assert(meta?.sharedCommits === 2, 'serializeMeta shares 2 commits (v2,v3)', meta?.sharedCommits);
  assert(meta?.sameFile === true, 'serializeMeta flagged sameFile', meta?.sameFile);

  assert(!res.partners.some(p => p.symbol.name === 'unrelated'), 'unrelated NOT coupled');
  assert(!res.partners.some(p => p.symbol.name === 'coreHelper'), 'coreHelper NOT coupled (only shared the noisy initial)');
  assert(!res.partners.some(p => p.symbol.name.startsWith('bulk')), 'bulk* NOT coupled (only the noisy sweep)');

  // ── includeSameFile=false drops the same-file partner only. ──
  const crossOnly = computeCoupling(store, serialize.id, { maxCommitSymbols: 6, minSupport: 2, includeSameFile: false });
  assert(crossOnly.partners.some(p => p.symbol.name === 'deserialize'), 'cross-file-only still has deserialize');
  assert(!crossOnly.partners.some(p => p.symbol.name === 'serializeMeta'), 'cross-file-only drops serializeMeta');

  // ── minSupport gate: raising it past the pair's support empties the list. ──
  const strict = computeCoupling(store, serialize.id, { maxCommitSymbols: 6, minSupport: 4 });
  assert(strict.partners.length === 0, 'minSupport=4 yields no partners (max support is 3)', strict.partners.length);

  // ── Relaxing the noise cap lets the sweeping/initial commits back in, so
  // bulk* and coreHelper become (weak) partners — proves the filter is load-bearing. ──
  const noisy = computeCoupling(store, serialize.id, { maxCommitSymbols: 100, minSupport: 1 });
  assert(noisy.noisyCommitsIgnored === 0, 'no commits dropped at a high cap', noisy.noisyCommitsIgnored);
  assert(noisy.partners.some(p => p.symbol.name.startsWith('bulk')), 'bulk* reappears once the sweep is not filtered');

  // ── partnerCommits is windowed by `since` (finding 4): all-time the partner's
  // base rate counts the initial commit; windowed past it, that commit drops. ──
  const allTime = store.coupledSymbols(serialize.id, { maxCommitSymbols: 6, minSupport: 2 });
  const deAll = allTime.rows.find(r => r.symbolId === store.getDefinition('deserialize', { filePath: 'wire.ts' })[0].id);
  assert(deAll?.partnerCommits === 4, 'all-time partnerCommits(deserialize) = 4 (c1..c4)', deAll?.partnerCommits);

  const sinceFeb = Math.floor(Date.parse('2020-02-01T00:00:00Z') / 1000);
  const windowed = store.coupledSymbols(serialize.id, { maxCommitSymbols: 6, minSupport: 2, since: sinceFeb });
  const deWin = windowed.rows.find(r => r.symbolId === store.getDefinition('deserialize', { filePath: 'wire.ts' })[0].id);
  assert(deWin?.partnerCommits === 3, 'windowed partnerCommits(deserialize) = 3 (initial commit dropped)', deWin?.partnerCommits);
  assert(windowed.targetCommits === 4, 'windowed targetCommits drops the initial commit (5→4)', windowed.targetCommits);

  store.close();
}

// Minimal stdio JSON-RPC client for a spawned MCP server.
interface McpConn { call: (m: string, p: any, t?: number) => Promise<any>; parse: (r: any) => any; close: () => void; }
async function connectMcp(workspace: string): Promise<McpConn> {
  const proc = spawn(process.execPath, [CLI, 'mcp', '--workspace', workspace, '--no-watch', '--no-jit'],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  proc.stderr.on('data', () => { /* swallow */ });
  let buf = '';
  const pending = new Map<number, (m: any) => void>();
  proc.stdout.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8');
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg: any; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)!(msg); pending.delete(msg.id); }
    }
  });
  let nextId = 1;
  const call = (method: string, params: any, timeoutMs = 30_000): Promise<any> => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { pending.delete(id); reject(new Error(`timeout: ${method}`)); }, timeoutMs);
      pending.set(id, (m) => { clearTimeout(t); resolve(m); });
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  };
  const parse = (r: any): any => JSON.parse(r.result?.content?.[0]?.text ?? '{}');
  await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'coupling', version: '0' } });
  return { call, parse, close: () => { proc.stdin.end(); proc.kill(); } };
}

async function phase2(): Promise<void> {
  console.log('\n── Phase 2: MCP server (seer_changes_with + includeSnippets) ──\n');
  const { call, parse, close } = await connectMcp(REPO);
  try {
    const cw = parse(await call('tools/call', {
      name: 'seer_changes_with',
      arguments: { symbol: 'serialize', file: 'core.ts', maxCommitSymbols: 6, minSupport: 2 },
    }));
    const partnerNames = (cw.partners ?? []).map((p: any) => p.symbol.name);
    assert(cw.historyIndex?.built === true, 'seer_changes_with sees a built history index', cw.historyIndex);
    assert(cw.historyComplete === true, 'seer_changes_with reports historyComplete=true after a full build', cw.historyComplete);
    assert(partnerNames.includes('deserialize'), 'seer_changes_with returns deserialize', partnerNames);
    assert(typeof cw.note === 'string' && /[Aa]dvisory/.test(cw.note), 'seer_changes_with carries an advisory note');

    // Cold-miss honesty: unknown symbol returns didYouMean, not a crash.
    const miss = parse(await call('tools/call', {
      name: 'seer_changes_with', arguments: { symbol: 'doesNotExistXYZ' },
    }));
    assert(miss.found === false && Array.isArray(miss.partners) && miss.partners.length === 0,
      'seer_changes_with miss is clean (found:false, empty partners)');

    // seer_callers includeSnippets returns real source at the call site.
    const callers = parse(await call('tools/call', {
      name: 'seer_callers',
      arguments: { symbol: 'serialize', file: 'core.ts', includeSnippets: true, snippetContext: 1 },
    }));
    const withSnippet = (callers.items ?? []).find((it: any) => typeof it.snippet === 'string');
    assert(withSnippet !== undefined, 'seer_callers includeSnippets attaches a snippet', callers.items);
    assert(withSnippet && /serialize\(99\)/.test(withSnippet.snippet),
      'snippet contains the real call expression serialize(99)', withSnippet?.snippet);
    assert(withSnippet?.snippetRange?.startLine > 0, 'snippet carries a 1-based line range', withSnippet?.snippetRange);

    // Without the flag, no snippet (zero-overhead baseline preserved).
    const plain = parse(await call('tools/call', {
      name: 'seer_callers', arguments: { symbol: 'serialize', file: 'core.ts' },
    }));
    assert((plain.items ?? []).every((it: any) => it.snippet === undefined),
      'seer_callers without includeSnippets has no snippet field');
  } finally { close(); }
}

// Finding-1 regression: a SCOPED single-file history build (what seer_history
// auto-builds on a cold miss) flips historyIndex.built true but leaves
// lastHistoryHeadSha null. seer_changes_with must NOT treat that as a trustworthy
// full index — it must report historyComplete=false and a "not FULLY built" note.
async function phase3(): Promise<void> {
  console.log('\n── Phase 3: scoped-only history must not pass as full (finding 1) ──\n');
  const repo3 = path.join(TMP, 'repo3');
  fs.mkdirSync(repo3, { recursive: true });
  const g = (...a: string[]) => spawnSync('git', ['-C', repo3, ...a], { encoding: 'utf8', windowsHide: true });
  if (g('init', '-q', '-b', 'main').status !== 0) g('init', '-q');
  g('config', 'commit.gpgsign', 'false');
  const cm = (msg: string) => {
    g('add', '.');
    spawnSync('git', ['-C', repo3, '-c', 'user.email=d@e.com', '-c', 'user.name=D', 'commit', '-m', msg, '--no-gpg-sign'],
      { encoding: 'utf8', windowsHide: true });
  };
  fs.writeFileSync(path.join(repo3, 'a.ts'), 'export function aOne(): number {\n  return 1;\n}\n');
  fs.writeFileSync(path.join(repo3, 'b.ts'), 'export function bOne(): number {\n  return 2;\n}\n');
  cm('init a + b');
  fs.writeFileSync(path.join(repo3, 'a.ts'), 'export function aOne(): number {\n  return 11;\n}\n');
  fs.writeFileSync(path.join(repo3, 'b.ts'), 'export function bOne(): number {\n  return 22;\n}\n');
  cm('bump a + b');

  // Index but DO NOT build full history.
  fs.mkdirSync(path.join(repo3, '.seer'), { recursive: true });
  const store = new Store(path.join(repo3, '.seer', 'graph.db'));
  await new Indexer(store).indexDirectory(repo3, { quiet: true });
  store.close();

  const { call, parse, close } = await connectMcp(repo3);
  try {
    // Scoped auto-build of just a.ts via seer_history (cold-miss path).
    await call('tools/call', { name: 'seer_history', arguments: { symbol: 'aOne', file: 'a.ts' } });
    const hist = parse(await call('tools/call', { name: 'seer_history', arguments: { symbol: 'aOne', file: 'a.ts', autoBuild: false } }));
    assert(hist.historyIndex?.built === true, 'after scoped build, historyIndex.built is true (rows exist)', hist.historyIndex);
    assert(hist.historyIndex?.lastHistoryHeadSha == null, 'scoped build leaves lastHistoryHeadSha null (not a full build)', hist.historyIndex);

    const cw = parse(await call('tools/call', { name: 'seer_changes_with', arguments: { symbol: 'aOne', file: 'a.ts' } }));
    assert(cw.historyComplete === false, 'seer_changes_with reports historyComplete=false on a scoped-only index', cw.historyComplete);
    assert(/FULLY/.test(cw.note ?? ''), 'note warns history is not FULLY built (no false confidence)', cw.note);
  } finally { close(); }
}

// Phase 4: the CLI surface (finding 2 — every capability available from shell).
// REPO still has the full history index from phase 1.
function phase4(): void {
  console.log('\n── Phase 4: CLI (seer changes-with + callers --include-snippets) ──\n');
  const runCli = (...args: string[]) =>
    spawnSync(process.execPath, [CLI, ...args, '--db', DB], { encoding: 'utf8', windowsHide: true });

  const cw = runCli('changes-with', 'serialize', '--file', 'core.ts', '--max-commit-symbols', '6', '--json');
  assert(cw.status === 0, 'CLI changes-with exits 0', cw.stderr);
  let parsed: any = {};
  try { parsed = JSON.parse(cw.stdout); } catch { /* */ }
  assert(parsed.historyComplete === true, 'CLI changes-with --json reports historyComplete=true', parsed.historyComplete);
  assert((parsed.partners ?? []).some((p: any) => p.symbol.name === 'deserialize'),
    'CLI changes-with finds deserialize', (parsed.partners ?? []).map((p: any) => p.symbol.name));

  const cwCross = runCli('changes-with', 'serialize', '--file', 'core.ts', '--max-commit-symbols', '6', '--cross-file-only', '--json');
  const crossParsed = JSON.parse(cwCross.stdout || '{}');
  assert(!(crossParsed.partners ?? []).some((p: any) => p.symbol.name === 'serializeMeta'),
    'CLI --cross-file-only drops the same-file partner');

  const snip = runCli('callers', 'serialize', '--file', 'core.ts', '--include-snippets', '--snippet-context', '1');
  assert(snip.status === 0, 'CLI callers --include-snippets exits 0', snip.stderr);
  assert(/serialize\(99\)/.test(snip.stdout), 'CLI callers --include-snippets prints the real call source', snip.stdout.slice(0, 200));
}

async function main(): Promise<void> {
  console.log('\nSeer Coupling + Snippets Tests');
  console.log('================================');
  const hasGit = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
  if (!hasGit) { console.log('  skipping: git unavailable'); return; }

  await phase1();
  await phase2();
  await phase3();
  phase4();

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ }
  console.log(`\n══════════════════════════════════════════════════════════════`);
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) { console.error('\n  COUPLING TEST FAILED\n'); process.exit(1); }
  console.log('\n  All coupling + snippet tests passed! ✓\n');
}

main().catch(err => { console.error('coupling test crashed:', err); process.exit(1); });
