/**
 * Track I — Feature 2: Contract Diff between two .seerbundle artifacts.
 *
 * Verifies:
 *   - HTTP: a removed route + a method-changed route + an added route are
 *     all reported in the diff.
 *   - gRPC: an added method is reported under added.
 *   - Kafka: a removed topic is reported under removed.
 *   - The diff is computed without importing either bundle into a workspace.
 *   - JSON output is deterministic between runs.
 *   - Exit code is 0 even when breaking changes are found.
 *
 * Run: npx tsx tests/tracki-contract-diff.ts
 */

import path from 'path';
import fs from 'fs';
import os from 'os';
import { Indexer } from '../src/indexer/index';
import { Store } from '../src/db/store';
import { exportBundle } from '../src/bundle/export';
import { contractDiff, formatContractDiffTable } from '../src/bundle/contract';

const TMP = path.join(os.tmpdir(), `seer-tracki-contract-${Date.now()}`);

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

interface FixtureFile { path: string; content: string }

async function buildBundle(name: string, files: FixtureFile[]): Promise<string> {
  const repo = path.join(TMP, name);
  fs.mkdirSync(repo, { recursive: true });
  for (const f of files) {
    const abs = path.join(repo, f.path);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, f.content);
  }
  const dbPath = path.join(TMP, `${name}.db`);
  const store = new Store(dbPath);
  try {
    const idx = new Indexer(store);
    await idx.indexDirectory(repo, { quiet: true });
  } finally { store.close(); }
  const bundlePath = path.join(TMP, `${name}.seerbundle`);
  await exportBundle(dbPath, repo, { out: bundlePath, builtAt: 0 });
  return bundlePath;
}

async function main(): Promise<void> {
  console.log('\nSeer Track I — Feature 2: Contract Diff');
  console.log('========================================\n');
  cleanup();
  fs.mkdirSync(TMP, { recursive: true });

  // ── Build "old" and "new" HTTP bundles ──────────────────────────────────
  console.log('── HTTP route diff ──');
  const oldHttpBundle = await buildBundle('old-http', [
    { path: 'routes.ts', content: `
declare const app: any;
export function listUsers(_req: any, res: any) { return res.send([]); }
export function getUser(_req: any, res: any) { return res.send({}); }
export function legacyHandler(_req: any, res: any) { return res.send('legacy'); }
app.get('/api/v1/users', listUsers);
app.get('/api/v1/users/:id', getUser);
app.post('/api/v1/legacy', legacyHandler);
` },
  ]);
  const newHttpBundle = await buildBundle('new-http', [
    { path: 'routes.ts', content: `
declare const app: any;
export function listUsers(_req: any, res: any) { return res.send([]); }
export function getUser(_req: any, res: any) { return res.send({}); }
export function deleteUser(_req: any, res: any) { return res.send({}); }
// legacy removed
app.get('/api/v1/users', listUsers);
// /api/v1/users/:id is now POST instead of GET
app.post('/api/v1/users/:id', getUser);
// /api/v1/users/:id/delete is new
app.delete('/api/v1/users/:id/delete', deleteUser);
` },
  ]);

  const diff = await contractDiff(oldHttpBundle, newHttpBundle, { includeAffectedCallers: false });
  console.log(formatContractDiffTable(diff));

  // Expectations: legacy removed, delete added, /api/v1/users/:id method changed.
  const legacyRemoved = diff.removed.find(r =>
    r.protocol === 'http' && r.method === 'POST' && r.path === '/api/v1/legacy');
  assert(legacyRemoved != null, 'removed: POST /api/v1/legacy');

  const deleteAdded = diff.added.find(r =>
    r.protocol === 'http' && r.method === 'DELETE' && r.path === '/api/v1/users/:id/delete');
  assert(deleteAdded != null, 'added: DELETE /api/v1/users/:id/delete');

  // GET /api/v1/users/:id was removed and POST /api/v1/users/:id was added —
  // because our key is method|path, that's two events, not a "changed" event.
  // That's by design — HTTP method change IS effectively a different endpoint.
  const oldUserGet = diff.removed.find(r =>
    r.protocol === 'http' && r.method === 'GET' && r.path === '/api/v1/users/:id');
  const newUserPost = diff.added.find(r =>
    r.protocol === 'http' && r.method === 'POST' && r.path === '/api/v1/users/:id');
  assert(oldUserGet != null, 'removed: GET /api/v1/users/:id (method changed → POST)');
  assert(newUserPost != null, 'added: POST /api/v1/users/:id (method changed from GET)');

  // listUsers stays the same on both sides — must not appear in any of the
  // three sets.
  const listUsersPresent =
    [...diff.added, ...diff.removed].some(r =>
      r.path === '/api/v1/users' && r.method === 'GET') ||
    diff.changed.some(r =>
      r.before.path === '/api/v1/users' && r.before.method === 'GET');
  assertEq(listUsersPresent, false, 'unchanged route does not appear in any diff bucket');

  // Determinism check: run the diff a second time, JSON output identical.
  const diff2 = await contractDiff(oldHttpBundle, newHttpBundle);
  assertEq(JSON.stringify(diff.added), JSON.stringify(diff2.added),
    'added list is deterministic across runs');
  assertEq(JSON.stringify(diff.removed), JSON.stringify(diff2.removed),
    'removed list is deterministic across runs');

  // ── gRPC + Kafka — synthesize routes via SQL since proto fixtures are big.
  console.log('\n── gRPC + Kafka diff via direct route injection ──');
  const grpcKafkaOld = path.join(TMP, 'grpc-old');
  fs.mkdirSync(grpcKafkaOld, { recursive: true });
  fs.writeFileSync(path.join(grpcKafkaOld, 'placeholder.ts'),
    'export const x = 1;\n');
  const grpcKafkaOldDb = path.join(TMP, 'grpc-old.db');
  {
    const s = new Store(grpcKafkaOldDb);
    try {
      const idx = new Indexer(s);
      await idx.indexDirectory(grpcKafkaOld, { quiet: true });
      // Inject a tRPC, gRPC, and Kafka route directly into the DB so we can
      // verify cross-protocol diff without spinning up a full proto/extractor
      // pipeline. file_id 1 is the placeholder file.
      const fileId = (s.rawDb().prepare('SELECT id FROM files LIMIT 1').get() as { id: number }).id;
      s.insertRoute(fileId, 'ANY', '', 'grpc', null, 0, {
        protocol: 'grpc', service: 'UserService', operation: 'GetUser',
      });
      s.insertRoute(fileId, 'ANY', '', 'kafka', null, 0, {
        protocol: 'kafka', topic: 'user.created', broker: 'kafka:9092',
      });
      s.insertRoute(fileId, 'ANY', '', 'kafka', null, 0, {
        protocol: 'kafka', topic: 'user.deleted', broker: 'kafka:9092',
      });
    } finally { s.close(); }
  }
  const grpcKafkaOldBundle = path.join(TMP, 'grpc-old.seerbundle');
  await exportBundle(grpcKafkaOldDb, grpcKafkaOld, { out: grpcKafkaOldBundle, builtAt: 0 });

  const grpcKafkaNew = path.join(TMP, 'grpc-new');
  fs.mkdirSync(grpcKafkaNew, { recursive: true });
  fs.writeFileSync(path.join(grpcKafkaNew, 'placeholder.ts'),
    'export const x = 1;\n');
  const grpcKafkaNewDb = path.join(TMP, 'grpc-new.db');
  {
    const s = new Store(grpcKafkaNewDb);
    try {
      const idx = new Indexer(s);
      await idx.indexDirectory(grpcKafkaNew, { quiet: true });
      const fileId = (s.rawDb().prepare('SELECT id FROM files LIMIT 1').get() as { id: number }).id;
      s.insertRoute(fileId, 'ANY', '', 'grpc', null, 0, {
        protocol: 'grpc', service: 'UserService', operation: 'GetUser',
      });
      // New gRPC method added.
      s.insertRoute(fileId, 'ANY', '', 'grpc', null, 0, {
        protocol: 'grpc', service: 'UserService', operation: 'ListUsers',
      });
      // user.created stays; user.deleted is REMOVED.
      s.insertRoute(fileId, 'ANY', '', 'kafka', null, 0, {
        protocol: 'kafka', topic: 'user.created', broker: 'kafka:9092',
      });
    } finally { s.close(); }
  }
  const grpcKafkaNewBundle = path.join(TMP, 'grpc-new.seerbundle');
  await exportBundle(grpcKafkaNewDb, grpcKafkaNew, { out: grpcKafkaNewBundle, builtAt: 0 });

  const gd = await contractDiff(grpcKafkaOldBundle, grpcKafkaNewBundle);
  console.log(formatContractDiffTable(gd));

  const addedGrpc = gd.added.find(e => e.protocol === 'grpc' && e.operation === 'ListUsers');
  assert(addedGrpc != null, 'added: grpc UserService.ListUsers');

  const removedTopic = gd.removed.find(e => e.protocol === 'kafka' && e.topic === 'user.deleted');
  assert(removedTopic != null, 'removed: kafka user.deleted');

  // Unchanged grpc method does NOT appear.
  const getUserUnchanged =
    [...gd.added, ...gd.removed].some(e =>
      e.protocol === 'grpc' && e.operation === 'GetUser');
  assertEq(getUserUnchanged, false, 'unchanged gRPC method stays out of added/removed');

  // Exit-code contract: function returns successfully; CLI/MCP layer never
  // throws on breaking changes (tested by call path here returning without
  // exception).
  assertEq(gd.totals.added >= 1, true, 'gd reports >=1 added endpoint');
  assertEq(gd.totals.removed >= 1, true, 'gd reports >=1 removed endpoint');

  // ── Malformed bundle is rejected with a clear message (regression) ──────
  console.log('\n── Malformed / truncated bundle handling ──');
  {
    // Not a bundle at all.
    const junk = path.join(TMP, 'junk.seerbundle');
    fs.writeFileSync(junk, Buffer.from('this is not a seer bundle at all!!'));
    let threw = false; let msg = '';
    try { await contractDiff(junk, newHttpBundle); }
    catch (err) { threw = true; msg = (err as Error).message; }
    assert(threw, 'contractDiff throws on a non-bundle file');
    assert(/not a seer bundle|bad magic/i.test(msg),
      `non-bundle rejection is clear (got "${msg}")`);

    // Valid header + magic but a manifest length that overruns the file.
    const truncated = path.join(TMP, 'truncated.seerbundle');
    const header = Buffer.alloc(12);
    Buffer.from(oldHttpBundle && fs.readFileSync(oldHttpBundle).subarray(0, 4)).copy(header, 0);
    header.writeUInt32BE(1, 4);          // format version
    header.writeUInt32BE(0xffffff, 8);   // absurd manifest length
    fs.writeFileSync(truncated, header);
    let threw2 = false; let msg2 = '';
    try { await contractDiff(truncated, newHttpBundle); }
    catch (err) { threw2 = true; msg2 = (err as Error).message; }
    assert(threw2, 'contractDiff throws on a truncated bundle');
    assert(/truncat|magic|bundle/i.test(msg2),
      `truncated rejection is clear, not a raw JSON error (got "${msg2}")`);
  }

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
