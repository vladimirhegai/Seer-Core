/**
 * Track I — Feature 3: Preflight Context.
 *
 * Symbol mode:
 *   - returns a packet for a known symbol containing risk, likely tests,
 *     service impact, history, and warnings.
 *   - missing symbol returns ok=false but command does not crash.
 *
 * Range mode (--from/--to):
 *   - a fixture branch with a single function change has its symbol mapped
 *     correctly into touchedSymbols.
 *
 * Run: npx tsx tests/tracki-preflight.ts
 */

import path from 'path';
import fs from 'fs';
import os from 'os';
import { spawnSync } from 'child_process';
import { Indexer } from '../src/indexer/index';
import { Store } from '../src/db/store';
import { preflight } from '../src/indexer/preflight';

const TMP = path.join(os.tmpdir(), `seer-tracki-preflight-${Date.now()}`);
const REPO = path.join(TMP, 'repo');
const DB = path.join(TMP, 'graph.db');

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

function git(...args: string[]): { stdout: string; status: number; stderr: string } {
  const r = spawnSync('git', ['-C', REPO, ...args], { encoding: 'utf8' });
  return { stdout: r.stdout ?? '', status: r.status ?? 1, stderr: r.stderr ?? '' };
}

function commit(message: string, author = 'Alice <alice@example.com>'): string {
  git('add', '.');
  const r = spawnSync(
    'git',
    ['-C', REPO, '-c', `user.email=${author.replace(/^.* <(.+)>$/, '$1')}`,
            '-c', `user.name=${author.replace(/ <.+>$/, '')}`,
            'commit', '-m', message, '--no-gpg-sign'],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) throw new Error(`git commit failed: ${r.stderr}`);
  return git('rev-parse', 'HEAD').stdout.trim();
}

function write(rel: string, content: string): void {
  const full = path.join(REPO, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
}

async function main(): Promise<void> {
  console.log('\nSeer Track I — Feature 3: Preflight Context');
  console.log('============================================\n');
  cleanup();
  fs.mkdirSync(REPO, { recursive: true });

  spawnSync('git', ['-C', REPO, 'init', '-q', '-b', 'main'], { encoding: 'utf8' });
  git('config', 'commit.gpgsign', 'false');

  // Commit 1: initial files — `validateToken`, its caller, and a test for it.
  write('src/auth.ts', `
export function validateToken(token: string): boolean {
  if (!token) return false;
  return token.length > 8;
}

export function authenticate(req: { token: string }): boolean {
  return validateToken(req.token);
}
`.trimStart());
  write('src/api.ts', `
import { authenticate } from './auth';
declare const app: any;
export function loginHandler(req: any, res: any) {
  if (!authenticate(req)) return res.status(401).send();
  return res.send({ ok: true });
}
app.post('/api/login', loginHandler);
`.trimStart());
  write('tests/auth.test.ts', `
import { validateToken } from '../src/auth';

function testValidateRejectsEmpty(): void {
  const ok = validateToken('');
  expect(ok).toBe(false);
}

function testValidateRejectsShort(): void {
  const ok = validateToken('abc');
  expect(ok).toBe(false);
}

function testValidateAcceptsLong(): void {
  const ok = validateToken('abcdefghi');
  expect(ok).toBe(true);
}

function expect(_v: unknown) {
  return { toBe(_e: unknown): void { /* */ } };
}
`.trimStart());
  const sha1 = commit('Initial: auth + api + tests');

  // Index the repo.
  const store = new Store(DB);
  try {
    const idx = new Indexer(store);
    await idx.indexDirectory(REPO, { quiet: true });

    // ── Symbol-mode preflight on validateToken ────────────────────────────
    console.log('── Symbol-mode preflight ──');
    const r = await preflight(store, { symbol: 'validateToken', workspace: REPO });
    assertEq(r.ok, true, 'preflight ok=true for known symbol');
    assertEq(r.mode, 'symbol', 'mode=symbol');
    assert(r.symbol?.name === 'validateToken', 'symbol.name === "validateToken"');
    assert(Array.isArray(r.touchedSymbols) && r.touchedSymbols.length === 1,
      'touchedSymbols length === 1');
    assert(['low', 'medium', 'high'].includes(r.risk.overall),
      'risk.overall is one of low/medium/high');
    assert(r.risk.perSymbol.length === 1, 'risk.perSymbol has one entry');
    assert(r.risk.perSymbol[0].topContributors.length > 0,
      'risk top contributors are listed');
    assert(r.likelyTests.length >= 1,
      `likelyTests includes at least one test (got ${r.likelyTests.length})`);
    const validateTokenTest = r.likelyTests.find(t =>
      t.testSymbol.file.includes('auth.test'));
    assert(validateTokenTest != null,
      'likelyTests references the validateToken test file');

    // The symbol is not route-exposed, no service impact expected directly.
    // (loginHandler exposes /api/login but validateToken is the leaf.)

    // ── Symbol-mode service impact preserves the real protocol (regression) ─
    // The ContextPacket preview drops protocol; symbol-mode preflight used to
    // hardcode 'http', mislabeling tRPC/gRPC/Kafka links. Inject a gRPC link
    // into loginHandler and assert the protocol survives.
    console.log('\n── Symbol-mode service impact protocol fidelity ──');
    {
      const raw = store.rawDb();
      const handler = store.getDefinition('loginHandler')[0];
      const caller = store.getDefinition('authenticate')[0];
      assert(handler != null && caller != null, 'handler + caller symbols resolved');
      const handlerFileId = store.getSymbolById(handler.id)!.fileId;
      const callRes = raw.prepare(`
        INSERT INTO service_calls
          (file_id, symbol_id, protocol, method, raw_target, normalized_path,
           framework, line, confidence, operation, service)
        VALUES (?, ?, 'grpc', NULL, 'AuthService/Login', NULL, 'grpc', 0, 1.0, 'Login', 'AuthService')
      `).run(handlerFileId, caller.id);
      const callId = Number(callRes.lastInsertRowid);
      // route_id NULL — serviceLinksForHandler LEFT-JOINs routes, and the
      // protocol we assert on comes from service_links.protocol directly.
      raw.prepare(`
        INSERT INTO service_links
          (call_id, route_id, caller_symbol_id, handler_symbol_id, protocol,
           match_kind, confidence, evidence_json)
        VALUES (?, NULL, ?, ?, 'grpc', 'manual', 0.9, '{}')
      `).run(callId, caller.id, handler.id);

      const pf = await preflight(store, { symbol: 'loginHandler', workspace: REPO });
      assertEq(pf.ok, true, 'preflight ok=true for loginHandler');
      const grpcInbound = pf.serviceImpact.inbound.find(i => i.protocol === 'grpc');
      assert(grpcInbound != null,
        `inbound gRPC link reports protocol=grpc (got ${JSON.stringify(pf.serviceImpact.inbound.map(i => i.protocol))})`);
      assert(!pf.serviceImpact.inbound.some(i => i.protocol === 'http'),
        'no inbound link is mislabeled as http');
    }

    // ── Missing-symbol preflight does NOT crash ───────────────────────────
    console.log('\n── Missing-symbol preflight ──');
    const miss = await preflight(store, { symbol: 'doesNotExist', workspace: REPO });
    assertEq(miss.ok, false, 'preflight ok=false when symbol is missing');
    assert(miss.warnings.length >= 1, 'preflight returns a warning when symbol is missing');
    assertEq(miss.mode, 'symbol', 'mode=symbol on missing-symbol path');

    // ── Range-mode preflight (uncommitted changes touching validateToken) ─
    console.log('\n── Range-mode preflight ──');
    // Edit validateToken (uncommitted change).
    write('src/auth.ts', `
export function validateToken(token: string): boolean {
  // tightened: require non-empty AND minimum length of 12
  if (!token) return false;
  return token.length >= 12;
}

export function authenticate(req: { token: string }): boolean {
  return validateToken(req.token);
}
`.trimStart());

    const rr = await preflight(store, {
      range: true, workspace: REPO,
    });
    assertEq(rr.ok, true, 'range preflight ok=true');
    assertEq(rr.mode, 'range', 'mode=range');
    assert(rr.range != null, 'range metadata is present');
    assert(rr.touchedSymbols.length >= 1,
      `touchedSymbols contains the changed function (got ${rr.touchedSymbols.length})`);
    const touchedNames = rr.touchedSymbols.map(s => s.name);
    assert(touchedNames.includes('validateToken'),
      `touchedSymbols includes validateToken (got ${touchedNames.join(',')})`);
    assert(rr.likelyTests.length >= 1,
      'range preflight aggregates likelyTests from touched symbols');
    // The risk.perSymbol entry for validateToken must exist.
    const vt = rr.risk.perSymbol.find(p => p.symbol.name === 'validateToken');
    assert(vt != null, 'risk.perSymbol contains validateToken');

    // ── Output is bounded by maxSymbols / maxTests / maxHistory ───────────
    const bounded = await preflight(store, {
      range: true, workspace: REPO,
      maxSymbols: 1, maxTests: 1, maxHistory: 1,
    });
    assert(bounded.touchedSymbols.length <= 1, 'bounded touchedSymbols ≤ 1');
    assert(bounded.likelyTests.length <= 1, 'bounded likelyTests ≤ 1');
    assert(bounded.history.length <= 1, 'bounded history ≤ 1');

    // ── No-source-mutation invariant ─────────────────────────────────────
    // preflight should never call into write helpers — the simplest check is
    // that the on-disk auth.ts is still our (modified) content.
    const onDisk = fs.readFileSync(path.join(REPO, 'src/auth.ts'), 'utf8');
    assert(onDisk.includes('length >= 12'),
      'preflight did not mutate the source under test');
  } finally { store.close(); }
  void sha1;

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
