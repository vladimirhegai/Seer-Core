/**
 * v10 — Contract Diff between two `.seerbundle` artifacts.
 *
 * Goal: deterministically compute the change set in the API/service surface
 * exposed by an indexed repo, treating the bundle as the source of truth.
 * The diff is ADVISORY — exit code is always 0 even when breaking changes
 * appear. Seer-Core does not gate CI.
 *
 * Comparison happens at the protocol-aware "endpoint" level:
 *   - HTTP: key = `${method}|${path}`, framework recorded
 *   - tRPC: key = `trpc|${operation}` (method = 'query' / 'mutation' / 'subscription')
 *   - GraphQL: key = `graphql|${operation}`
 *   - gRPC: key = `grpc|${service}.${operation}`
 *   - Messaging (kafka/sqs/sns/rabbitmq/nats/redis_pubsub):
 *       key = `${protocol}|${topic|queue|exchange}`
 *
 * Output:
 *   - added[]
 *   - removed[]
 *   - changed[] (key matched; surfaced field differs — handler, framework,
 *     metadata, service)
 *   - optionally affectedCallers[] when both bundles include service-link
 *     evidence (caller symbol qualifiedName / file).
 *
 * Deterministic ordering: every list is sorted by (protocol, key) ASC.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import zlib from 'zlib';
import { BUNDLE_MAGIC, BUNDLE_FORMAT_VERSION, BundleManifest } from './format.js';
import { Store } from '../db/store.js';

export interface ContractEndpoint {
  protocol: string;
  /** Stable identity key for this endpoint within its protocol. */
  key: string;
  method: string | null;
  path: string | null;
  framework: string | null;
  handlerName: string | null;
  operation: string | null;
  topic: string | null;
  queue: string | null;
  exchange: string | null;
  service: string | null;
}

export interface AffectedCaller {
  callerQualifiedName: string | null;
  callerFile: string | null;
  callerLine: number | null;
  /** Where the caller is referenced — either 'old' or 'new' bundle. */
  source: 'old' | 'new';
}

export interface ContractChange {
  protocol: string;
  key: string;
  before: ContractEndpoint;
  after: ContractEndpoint;
  /** Field names whose value differs between before/after. */
  changedFields: string[];
}

export interface ContractDiff {
  oldBundle: { path: string; gitHead: string | null; rosterHash: string };
  newBundle: { path: string; gitHead: string | null; rosterHash: string };
  /** Per-protocol totals on both sides, for sanity. */
  totals: {
    old: number;
    new: number;
    added: number;
    removed: number;
    changed: number;
  };
  added: Array<ContractEndpoint & { affectedCallers?: AffectedCaller[] }>;
  removed: Array<ContractEndpoint & { affectedCallers?: AffectedCaller[] }>;
  changed: Array<ContractChange & { affectedCallers?: AffectedCaller[] }>;
  /** True when the affected-callers section is non-empty for at least one row. */
  affectedCallersAvailable: boolean;
}

/**
 * Open a bundle's payload as a read-only Store (decompressed to a temp file).
 * Returns the Store plus a cleanup() function the caller MUST invoke.
 */
async function openBundleStore(bundlePath: string): Promise<{
  store: Store; manifest: BundleManifest; cleanup: () => void;
}> {
  if (!fs.existsSync(bundlePath)) {
    throw new Error(`No bundle at ${bundlePath}`);
  }
  const fileBuf = fs.readFileSync(bundlePath);
  if (fileBuf.length < 12 || !fileBuf.subarray(0, 4).equals(BUNDLE_MAGIC)) {
    throw new Error(`Not a Seer bundle: ${bundlePath} (bad magic)`);
  }
  const formatVersion = fileBuf.readUInt32BE(4);
  if (formatVersion > BUNDLE_FORMAT_VERSION) {
    throw new Error(`Bundle format v${formatVersion} is newer than this build (v${BUNDLE_FORMAT_VERSION}). Upgrade Seer.`);
  }
  const manifestLen = fileBuf.readUInt32BE(8);
  const manifestEnd = 12 + manifestLen;
  if (manifestLen <= 0 || manifestEnd > fileBuf.length) {
    throw new Error(`Bundle truncated: ${bundlePath} (manifest length ${manifestLen} exceeds file size)`);
  }
  const manifest = JSON.parse(fileBuf.slice(12, manifestEnd).toString('utf-8')) as BundleManifest;
  const dbBuf = zlib.gunzipSync(fileBuf.slice(manifestEnd));
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seer-contractdiff-'));
  const dbPath = path.join(tmpDir, 'bundle.db');
  fs.writeFileSync(dbPath, dbBuf);
  const store = Store.openReadOnly(dbPath);
  return {
    store, manifest,
    cleanup: () => {
      try { store.close(); } catch { /* */ }
      try { fs.unlinkSync(dbPath); fs.rmdirSync(tmpDir); } catch { /* */ }
    },
  };
}

/**
 * Build the "contract surface" — one entry per route — from a bundle Store.
 * Stable key:
 *   - HTTP    → `http|${method}|${path}`
 *   - tRPC    → `trpc|${operation}`
 *   - GraphQL → `graphql|${operation}`
 *   - gRPC    → `grpc|${service}.${operation}`
 *   - Messaging → `${protocol}|${topic|queue|exchange}`
 */
export function collectContractSurface(store: Store): Map<string, ContractEndpoint> {
  const surface = new Map<string, ContractEndpoint>();
  const rows = store.listRoutes({ limit: 1_000_000 });
  for (const r of rows) {
    const protocol = r.protocol ?? 'http';
    const key = endpointKey(protocol, r);
    if (key == null) continue;
    surface.set(key, {
      protocol,
      key,
      method: r.method ?? null,
      path: r.path ?? null,
      framework: r.framework ?? null,
      handlerName: r.handlerName ?? null,
      operation: r.operation ?? null,
      topic: r.topic ?? null,
      queue: r.queue ?? null,
      exchange: r.exchange ?? null,
      service: r.service ?? null,
    });
  }
  return surface;
}

function endpointKey(protocol: string, r: {
  method?: string | null; path?: string | null;
  operation?: string | null; topic?: string | null;
  queue?: string | null; exchange?: string | null;
  service?: string | null;
}): string | null {
  if (protocol === 'http') {
    if (!r.path) return null;
    return `http|${(r.method ?? 'ANY').toUpperCase()}|${r.path}`;
  }
  if (protocol === 'trpc') {
    if (!r.operation) return null;
    return `trpc|${r.operation}`;
  }
  if (protocol === 'graphql') {
    if (!r.operation) return null;
    return `graphql|${r.operation}`;
  }
  if (protocol === 'grpc') {
    if (!r.operation) return null;
    const svc = r.service ?? '';
    return `grpc|${svc}.${r.operation}`;
  }
  if (protocol === 'kafka' || protocol === 'redis_pubsub' || protocol === 'nats' || protocol === 'sns') {
    if (!r.topic) return null;
    return `${protocol}|${r.topic}`;
  }
  if (protocol === 'sqs' || protocol === 'rabbitmq') {
    const key = r.queue ?? r.exchange;
    if (!key) return null;
    return `${protocol}|${key}`;
  }
  return null;
}

/**
 * Diff two bundles' contract surfaces. Both bundles are opened read-only,
 * the surfaces are collected, and the diff is computed without importing
 * either bundle into a workspace.
 */
export async function contractDiff(
  oldBundlePath: string,
  newBundlePath: string,
  options: { includeAffectedCallers?: boolean } = {},
): Promise<ContractDiff> {
  const oldH = await openBundleStore(oldBundlePath);
  const newH = await openBundleStore(newBundlePath);
  try {
    const oldSurface = collectContractSurface(oldH.store);
    const newSurface = collectContractSurface(newH.store);

    const added: ContractEndpoint[] = [];
    const removed: ContractEndpoint[] = [];
    const changed: ContractChange[] = [];

    for (const [key, before] of oldSurface) {
      const after = newSurface.get(key);
      if (!after) { removed.push(before); continue; }
      const fields = diffEndpointFields(before, after);
      if (fields.length > 0) {
        changed.push({ protocol: before.protocol, key, before, after, changedFields: fields });
      }
    }
    for (const [key, after] of newSurface) {
      if (!oldSurface.has(key)) added.push(after);
    }

    sortByProtocolKey(added);
    sortByProtocolKey(removed);
    changed.sort((a, b) =>
      a.protocol < b.protocol ? -1 :
      a.protocol > b.protocol ? 1 :
      a.key < b.key ? -1 :
      a.key > b.key ? 1 : 0);

    let affectedCallersAvailable = false;
    let augmented = false;
    if (options.includeAffectedCallers) {
      augmented = true;
      const oldCallersByRouteKey = collectCallersByRouteKey(oldH.store);
      const newCallersByRouteKey = collectCallersByRouteKey(newH.store);

      const attach = (item: ContractEndpoint & { affectedCallers?: AffectedCaller[] },
                      side: 'old' | 'new'): void => {
        const src = side === 'old' ? oldCallersByRouteKey : newCallersByRouteKey;
        const callers = src.get(item.key);
        if (callers && callers.length > 0) {
          item.affectedCallers = callers.map(c => ({ ...c, source: side }));
          affectedCallersAvailable = true;
        }
      };
      for (const item of added)   attach(item as any, 'new');
      for (const item of removed) attach(item as any, 'old');
      for (const item of changed) {
        const sideOld = oldCallersByRouteKey.get(item.key);
        const sideNew = newCallersByRouteKey.get(item.key);
        const callers: AffectedCaller[] = [];
        if (sideOld) for (const c of sideOld) callers.push({ ...c, source: 'old' });
        if (sideNew) for (const c of sideNew) callers.push({ ...c, source: 'new' });
        if (callers.length > 0) {
          (item as any).affectedCallers = callers;
          affectedCallersAvailable = true;
        }
      }
      void augmented;
    }

    return {
      oldBundle: {
        path: path.resolve(oldBundlePath),
        gitHead: oldH.manifest.source.gitHead,
        rosterHash: oldH.manifest.source.rosterHash,
      },
      newBundle: {
        path: path.resolve(newBundlePath),
        gitHead: newH.manifest.source.gitHead,
        rosterHash: newH.manifest.source.rosterHash,
      },
      totals: {
        old: oldSurface.size,
        new: newSurface.size,
        added: added.length,
        removed: removed.length,
        changed: changed.length,
      },
      added,
      removed,
      changed,
      affectedCallersAvailable,
    };
  } finally {
    oldH.cleanup();
    newH.cleanup();
  }
}

function sortByProtocolKey(items: ContractEndpoint[]): void {
  items.sort((a, b) =>
    a.protocol < b.protocol ? -1 :
    a.protocol > b.protocol ? 1 :
    a.key < b.key ? -1 :
    a.key > b.key ? 1 : 0);
}

function diffEndpointFields(a: ContractEndpoint, b: ContractEndpoint): string[] {
  const fields: string[] = [];
  const keys: Array<keyof ContractEndpoint> = [
    'method', 'path', 'framework', 'handlerName',
    'operation', 'topic', 'queue', 'exchange', 'service',
  ];
  for (const k of keys) {
    if ((a as any)[k] !== (b as any)[k]) fields.push(k);
  }
  return fields;
}

/**
 * For each route in the bundle, build a list of caller previews using
 * service_links + service_calls when present. Lets the diff report
 * affectedCallers without importing the bundle.
 */
function collectCallersByRouteKey(store: Store): Map<string, AffectedCaller[]> {
  const out = new Map<string, AffectedCaller[]>();
  try {
    const links = store.listServiceLinks({ limit: 1_000_000 });
    const routesById = new Map<number, ContractEndpoint>();
    for (const r of store.listRoutes({ limit: 1_000_000 })) {
      const protocol = r.protocol ?? 'http';
      const key = endpointKey(protocol, r);
      if (!key) continue;
      routesById.set(r.id, {
        protocol, key,
        method: r.method, path: r.path, framework: r.framework,
        handlerName: r.handlerName,
        operation: r.operation ?? null, topic: r.topic ?? null,
        queue: r.queue ?? null, exchange: r.exchange ?? null,
        service: r.service ?? null,
      });
    }
    for (const l of links) {
      if (l.routeId == null) continue;
      const ep = routesById.get(l.routeId);
      if (!ep) continue;
      const list = out.get(ep.key) ?? [];
      list.push({
        callerQualifiedName: l.callerQualifiedName ?? l.callerName ?? null,
        callerFile: l.callerFile,
        callerLine: l.callerLine ?? null,
        source: 'old',
      });
      out.set(ep.key, list);
    }
  } catch { /* */ }
  return out;
}

/**
 * Convenience: format the diff as a compact human-readable table.
 * Deterministic ordering by protocol + key.
 */
export function formatContractDiffTable(diff: ContractDiff): string {
  const lines: string[] = [];
  lines.push(`Contract diff ${diff.oldBundle.path} → ${diff.newBundle.path}`);
  lines.push(`  old endpoints: ${diff.totals.old}  new: ${diff.totals.new}  ` +
    `added: ${diff.totals.added}  removed: ${diff.totals.removed}  changed: ${diff.totals.changed}`);
  if (diff.added.length > 0) {
    lines.push('');
    lines.push('  Added:');
    for (const a of diff.added) lines.push(`    + [${a.protocol}] ${labelEndpoint(a)}`);
  }
  if (diff.removed.length > 0) {
    lines.push('');
    lines.push('  Removed:');
    for (const r of diff.removed) lines.push(`    - [${r.protocol}] ${labelEndpoint(r)}`);
  }
  if (diff.changed.length > 0) {
    lines.push('');
    lines.push('  Changed:');
    for (const c of diff.changed) {
      lines.push(`    ~ [${c.protocol}] ${labelEndpoint(c.before)} (${c.changedFields.join(', ')})`);
    }
  }
  return lines.join('\n') + '\n';
}

function labelEndpoint(e: ContractEndpoint): string {
  if (e.protocol === 'http')   return `${e.method ?? 'ANY'} ${e.path ?? ''} (${e.framework ?? '?'})`;
  if (e.protocol === 'trpc')   return `${e.operation ?? ''}`;
  if (e.protocol === 'graphql')return `${e.operation ?? ''}`;
  if (e.protocol === 'grpc')   return `${e.service ?? ''}.${e.operation ?? ''}`;
  return e.topic ?? e.queue ?? e.exchange ?? '?';
}
