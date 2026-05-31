/**
 * SeerBench — service-link benchmark.
 *
 * Each task is a deterministic question over the fixtures-service workspace.
 * The runner indexes the fixtures once, then for each task computes:
 *   - actual:    the result returned by Seer-Core (no AI)
 *   - expected:  the JSON answer we hand-wrote per task
 *   - precision: |actual ∩ expected| / |actual|     (0 if actual empty when expected non-empty)
 *   - recall:    |actual ∩ expected| / |expected|
 *
 * The suite fails (exit 1) when:
 *   - precision < 0.9 OR recall < 0.9 on any task
 *   - latency over the full suite exceeds the cap (5s — generous for fixtures)
 *   - any task throws
 *
 * This is a tiny benchmark; its purpose is to catch regressions in the
 * service-link resolver (precision/recall drops) and to demonstrate that the
 * answers Seer produces for these specific questions are stable.
 *
 * Run: npx tsx tests/benchmark-service-links.ts
 */

import path from 'path';
import fs from 'fs';
import os from 'os';
import { Indexer } from '../src/indexer/index';
import { Store } from '../src/db/store';

const FIX = path.join(__dirname, 'fixtures-service');
const TMP = path.join(os.tmpdir(), `seer-bench-${Date.now()}`);
fs.mkdirSync(TMP, { recursive: true });
const DB = path.join(TMP, 'bench.db');

interface BenchTask {
  id: string;
  question: string;
  expected: Set<string>;     // set of expected answer items (e.g. handler qnames)
  run(store: Store): Set<string>;
}

const tasks: BenchTask[] = [
  {
    id: 'http-handler-for-checkout-charge',
    question: 'What handler receives the gateway service\'s POST /api/charge call?',
    expected: new Set(['chargeHandler']),
    run(store) {
      const rows = store.rawDb().prepare(
        `SELECT sh.qualified_name AS qn
           FROM service_links sl
           JOIN routes r        ON r.id  = sl.route_id
           JOIN service_calls sc ON sc.id = sl.call_id
           LEFT JOIN symbols sh ON sh.id = sl.handler_symbol_id
          WHERE r.path = '/api/charge' AND sc.method = 'POST'`,
      ).all() as Array<{ qn: string }>;
      return new Set(rows.map(r => r.qn).filter(Boolean));
    },
  },
  {
    id: 'trpc-handler-for-user-getbyid',
    question: 'Which handler receives the trpc.user.getById.query() call?',
    expected: new Set(['getUserById']),
    run(store) {
      const rows = store.rawDb().prepare(
        `SELECT sh.qualified_name AS qn
           FROM service_links sl
           JOIN service_calls sc ON sc.id = sl.call_id
           JOIN routes r        ON r.id  = sl.route_id
           LEFT JOIN symbols sh ON sh.id = sl.handler_symbol_id
          WHERE sl.protocol = 'trpc' AND r.operation = 'getById'`,
      ).all() as Array<{ qn: string }>;
      return new Set(rows.map(r => r.qn).filter(Boolean));
    },
  },
  {
    id: 'graphql-resolver-for-user-query',
    question: 'Which resolver receives the GraphQL "user" query operation?',
    expected: new Set(['userResolver']),
    run(store) {
      const rows = store.rawDb().prepare(
        `SELECT sh.qualified_name AS qn
           FROM service_links sl
           JOIN routes r        ON r.id  = sl.route_id
           LEFT JOIN symbols sh ON sh.id = sl.handler_symbol_id
          WHERE sl.protocol = 'graphql' AND r.operation = 'user'`,
      ).all() as Array<{ qn: string }>;
      return new Set(rows.map(r => r.qn).filter(Boolean));
    },
  },
  {
    id: 'grpc-method-for-userservice-getuser',
    question: 'Which gRPC rpc receives the UserService.GetUser client call?',
    expected: new Set(['UserService/GetUser']),
    run(store) {
      const rows = store.rawDb().prepare(
        `SELECT r.operation AS op
           FROM service_links sl
           JOIN routes r ON r.id = sl.route_id
          WHERE sl.protocol = 'grpc' AND r.operation = 'UserService/GetUser'`,
      ).all() as Array<{ op: string }>;
      return new Set(rows.map(r => r.op));
    },
  },
  {
    id: 'kafka-producers-for-orders-topic',
    question: 'Which functions publish to the Kafka "orders" topic?',
    expected: new Set(['produceOrders']),
    run(store) {
      const rows = store.rawDb().prepare(
        `SELECT s.qualified_name AS qn
           FROM service_calls sc
           LEFT JOIN symbols s ON s.id = sc.symbol_id
          WHERE sc.protocol = 'kafka' AND sc.topic = 'orders'`,
      ).all() as Array<{ qn: string }>;
      return new Set(rows.map(r => r.qn).filter(Boolean));
    },
  },
  {
    id: 'kafka-consumers-for-orders-topic',
    question: 'Which functions consume the Kafka "orders" topic?',
    expected: new Set(['subscribeOrders']),
    run(store) {
      // Consumers register a route; we want the file/symbol that calls
      // consumer.subscribe(...). We approximate by finding any symbol whose
      // qualified name matches the file's known consumer.
      const rows = store.rawDb().prepare(
        `SELECT s.qualified_name AS qn
           FROM routes r
           JOIN files f ON f.id = r.file_id
           JOIN symbols s ON s.file_id = r.file_id
                          AND s.line_start <= r.line
                          AND s.line_end >= r.line
          WHERE r.protocol = 'kafka' AND r.topic = 'orders'
            AND s.kind IN ('function','method')
          ORDER BY (r.line - s.line_start) ASC LIMIT 1`,
      ).all() as Array<{ qn: string }>;
      return new Set(rows.map(r => r.qn).filter(Boolean));
    },
  },
  {
    id: 'sqs-consumers-for-job-queue',
    question: 'Which consumers handle the "job-queue" SQS queue?',
    expected: new Set(['consumeJob']),
    run(store) {
      const rows = store.rawDb().prepare(
        `SELECT s.qualified_name AS qn
           FROM routes r
           JOIN files f ON f.id = r.file_id
           JOIN symbols s ON s.file_id = r.file_id
                          AND s.line_start <= r.line
                          AND s.line_end >= r.line
          WHERE r.protocol = 'sqs' AND r.queue = 'job-queue'
            AND s.kind IN ('function','method')
          ORDER BY (r.line - s.line_start) ASC LIMIT 1`,
      ).all() as Array<{ qn: string }>;
      return new Set(rows.map(r => r.qn).filter(Boolean));
    },
  },
  {
    id: 'service-host-link-payment',
    question: 'Which calls were classified as service_host matches via the payment-service k8s host?',
    expected: new Set(['paymentCall']),
    run(store) {
      const rows = store.rawDb().prepare(
        `SELECT sc.qualified_name AS qn
           FROM service_links sl
           JOIN service_calls c ON c.id = sl.call_id
           LEFT JOIN symbols sc ON sc.id = sl.caller_symbol_id
          WHERE sl.match_kind = 'service_host' AND c.host_hint = 'payment-service'`,
      ).all() as Array<{ qn: string }>;
      return new Set(rows.map(r => r.qn).filter(Boolean));
    },
  },
];

function intersect(a: Set<string>, b: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const x of a) if (b.has(x)) out.add(x);
  return out;
}

async function main(): Promise<void> {
  console.log('\nSeerBench — service-link benchmark');
  console.log('===================================\n');
  const startSetup = Date.now();
  const store = new Store(DB);
  await new Indexer(store).indexDirectory(FIX, { quiet: true });
  const setupMs = Date.now() - startSetup;
  console.log(`  setup: indexed fixtures-service in ${setupMs}ms\n`);

  let totalLatency = 0;
  let regressions = 0;
  let toolCalls = 0;
  let bytes = 0;

  for (const t of tasks) {
    const start = Date.now();
    let actual: Set<string> = new Set();
    let err: unknown = null;
    try { actual = t.run(store); } catch (e) { err = e; }
    const latency = Date.now() - start;
    totalLatency += latency;
    toolCalls += 1;
    const actualJson = JSON.stringify(Array.from(actual).sort());
    bytes += actualJson.length;
    const inter = intersect(actual, t.expected);
    const precision = actual.size === 0 ? (t.expected.size === 0 ? 1 : 0) : inter.size / actual.size;
    const recall    = t.expected.size === 0 ? 1 : inter.size / t.expected.size;
    const okPrec = precision >= 0.9;
    const okRec  = recall    >= 0.9;
    const mark = (okPrec && okRec && !err) ? '✓' : '✗';
    console.log(`  ${mark} [${t.id}]  precision=${precision.toFixed(2)} recall=${recall.toFixed(2)} latency=${latency}ms`);
    if (err) {
      console.log(`     ! threw: ${err}`);
      regressions++;
      continue;
    }
    if (!okPrec || !okRec) {
      console.log(`     expected=${JSON.stringify([...t.expected])} actual=${actualJson}`);
      regressions++;
    }
  }

  console.log(`\nSummary:`);
  console.log(`  tasks:           ${tasks.length}`);
  console.log(`  regressions:     ${regressions}`);
  console.log(`  total latency:   ${totalLatency}ms`);
  console.log(`  tool calls:      ${toolCalls}`);
  console.log(`  output bytes:    ${bytes}`);

  store.close();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ }

  // Latency cap: 5 seconds for the full suite over a tiny fixture set is
  // very generous; if we ever blow past it, something pathological has
  // happened in the resolver.
  if (totalLatency > 5000) {
    console.error(`✗ total latency ${totalLatency}ms > 5000ms cap`);
    process.exit(1);
  }
  if (regressions > 0) process.exit(1);
  console.log(`\n  ✓ all ${tasks.length} bench tasks within precision/recall ≥ 0.9`);
}

main().catch(err => { console.error('benchmark crashed:', err); process.exit(1); });
