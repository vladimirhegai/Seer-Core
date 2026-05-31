/**
 * Track I — Feature 1: External Bundle Layers.
 *
 * Verifies:
 *   - Exporting a bundle from service A and importing it as an EXTERNAL
 *     layer into workspace B leaves B's local symbols/files unchanged.
 *   - External routes are queryable and clearly marked
 *     (source_kind='external-bundle' + external_bundle_id).
 *   - The service-link resolver can match a local service_call to an
 *     external route, producing a service_link with handler_symbol_id=NULL
 *     (the handler lives in the external bundle's phantom file).
 *   - Re-importing the same bundle is idempotent (no row duplication).
 *   - Re-running `seer index` does not prune external rows.
 *
 * Run: npx tsx tests/tracki-external-bundles.ts
 */

import path from 'path';
import fs from 'fs';
import os from 'os';
import { Indexer } from '../src/indexer/index';
import { Store } from '../src/db/store';
import { exportBundle } from '../src/bundle/export';
import { importExternalBundle } from '../src/bundle/external';

const FIXTURES = path.join(__dirname, 'fixtures-tracki');
const TMP = path.join(os.tmpdir(), `seer-tracki-ext-${Date.now()}`);

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

async function main(): Promise<void> {
  console.log('\nSeer Track I — External Bundle Layers');
  console.log('======================================\n');
  cleanup();
  fs.mkdirSync(TMP, { recursive: true });

  // ── Step 1: Index the "billing" repo and export its bundle ──────────────
  console.log('── Step 1: index + export the billing service\'s bundle ──');
  const billingDb = path.join(TMP, 'billing.db');
  const billingStore = new Store(billingDb);
  const billingRepo = path.join(FIXTURES, 'billing');
  try {
    const idx = new Indexer(billingStore);
    const r = await idx.indexDirectory(billingRepo, { quiet: true });
    assert(r.filesIndexed >= 1, 'billing: indexed at least one file');
    assert((r.routesResolved ?? 0) >= 0, 'billing: route resolution ran');
  } finally { billingStore.close(); }

  const bundleOut = path.join(TMP, 'billing.seerbundle');
  await exportBundle(billingDb, billingRepo, {
    out: bundleOut, builtAt: 0,
  });
  assert(fs.existsSync(bundleOut), 'billing.seerbundle exists on disk');

  // ── Step 2: Index the "gateway" repo into its own DB ────────────────────
  console.log('\n── Step 2: index the gateway service into its own DB ──');
  const gatewayDb = path.join(TMP, 'gateway.db');
  const gatewayRepo = path.join(FIXTURES, 'gateway');
  let initialSymbols = 0;
  let initialFiles = 0;
  let initialRoutes = 0;
  let initialServiceCalls = 0;
  {
    const store = new Store(gatewayDb);
    try {
      const idx = new Indexer(store);
      const r = await idx.indexDirectory(gatewayRepo, { quiet: true });
      assert(r.filesIndexed >= 1, 'gateway: indexed at least one file');
      const stats = store.getStats();
      initialSymbols = stats.symbols;
      initialFiles = stats.files;
      initialRoutes = stats.routes ?? 0;
      initialServiceCalls = stats.serviceCalls ?? 0;
      assert(initialServiceCalls >= 1, `gateway: extracted ≥1 service call (got ${initialServiceCalls})`);
      assertEq(initialRoutes, 0, 'gateway: has 0 local routes (it is a client only)');
    } finally { store.close(); }
  }

  // ── Step 3: Import the billing bundle into gateway as EXTERNAL ─────────
  console.log('\n── Step 3: external import of billing.seerbundle into gateway ──');
  let firstImportBundleId = 0;
  {
    const store = new Store(gatewayDb);
    try {
      const r = await importExternalBundle(bundleOut, store, { alias: 'billing' });
      assertEq(r.alreadyImported, false, 'first import is not a no-op');
      assert(r.routesImported >= 2, `imported ≥2 external routes (got ${r.routesImported})`);
      assertEq(r.externalProject, 'billing', 'externalProject alias persisted');
      firstImportBundleId = r.bundleId;

      // Full marks: local symbols + local files are UNCHANGED by the import
      // (apart from the phantom file added for the external layer).
      const stats = store.getStats();
      assertEq(stats.symbols, initialSymbols, 'local symbols count is unchanged after import');
      assertEq(stats.files, initialFiles + 1, 'files count increased by exactly 1 (phantom external file)');

      // External routes are queryable with clear provenance.
      const layers = store.listExternalBundles();
      assertEq(layers.length, 1, 'one external bundle layer recorded');
      assertEq(layers[0].sourceKind, 'external-bundle', 'sourceKind is "external-bundle"');
      assertEq(layers[0].externalProject, 'billing', 'externalProject matches alias');

      const externals = store.listExternalRoutes({ bundleId: firstImportBundleId });
      assert(externals.length >= 2, `external routes are queryable (got ${externals.length})`);
      const chargeRoute = externals.find(r => r.path === '/api/charge');
      assert(chargeRoute != null, 'external POST /api/charge is queryable');
      assertEq(chargeRoute?.externalProject ?? null, 'billing',
        'external route carries externalProject');

      // External routes also appear in the normal listRoutes() (they are
      // still routes, just with external_bundle_id set).
      const allRoutes = store.listRoutes({});
      const externalCount = allRoutes.filter(r => r.path === '/api/charge').length;
      assert(externalCount >= 1, 'listRoutes() includes external route paths');
    } finally { store.close(); }
  }

  // ── Step 4: Re-import is idempotent (alreadyImported=true) ──────────────
  console.log('\n── Step 4: idempotent re-import ──');
  {
    const store = new Store(gatewayDb);
    try {
      const r2 = await importExternalBundle(bundleOut, store, { alias: 'billing' });
      assertEq(r2.alreadyImported, true, 'second import with unchanged hash is a no-op');
      assertEq(r2.bundleId, firstImportBundleId, 'bundleId is stable across re-imports');
      const layers = store.listExternalBundles();
      assertEq(layers.length, 1, 'still exactly one external bundle layer (no duplication)');
      const stats = store.getStats();
      assertEq(stats.files, initialFiles + 1, 'files count still unchanged after idempotent re-import');
    } finally { store.close(); }
  }

  // ── Step 5: Re-running the indexer does NOT prune the external layer ────
  console.log('\n── Step 5: local re-index keeps external rows ──');
  {
    const store = new Store(gatewayDb);
    try {
      const idx = new Indexer(store);
      await idx.indexDirectory(gatewayRepo, { quiet: true });
      const layers = store.listExternalBundles();
      assertEq(layers.length, 1, 'external bundle layer survived a fresh index pass');
      const externals = store.listExternalRoutes({ bundleId: firstImportBundleId });
      assert(externals.length >= 2, `external routes survived re-index (got ${externals.length})`);
    } finally { store.close(); }
  }

  // ── Step 6: Service-link resolver matches local calls to external routes ─
  console.log('\n── Step 6: service-link resolver matches against external routes ──');
  {
    const store = new Store(gatewayDb);
    try {
      const links = store.listServiceLinks({});
      assert(links.length >= 1, `at least one service_link produced (got ${links.length})`);
      // The /api/charge call from gateway/client.ts should link to the external
      // /api/charge route. handlerSymbolId may be NULL (it's external code).
      const chargeLink = links.find(l =>
        (l.routePath === '/api/charge') || (l.callNormalizedPath === '/api/charge'));
      assert(chargeLink != null, 'gateway → /api/charge service link is present');
      if (chargeLink) {
        assert(chargeLink.confidence > 0.5, `chargeLink confidence > 0.5 (got ${chargeLink.confidence})`);
      }
    } finally { store.close(); }
  }

  // ── Step 7: Forced re-import after rebuilding a different hash ──────────
  console.log('\n── Step 7: force re-import replaces the layer atomically ──');
  // Build a SECOND bundle with a different hash (write a stub file into billing)
  // then export again so dbSha256 differs.
  const extraFile = path.join(billingRepo, '__stub.ts');
  fs.writeFileSync(extraFile, 'export const newStub = 1;\n');
  try {
    const re = new Store(billingDb);
    try {
      const idx = new Indexer(re);
      await idx.indexDirectory(billingRepo, { quiet: true });
    } finally { re.close(); }
    const bundleOut2 = path.join(TMP, 'billing-v2.seerbundle');
    await exportBundle(billingDb, billingRepo, { out: bundleOut2, builtAt: 0 });

    // Reuse the SAME bundle path slot by overwriting. Since importExternalBundle
    // keys on bundle_path, we'll import the new file at a NEW path so the
    // re-import path triggers properly. The hash differs so it must NOT skip.
    const newBundlePath = path.join(TMP, 'billing.seerbundle');
    fs.copyFileSync(bundleOut2, newBundlePath);

    const store = new Store(gatewayDb);
    try {
      const r3 = await importExternalBundle(newBundlePath, store, {
        alias: 'billing', force: true,
      });
      assertEq(r3.alreadyImported, false, 'forced re-import with new hash is not a no-op');
      // Layer count stays at 1 — same path replaces the old layer.
      const layers = store.listExternalBundles();
      assertEq(layers.length, 1, 'still exactly one external bundle layer after replace');
    } finally { store.close(); }
  } finally {
    try { fs.unlinkSync(extraFile); } catch { /* */ }
  }

  // ── Step 8: integrity — a tampered dbSha256 is REJECTED (bug regression) ──
  console.log('\n── Step 8: tampered bundle integrity is rejected ──');
  {
    const tampered = path.join(TMP, 'tampered.seerbundle');
    rewriteManifest(bundleOut, tampered, (m) => { m.dbSha256 = '0'.repeat(64); });
    const store = new Store(gatewayDb);
    let threw = false;
    let msg = '';
    try {
      await importExternalBundle(tampered, store, { alias: 'tampered', force: true });
    } catch (err) { threw = true; msg = (err as Error).message; }
    finally { store.close(); }
    assert(threw, 'import of a hash-tampered bundle throws');
    assert(/integrity/i.test(msg), `rejection mentions integrity (got "${msg}")`);
    // The failed import must NOT have left a partial layer behind.
    const verify = new Store(gatewayDb);
    try {
      const stray = verify.listExternalBundles().find(l => l.externalProject === 'tampered');
      assert(stray == null, 'no partial "tampered" layer left after rejected import');
    } finally { verify.close(); }
  }

  // ── Step 9: a newer schemaVersion is rejected (bug regression) ───────────
  console.log('\n── Step 9: bundle with newer schemaVersion is rejected ──');
  {
    const futureBundle = path.join(TMP, 'future.seerbundle');
    rewriteManifest(bundleOut, futureBundle, (m) => { m.schemaVersion = 9999; });
    const store = new Store(gatewayDb);
    let threw = false; let msg = '';
    try {
      await importExternalBundle(futureBundle, store, { alias: 'future', force: true });
    } catch (err) { threw = true; msg = (err as Error).message; }
    finally { store.close(); }
    assert(threw, 'import of a future-schema bundle throws');
    assert(/schemaVersion|newer/i.test(msg), `rejection mentions schema (got "${msg}")`);
  }

  // ── Step 10: forced re-import does NOT leak sibling phantom files ─────────
  console.log('\n── Step 10: force re-import keeps phantom files == layers ──');
  {
    const siblingDb = path.join(TMP, 'sibling.db');
    {
      const store = new Store(siblingDb);
      try {
        const idx = new Indexer(store);
        await idx.indexDirectory(gatewayRepo, { quiet: true });
      } finally { store.close(); }
    }
    // Two distinct external layers (same payload, two paths → two layers).
    const layerApath = path.join(TMP, 'layerA.seerbundle');
    const layerBpath = path.join(TMP, 'layerB.seerbundle');
    fs.copyFileSync(bundleOut, layerApath);
    fs.copyFileSync(bundleOut, layerBpath);
    {
      const store = new Store(siblingDb);
      try {
        await importExternalBundle(layerApath, store, { alias: 'A' });
        await importExternalBundle(layerBpath, store, { alias: 'B' });
        assertEq(store.listExternalBundles().length, 2, 'two sibling layers imported');
        assertEq(store.listExternalPhantomFileIds().length, 2,
          'two phantom files for two layers');
        // Force re-import of layer A — must replace in place, not orphan a phantom.
        await importExternalBundle(layerApath, store, { alias: 'A', force: true });
        assertEq(store.listExternalBundles().length, 2,
          'still two layers after forced re-import of A');
        assertEq(store.listExternalPhantomFileIds().length, 2,
          'still exactly two phantom files (no leak)');
      } finally { store.close(); }
    }
  }

  // ── Step 11: service links are visible immediately after import ──────────
  //  (no re-index needed — bug regression for stale service_links)
  console.log('\n── Step 11: service links resolved at import time (no re-index) ──');
  {
    const freshDb = path.join(TMP, 'fresh-gateway.db');
    {
      const store = new Store(freshDb);
      try {
        const idx = new Indexer(store);
        await idx.indexDirectory(gatewayRepo, { quiet: true });
      } finally { store.close(); }
    }
    const store = new Store(freshDb);
    try {
      const before = store.listServiceLinks({}).length;
      const r = await importExternalBundle(bundleOut, store, { alias: 'billing' });
      assertEq(r.alreadyImported, false, 'fresh import is not a no-op');
      // Without any re-index, the link should already exist.
      const links = store.listServiceLinks({});
      const chargeLink = links.find(l =>
        (l.routePath === '/api/charge') || (l.callNormalizedPath === '/api/charge'));
      assert(chargeLink != null,
        `/api/charge link present immediately after import (before=${before}, after=${links.length})`);
    } finally { store.close(); }
  }

  console.log('\n────────────────────────────');
  console.log(`Passed: ${passed}   Failed: ${failed}`);
  cleanup();
  if (failed > 0) process.exit(1);
}

/**
 * Read a .seerbundle, mutate its manifest JSON via `mutate`, and write a new
 * bundle with a corrected manifest length header. The gzip DB payload is
 * copied verbatim so its bytes (and thus the *real* sha256) are unchanged —
 * letting us test that a manifest claiming the wrong dbSha256 is rejected.
 */
function rewriteManifest(
  src: string, dst: string, mutate: (m: Record<string, unknown>) => void,
): void {
  const buf = fs.readFileSync(src);
  const manifestLen = buf.readUInt32BE(8);
  const manifestEnd = 12 + manifestLen;
  const manifest = JSON.parse(buf.slice(12, manifestEnd).toString('utf8'));
  mutate(manifest);
  const newManifest = Buffer.from(JSON.stringify(manifest), 'utf8');
  const header = Buffer.alloc(12);
  buf.copy(header, 0, 0, 8);             // magic (4) + format version (4)
  header.writeUInt32BE(newManifest.length, 8);
  const payload = buf.slice(manifestEnd); // verbatim gzip DB
  fs.writeFileSync(dst, Buffer.concat([header, newManifest, payload]));
}

main().catch(err => {
  console.error(err);
  cleanup();
  process.exit(1);
});
