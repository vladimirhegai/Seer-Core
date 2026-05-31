/**
 * Track G — service-link resolver and helpers.
 *
 * Two concerns live here, kept independent so they can be unit-tested in
 * isolation:
 *
 *   1. `normalizeHttpTarget(raw)` — turn a string captured at a client call
 *      site (literal URL, template path, env-prefixed concat) into a
 *      `{ path, hostHint, envKey }` triple where each field is undefined when
 *      it can't be confidently recovered. Pure function; no DB access.
 *
 *   2. `routePatternsMatch(callPath, routePath)` — decide whether a literal
 *      caller path matches a (possibly parameterised) framework route.
 *      Returns a `{ matched, confidence, reason }` result so the resolver
 *      can ranke evidence without recomputing it.
 *
 *   3. `resolveServiceLinks(store)` — the actual post-index resolver.
 *      Wipes prior service_links, scans service_calls + routes, and inserts
 *      one row per confident rendezvous.
 *
 * Deterministic by construction: the resolver runs candidates in id order
 * and only emits a top match (with ambiguity recorded as evidence) so two
 * runs of the same DB produce the same service_links rows.
 */

import type { Store } from '../db/store.js';
import type { ServiceHostMap } from './serviceHostScanner.js';

export type MatchKind =
  | 'literal_path'
  | 'env_base'
  | 'service_host'
  | 'route_pattern'
  // v9 Track-H additions
  | 'trpc_procedure'
  | 'graphql_operation'
  | 'grpc_method'
  | 'topic_match'
  | 'queue_match'
  | 'exchange_match';

export interface NormalizedTarget {
  /** /api/users — leading slash, no scheme, no query, no fragment, no trailing slash (except "/"). */
  path?: string;
  /** payment-service / billing.svc.cluster.local / etc. */
  hostHint?: string;
  /** PAYMENT_URL — populated by the extractor when it saw env reference. */
  envKey?: string;
}

/**
 * Normalize an HTTP target captured at a client call site.
 *
 * Rules:
 *   - strip scheme + host when literal (`https://payment/api/charge` → `/api/charge`, host = `payment`)
 *   - keep route paths starting with '/'
 *   - drop query string and fragment
 *   - normalize trailing slash (but keep root '/'): '/api/users/' → '/api/users'
 *   - drop empty paths
 *   - do NOT collapse dynamic segments — that's the route-pattern matcher's job.
 */
export function normalizeHttpTarget(raw: string): NormalizedTarget {
  if (!raw || typeof raw !== 'string') return {};
  let s = raw.trim();
  if (!s) return {};

  let hostHint: string | undefined;

  // Strip scheme + host if present.
  const schemeMatch = s.match(/^(https?):\/\/([^/?#]+)(.*)$/i);
  if (schemeMatch) {
    hostHint = schemeMatch[2];
    s = schemeMatch[3] || '/';
  } else if (/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9_./%-]+/.test(s) && !s.startsWith('/')) {
    // Bare host/path with no scheme (rare but seen in some libs).
    const firstSlash = s.indexOf('/');
    if (firstSlash > 0) {
      hostHint = s.slice(0, firstSlash);
      s = s.slice(firstSlash);
    }
  }

  // Strip query + fragment.
  const q = s.indexOf('?');
  if (q >= 0) s = s.slice(0, q);
  const h = s.indexOf('#');
  if (h >= 0) s = s.slice(0, h);

  // Trailing slash normalization (keep root).
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);

  let path: string | undefined;
  if (s.startsWith('/')) path = s;

  const out: NormalizedTarget = {};
  if (path) out.path = path;
  if (hostHint) out.hostHint = hostHint;
  return out;
}

export interface PatternMatch {
  matched: boolean;
  /** 1.0 for exact path+method, 0.95 path only, 0.85 parameterised */
  confidence: number;
  /** Human-readable why; surfaced in evidence_json. */
  reason: string;
}

/**
 * Decide whether `callPath` (literal) satisfies a (possibly parameterised)
 * `routePath` like `/users/:id`, `/users/{id}`, `/items/<int:n>`.
 *
 * No method check here — the resolver applies method comparison around this
 * with method-mismatch falling back to a lower confidence.
 *
 * Returns matched=false when the segment count differs OR a literal segment
 * differs. Parameter segments (`:x`, `{x}`, `<...:x>`) match any one segment.
 */
export function routePatternsMatch(callPath: string, routePath: string): PatternMatch {
  if (!callPath || !routePath) return { matched: false, confidence: 0, reason: 'empty' };
  // Exact literal match.
  if (callPath === routePath) {
    return { matched: true, confidence: 0.95, reason: 'literal_path' };
  }
  const callSegs = callPath.split('/').filter(Boolean);
  const routeSegs = routePath.split('/').filter(Boolean);
  if (callSegs.length !== routeSegs.length) {
    return { matched: false, confidence: 0, reason: 'segment_count' };
  }
  let paramHits = 0;
  for (let i = 0; i < callSegs.length; i++) {
    const r = routeSegs[i];
    const c = callSegs[i];
    if (isParamSegment(r)) { paramHits++; continue; }
    if (r !== c) return { matched: false, confidence: 0, reason: 'segment_mismatch' };
  }
  if (paramHits === 0) {
    // Same literal segment count but no params — earlier exact check should
    // have caught this. Treat as no match so we don't accidentally rank
    // /a/b == /a/b twice.
    return { matched: false, confidence: 0, reason: 'duplicate_literal' };
  }
  return { matched: true, confidence: 0.85, reason: 'route_pattern' };
}

function isParamSegment(seg: string): boolean {
  // Express :id, FastAPI {id}, Spring {id}, Flask <int:id>
  if (seg.startsWith(':')) return true;
  if (seg.startsWith('{') && seg.endsWith('}')) return true;
  if (seg.startsWith('<') && seg.endsWith('>')) return true;
  return false;
}

/**
 * Compare two HTTP methods, treating 'ANY' (client unknown method) and route's
 * absence of method as wildcards. Returns:
 *   1.0 — methods match exactly (including both 'ANY')
 *   0.9 — caller method known + route is ANY (or vice versa)
 *   0.0 — explicit mismatch (e.g. POST vs GET)
 */
export function methodMatchScore(callMethod: string | null | undefined,
                                 routeMethod: string | null | undefined): number {
  const cm = (callMethod ?? 'ANY').toUpperCase();
  const rm = (routeMethod ?? 'ANY').toUpperCase();
  if (cm === rm) return 1.0;
  if (cm === 'ANY' || rm === 'ANY') return 0.9;
  return 0.0;
}

// ── Resolver ────────────────────────────────────────────────────────────────

/** Result returned by resolveServiceLinks. */
export interface ResolveResult {
  /** Total service_calls considered (after dropping ones with no path). */
  callsConsidered: number;
  /** New service_links rows inserted. */
  linksInserted: number;
  /** Counts by match_kind. */
  byKind: Record<MatchKind, number>;
  /** v9 Track-H — number of calls whose candidate set was truncated at the
   *  ambiguity cap. Surfaced for telemetry / debug. */
  truncated?: number;
}

// v9 Track-H — hard cap on how many candidate routes we consider for a single
// service_call. A symbol with 25+ matching routes is almost always ambiguous
// (think a generic /users/:id route in 30 microservices); we keep determinism
// by sorting first and then truncating, and record `truncated: true` in the
// link's evidence so the agent can see the cutoff happened.
const MAX_CANDIDATES_PER_CALL = 25;
// Cap on how many candidates we serialize into evidence_json. Smaller than the
// cap above so a link row stays compact even when many routes matched.
const MAX_EVIDENCE_CANDIDATES = 5;

/**
 * Wipe service_links and rebuild from current service_calls + routes.
 * Deterministic: orders candidates by id ascending and ties are broken by id.
 *
 * Match strategy:
 *   1. literal_path  — call.path == route.path, method compatible
 *   2. route_pattern — call.path matches a parameterised route, method compatible
 *   3. env_base      — call carried an env key; we record the link only when
 *                      the path *also* matches a route (env alone is not enough).
 *
 * S3 (service_host) — k8s/Docker host resolution — is provided by
 * `scanServiceHosts()` and passed in as optional evidence.
 */
export function resolveServiceLinks(store: Store, options: { hostMap?: ServiceHostMap } = {}): ResolveResult {
  const raw = store.rawDb();
  raw.exec('DELETE FROM service_links');

  type CallRow = {
    id: number; symbol_id: number | null;
    protocol: string; method: string | null;
    raw_target: string; normalized_path: string | null;
    host_hint: string | null; env_key: string | null;
    framework: string;
    operation: string | null;
    topic: string | null; queue: string | null;
    service: string | null;
  };
  // v9: detect whether the v9 generalized columns exist. listServiceCalls
  // reads them but we use a raw SELECT here for speed.
  const hasV9Cols = hasColumn(raw, 'service_calls', 'operation');
  const v9Cols = hasV9Cols ? ', operation, topic, queue, service' : '';
  const calls = raw.prepare(
    `SELECT id, symbol_id, protocol, method, raw_target, normalized_path,
            host_hint, env_key, framework ${v9Cols}
       FROM service_calls
      ORDER BY id ASC`
  ).all() as CallRow[];

  // v9 Track-H — build a doc-identifier → field-name map from gql-doc sentinel
  // rows. Lets us rewrite `client.query({ query: GET_USER })` whose operation
  // is the const name to the operation field parsed from its gql body.
  const gqlDocMap = new Map<string, { operation: string; method: string | null }>();
  for (const c of calls) {
    if (c.framework !== 'gql-doc' || !c.operation || !c.raw_target) continue;
    gqlDocMap.set(c.raw_target, { operation: c.operation, method: c.method });
  }

  type RouteRow = {
    id: number; method: string | null; path: string; framework: string;
    handler_id: number | null;
    protocol: string | null;
    operation: string | null;
    topic: string | null;
    queue: string | null;
    service: string | null;
  };
  const hasV9RouteCols = hasColumn(raw, 'routes', 'protocol');
  const v9RouteCols = hasV9RouteCols
    ? ', protocol, operation, topic, queue, service'
    : '';
  const routes = raw.prepare(
    `SELECT id, method, path, framework, handler_id ${v9RouteCols}
       FROM routes
      ORDER BY id ASC`
  ).all() as RouteRow[];
  // Backfill protocol/operation for pre-v9 row shape — every pre-v9 route is HTTP.
  if (!hasV9RouteCols) {
    for (const r of routes) {
      r.protocol = 'http';
      r.operation = null;
      r.topic = null; r.queue = null; r.service = null;
    }
  }

  // Index routes by exact path for cheap lookup (HTTP only), and by operation
  // (tRPC / GraphQL / gRPC), and keep the full list for parameterised matching.
  const byExactPath = new Map<string, RouteRow[]>();
  const byOperation = new Map<string, RouteRow[]>();        // key = `${protocol}:${operation}`
  const byTopic = new Map<string, RouteRow[]>();             // key = topic
  const byQueue = new Map<string, RouteRow[]>();             // key = queue
  for (const r of routes) {
    const proto = r.protocol ?? 'http';
    if (proto === 'http' && r.path) {
      const norm = normalizeRoutePath(r.path);
      const list = byExactPath.get(norm);
      if (list) list.push(r); else byExactPath.set(norm, [r]);
    }
    if (r.operation) {
      const key = `${proto}:${r.operation}`;
      const list = byOperation.get(key);
      if (list) list.push(r); else byOperation.set(key, [r]);
    }
    if (r.topic) {
      const list = byTopic.get(r.topic);
      if (list) list.push(r); else byTopic.set(r.topic, [r]);
    }
    if (r.queue) {
      const list = byQueue.get(r.queue);
      if (list) list.push(r); else byQueue.set(r.queue, [r]);
    }
  }

  const insertLink = store.makeServiceLinkInserter();
  const byKind: Record<string, number> = {
    literal_path: 0, env_base: 0, service_host: 0, route_pattern: 0,
    trpc_procedure: 0, graphql_operation: 0, grpc_method: 0,
    topic_match: 0, queue_match: 0, exchange_match: 0,
  };
  let considered = 0;
  let inserted = 0;
  let truncatedCalls = 0;

  for (const c of calls) {
    type Candidate = {
      route: RouteRow;
      confidence: number;
      matchKind: MatchKind;
      reason: string;
    };
    const candidates: Candidate[] = [];

    if (c.protocol === 'http') {
      if (!c.normalized_path) continue;
      considered++;
      // Known service host? Used as a confidence boost AND as the match_kind
      // when the host carries strictly more signal than the path alone.
      const knownHost = c.host_hint
        ? options.hostMap?.hosts.has(c.host_hint.toLowerCase())
        : false;
      const hostBoost = knownHost ? 1.05 : 1.0;

      // Pass 1 — literal exact path matches (HTTP only).
      const exacts = byExactPath.get(c.normalized_path) ?? [];
      for (const r of exacts) {
        // Only HTTP routes; tRPC operation could in theory collide with a path
        // string but we filter by route.protocol to keep concerns separate.
        if ((r.protocol ?? 'http') !== 'http') continue;
        const ms = methodMatchScore(c.method, r.method);
        if (ms === 0) continue;
        const conf = Math.min(1.0, 0.95 * ms * hostBoost);
        // Prefer 'service_host' when we have a known k8s/Docker host AND the
        // call has no env_key — both the host name and a workspace route
        // independently agree. Otherwise fall back to env_base / literal_path.
        const matchKind: MatchKind = knownHost && !c.env_key
          ? 'service_host'
          : (c.env_key ? 'env_base' : 'literal_path');
        candidates.push({
          route: r, confidence: conf, matchKind,
          reason: knownHost ? 'literal_path+service_host' : 'literal_path',
        });
      }
      // Pass 2 — parameterised route matches. Only if no exact hit.
      if (candidates.length === 0) {
        for (const r of routes) {
          if ((r.protocol ?? 'http') !== 'http') continue;
          const pm = routePatternsMatch(c.normalized_path, normalizeRoutePath(r.path));
          if (!pm.matched) continue;
          const ms = methodMatchScore(c.method, r.method);
          if (ms === 0) continue;
          const conf = Math.min(1.0, pm.confidence * ms * hostBoost);
          candidates.push({
            route: r, confidence: conf,
            matchKind: knownHost && !c.env_key ? 'service_host' : 'route_pattern',
            reason: knownHost ? `${pm.reason}+service_host` : pm.reason,
          });
        }
      }
    } else if (c.protocol === 'trpc') {
      if (!c.operation) continue;
      considered++;
      // tRPC clients carry the full nested procedure path like 'user.getById';
      // server-side routes carry only their immediate procedure key like
      // 'getById'. We match either way: prefer exact full-path equality, then
      // fall back to last-segment match.
      const exacts = byOperation.get(`trpc:${c.operation}`) ?? [];
      for (const r of exacts) {
        const ms = methodMatchScore(c.method, r.method);
        // tRPC method match: query vs query etc.; fall back to ANY-as-wildcard.
        const conf = 0.95 * (ms === 0 ? 0.85 : ms);
        candidates.push({
          route: r, confidence: conf,
          matchKind: 'trpc_procedure', reason: 'exact_operation',
        });
      }
      if (candidates.length === 0) {
        // Last-segment fallback: client 'user.getById' matches server route
        // whose operation is 'getById' (a procedure inside a sub-router).
        const lastSeg = c.operation.split('.').pop()!;
        const tail = byOperation.get(`trpc:${lastSeg}`) ?? [];
        for (const r of tail) {
          const ms = methodMatchScore(c.method, r.method);
          const conf = 0.7 * (ms === 0 ? 0.85 : ms);
          candidates.push({
            route: r, confidence: conf,
            matchKind: 'trpc_procedure', reason: 'last_segment_operation',
          });
        }
      }
    } else if (c.protocol === 'graphql') {
      // gql-doc sentinel rows: skip — they're document definitions, not calls.
      if (c.framework === 'gql-doc') continue;
      if (!c.operation) continue;
      considered++;
      // Resolve operation: prefer the parsed field name. If the operation is a
      // known document-identifier (e.g. GET_USER) and we have a sentinel for
      // it, use the sentinel's field name instead.
      let effectiveOp = c.operation;
      let effectiveMethod = c.method;
      const doc = gqlDocMap.get(c.operation);
      if (doc) {
        effectiveOp = doc.operation;
        if (!effectiveMethod && doc.method) effectiveMethod = doc.method;
      }
      const exacts = byOperation.get(`graphql:${effectiveOp}`) ?? [];
      for (const r of exacts) {
        const ms = methodMatchScore(effectiveMethod, r.method);
        const conf = 0.9 * (ms === 0 ? 0.85 : ms);
        candidates.push({
          route: r, confidence: conf,
          matchKind: 'graphql_operation',
          reason: doc ? 'gql_doc_field' : 'exact_operation',
        });
      }
    } else if (c.protocol === 'grpc') {
      // Match by service + method, encoded as 'Service/Method' or just 'Method'.
      const op = c.operation;
      if (!op) continue;
      considered++;
      const exacts = byOperation.get(`grpc:${op}`) ?? [];
      for (const r of exacts) {
        candidates.push({
          route: r, confidence: 0.95,
          matchKind: 'grpc_method', reason: 'exact_grpc_method',
        });
      }
    } else if (c.protocol === 'kafka' || c.protocol === 'sns' ||
               c.protocol === 'nats'  || c.protocol === 'redis_pubsub') {
      if (!c.topic) continue;
      considered++;
      const consumers = byTopic.get(c.topic) ?? [];
      for (const r of consumers) {
        if ((r.protocol ?? '') !== c.protocol) continue;
        candidates.push({
          route: r, confidence: 0.9,
          matchKind: 'topic_match', reason: 'topic_match',
        });
      }
    } else if (c.protocol === 'sqs' || c.protocol === 'rabbitmq') {
      if (!c.queue) continue;
      considered++;
      const consumers = byQueue.get(c.queue) ?? [];
      for (const r of consumers) {
        if ((r.protocol ?? '') !== c.protocol) continue;
        candidates.push({
          route: r, confidence: 0.9,
          matchKind: 'queue_match', reason: 'queue_match',
        });
      }
    } else {
      // websocket / sse / unknown — skip for now; future plans can add them.
      continue;
    }

    if (candidates.length === 0) continue;

    // Sort by (confidence DESC, route_id ASC, match_kind ASC) so the top pick
    // — and the ambiguity ordering — is deterministic across runs. match_kind
    // is a tertiary tie-break in case two routes have identical id+confidence
    // (shouldn't happen, but defensive).
    candidates.sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      if (a.route.id !== b.route.id) return a.route.id - b.route.id;
      return a.matchKind < b.matchKind ? -1 : a.matchKind > b.matchKind ? 1 : 0;
    });

    // Cap candidates considered. Truncation is recorded in evidence so the
    // agent can see the cutoff fired. Capping AFTER sorting preserves the
    // best matches.
    const totalCandidates = candidates.length;
    let didTruncate = false;
    if (candidates.length > MAX_CANDIDATES_PER_CALL) {
      candidates.length = MAX_CANDIDATES_PER_CALL;
      didTruncate = true;
      truncatedCalls++;
    }

    const top = candidates[0];
    const ambiguity = candidates.length > 1
      ? candidates.slice(1, 1 + MAX_EVIDENCE_CANDIDATES).map(x => ({
          route_id: x.route.id,
          confidence: Number(x.confidence.toFixed(3)),
          reason: x.reason,
          match_kind: x.matchKind,
        }))
      : [];
    const evidence = JSON.stringify({
      reason: top.reason,
      method_call: c.method,
      method_route: top.route.method,
      env_key: c.env_key ?? null,
      host_hint: c.host_hint ?? null,
      raw_target: c.raw_target,
      operation: c.operation ?? null,
      topic: c.topic ?? null,
      queue: c.queue ?? null,
      service: c.service ?? null,
      total_candidates: totalCandidates,
      truncated: didTruncate,
      ambiguity_candidates: ambiguity,
    });
    insertLink({
      callId: c.id,
      routeId: top.route.id,
      callerSymbolId: c.symbol_id,
      handlerSymbolId: top.route.handler_id,
      protocol: c.protocol,
      matchKind: top.matchKind,
      confidence: Number(top.confidence.toFixed(3)),
      evidenceJson: evidence,
    });
    byKind[top.matchKind] = (byKind[top.matchKind] ?? 0) + 1;
    inserted++;
  }

  return {
    callsConsidered: considered,
    linksInserted: inserted,
    byKind: byKind as Record<MatchKind, number>,
    truncated: truncatedCalls,
  };
}

/** Cheap PRAGMA-based column-existence check; used so the resolver can run
 *  unchanged against a pre-v9 DB shape. */
function hasColumn(raw: any, table: string, column: string): boolean {
  try {
    const rows = raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return rows.some(r => r.name === column);
  } catch { return false; }
}

/** Apply the same normalization to a route path as to a call path so the
 *  byExactPath comparison is symmetric (strip trailing slash, etc). */
export function normalizeRoutePath(p: string): string {
  if (!p) return '';
  let s = p.trim();
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}
