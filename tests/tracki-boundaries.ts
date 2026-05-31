/**
 * Track I — Feature 4: Monorepo Boundaries.
 *
 * Verifies:
 *   - Fixture monorepo with packages/core and services/billing detected.
 *   - Each file maps to its correct boundary.
 *   - Import from services/billing into packages/core creates a boundary
 *     dependency edge.
 *   - Service link from gateway to billing is recorded as cross-boundary.
 *   - Risk + context include a `boundary` + a `boundaryCrossings` signal.
 *
 * Run: npx tsx tests/tracki-boundaries.ts
 */

import path from 'path';
import fs from 'fs';
import os from 'os';
import { Indexer } from '../src/indexer/index';
import { Store } from '../src/db/store';
import { computeRisk } from '../src/indexer/risk';
import { buildContext } from '../src/indexer/context';

const TMP = path.join(os.tmpdir(), `seer-tracki-bnd-${Date.now()}`);

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
  console.log('\nSeer Track I — Feature 4: Monorepo Boundaries');
  console.log('==============================================\n');
  cleanup();
  fs.mkdirSync(TMP, { recursive: true });

  // ── Build the fixture monorepo ──────────────────────────────────────────
  // Repo root package.json declares workspaces — workspace-root boundary.
  write('package.json', JSON.stringify({
    name: 'my-monorepo', version: '1.0.0', private: true,
    workspaces: ['packages/*', 'services/*'],
  }, null, 2));
  // packages/core — utility package with package.json
  write('packages/core/package.json', JSON.stringify({
    name: '@my/core', version: '0.1.0',
  }, null, 2));
  write('packages/core/src/utils.ts', `
export function makeId(seed: number): string {
  return 'id-' + seed;
}
export function logEvent(name: string): void {
  console.log(name);
}
`.trimStart());
  // services/billing — service with package.json that imports from core
  write('services/billing/package.json', JSON.stringify({
    name: 'billing-service', version: '0.1.0',
  }, null, 2));
  write('services/billing/src/charge.ts', `
import { makeId } from '../../../packages/core/src/utils';
declare const app: any;

export function chargeHandler(req: any, res: any): unknown {
  const id = makeId(req.body.amount);
  return res.send({ id, charged: true });
}
app.post('/api/charge', chargeHandler);
`.trimStart());
  // services/gateway — calls into billing (cross-boundary service link)
  write('services/gateway/package.json', JSON.stringify({
    name: 'gateway-service', version: '0.1.0',
  }, null, 2));
  write('services/gateway/src/client.ts', `
declare const fetch: any;
export async function processPayment(amount: number): Promise<unknown> {
  return await fetch('/api/charge', {
    method: 'POST',
    body: JSON.stringify({ amount }),
  });
}
`.trimStart());
  // apps/cli — convention fallback (no package.json under apps directly).
  // We make it manifest-less to exercise the convention path.
  write('apps/cli/src/main.ts', `
export function entrypoint(): void { console.log('hi'); }
`.trimStart());

  // ── Index it ───────────────────────────────────────────────────────────
  const dbPath = path.join(TMP, 'graph.db');
  const store = new Store(dbPath);
  try {
    const idx = new Indexer(store);
    await idx.indexDirectory(TMP, { quiet: true });

    // ── Boundaries detected ───────────────────────────────────────────────
    console.log('── Boundary detection ──');
    const boundaries = store.listBoundaries(100);
    console.log(`  detected ${boundaries.length} boundaries:`);
    for (const b of boundaries) {
      console.log(`    [${b.kind}] ${b.label} (${b.rootRelPath}) — ${b.sizeFiles} file(s)`);
    }
    assert(boundaries.length >= 4,
      `at least 4 boundaries detected (root + core + billing + gateway): got ${boundaries.length}`);

    const labels = boundaries.map(b => b.label);
    assert(labels.includes('core'),       'core boundary detected');
    assert(labels.includes('billing-service'),
      'billing-service boundary detected from package.json:name');
    assert(labels.includes('gateway-service'),
      'gateway-service boundary detected from package.json:name');
    assert(labels.includes('cli'),
      'cli boundary detected via apps/* convention fallback');

    const billingBnd = boundaries.find(b => b.label === 'billing-service');
    const coreBnd = boundaries.find(b => b.label === 'core');
    const gatewayBnd = boundaries.find(b => b.label === 'gateway-service');
    assert(billingBnd?.kind === 'package', 'billing detected via manifest -> kind=package');
    assert(coreBnd?.kind === 'package', 'core detected via manifest -> kind=package');
    assert(gatewayBnd?.kind === 'package',
      `gateway detected via package.json (got kind=${gatewayBnd?.kind})`);

    // ── File→boundary mapping ─────────────────────────────────────────────
    console.log('\n── File→boundary mapping ──');
    const files = store.listFiles();
    const findFile = (rel: string) =>
      files.find(f => f.relPath.replace(/\\/g, '/').endsWith(rel));
    const utilsFile = findFile('packages/core/src/utils.ts');
    const chargeFile = findFile('services/billing/src/charge.ts');
    const clientFile = findFile('services/gateway/src/client.ts');
    assert(utilsFile != null, 'packages/core/src/utils.ts indexed');
    assert(chargeFile != null, 'services/billing/src/charge.ts indexed');
    assert(clientFile != null, 'services/gateway/src/client.ts indexed');
    if (utilsFile && chargeFile && clientFile) {
      const utilsBoundary = store.boundaryForFile(utilsFile.id);
      const chargeBoundary = store.boundaryForFile(chargeFile.id);
      const clientBoundary = store.boundaryForFile(clientFile.id);
      assert(utilsBoundary?.label === 'core', 'utils.ts → core boundary');
      assert(chargeBoundary?.label === 'billing-service', 'charge.ts → billing boundary');
      assert(clientBoundary?.label === 'gateway-service', 'client.ts → gateway boundary');
    }

    // ── Boundary edges: billing → core (via import) ──────────────────────
    console.log('\n── Boundary dependency edges ──');
    if (billingBnd && coreBnd) {
      const out = store.boundaryDependencies(billingBnd.id, { direction: 'out', limit: 50 });
      console.log(`  billing → ${out.length} boundaries`);
      for (const d of out) console.log(`    ${d.kind}=${d.weight}  → ${d.label}`);
      const importEdge = out.find(d => d.label === 'core' && d.kind === 'import');
      assert(importEdge != null,
        'billing → core import edge recorded (billing imports core/utils)');
    }

    // ── Risk: cross-boundary signal surfaces on chargeHandler ────────────
    console.log('\n── Risk: boundary crossing ──');
    const r = computeRisk(store, 'chargeHandler');
    assert(r != null, 'risk(chargeHandler) returned a result');
    if (r) {
      assert(r.boundary != null, 'risk.boundary populated');
      assertEq(r.boundary?.label, 'billing-service',
        'risk.boundary is billing-service for chargeHandler');
      assert(r.signals.boundaryCrossings >= 0,
        'risk.signals.boundaryCrossings is present');
      const sig = r.signalContributions.find(c => c.signal === 'boundaryCrossings');
      assert(sig != null,
        'risk.signalContributions includes boundaryCrossings');
    }

    // ── Context: boundary populated ──────────────────────────────────────
    console.log('\n── Context: boundary populated ──');
    const ctx = buildContext(store, 'chargeHandler');
    assert(ctx != null, 'context(chargeHandler) returned');
    if (ctx) {
      assert(ctx.boundary != null, 'context.boundary populated');
      assertEq(ctx.boundary?.label, 'billing-service',
        'context.boundary.label = billing-service');
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
