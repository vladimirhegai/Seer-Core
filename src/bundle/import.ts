import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import zlib from 'zlib';
import {
  BUNDLE_MAGIC, BUNDLE_FORMAT_VERSION, BundleManifest,
} from './format.js';
import { CURRENT_SCHEMA_VERSION } from '../db/schema.js';

export interface ImportOptions {
  /**
   * Where to land the extracted DB. Defaults to `<repoRoot>/.seer/graph.db`.
   * If the path already exists and `overwrite` is false (the default), the
   * import fails — bundles are meant to bootstrap a missing index, not to
   * silently clobber a fresher local one.
   */
  dbOut?: string;
  overwrite?: boolean;
  /** Logger; defaults to no-op. */
  log?: (msg: string) => void;
  /**
   * Skip the dbSha256 check. Off by default — the integrity guarantee is the
   * whole point of the manifest. Use this only for forensic inspection of a
   * corrupted bundle whose header still parses.
   */
  skipIntegrityCheck?: boolean;
  /**
   * Skip the schema-version compatibility check. Off by default — bundles
   * whose schemaVersion is newer than this build's CURRENT_SCHEMA_VERSION
   * are rejected because we can't safely open them. Override only when you
   * KNOW the schema is compatible (e.g. forensics or a controlled upgrade).
   */
  skipSchemaCheck?: boolean;
  /**
   * Required source repo root for the imported index. Used to decide the
   * default dbOut location only — the bundle's manifest.source.repoRoot is
   * stored as metadata but never enforced (bundles are commonly built on
   * a CI runner with a different absolute path).
   */
  repoRoot: string;
}

export interface ImportResult {
  bundlePath: string;
  dbPath: string;
  manifest: BundleManifest;
  bytes: number;
  elapsedMs: number;
}

/** Read just the manifest from a bundle, without unpacking the DB. */
export function readBundleManifest(bundlePath: string): BundleManifest {
  const fd = fs.openSync(bundlePath, 'r');
  try {
    const header = Buffer.alloc(12);
    const headerRead = fs.readSync(fd, header, 0, 12, 0);
    if (headerRead < 12 || !header.subarray(0, 4).equals(BUNDLE_MAGIC)) {
      throw new Error(`Not a Seer bundle: ${bundlePath} (bad magic)`);
    }
    const formatVersion = header.readUInt32BE(4);
    if (formatVersion > BUNDLE_FORMAT_VERSION) {
      throw new Error(`Bundle format v${formatVersion} is newer than this build (v${BUNDLE_FORMAT_VERSION}). Upgrade Seer.`);
    }
    const manifestLen = header.readUInt32BE(8);
    if (manifestLen <= 0 || manifestLen > 64 * 1024 * 1024) {
      throw new Error(`Bundle manifest length out of range: ${manifestLen}`);
    }
    const manifestBuf = Buffer.alloc(manifestLen);
    const read = fs.readSync(fd, manifestBuf, 0, manifestLen, 12);
    if (read !== manifestLen) {
      throw new Error(`Bundle truncated reading manifest`);
    }
    return JSON.parse(manifestBuf.toString('utf-8')) as BundleManifest;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Restore a bundle into the workspace. The default destination is
 * `<repoRoot>/.seer/graph.db`. Verifies the manifest, format version, and
 * (unless skipped) the DB sha256.
 */
export async function importBundle(
  bundlePath: string, options: ImportOptions,
): Promise<ImportResult> {
  const start = Date.now();
  const log = options.log ?? (() => { /* */ });

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
  if (manifestEnd > fileBuf.length) {
    throw new Error(`Bundle truncated; manifest length ${manifestLen} exceeds file size`);
  }
  const manifest = JSON.parse(fileBuf.slice(12, manifestEnd).toString('utf-8')) as BundleManifest;
  log(`Manifest: schemaVersion=${manifest.schemaVersion} symbols=${manifest.index.symbols} edges=${manifest.index.edges} builtAt=${new Date(manifest.builtAt).toISOString()}`);

  // Schema compatibility check. The bundle's embedded DB was built against a
  // specific schema version; if it's NEWER than this build of Seer, the DB
  // contains tables/columns we don't understand and opening it would either
  // crash on read or silently lose precision. Reject up front rather than
  // crashing on first query. Older bundles are accepted because the Store's
  // runMigrations() will catch the DB up at open time.
  if (!options.skipSchemaCheck) {
    if (manifest.schemaVersion > CURRENT_SCHEMA_VERSION) {
      throw new Error(
        `Bundle schemaVersion=${manifest.schemaVersion} is newer than this build's ` +
        `CURRENT_SCHEMA_VERSION=${CURRENT_SCHEMA_VERSION}. Upgrade Seer or pass skipSchemaCheck=true.`,
      );
    }
    if (manifest.schemaVersion <= 0) {
      throw new Error(`Bundle has invalid schemaVersion=${manifest.schemaVersion}.`);
    }
  }

  const compressed = fileBuf.slice(manifestEnd);
  const dbBuf = zlib.gunzipSync(compressed);

  if (!options.skipIntegrityCheck) {
    const dbSha = crypto.createHash('sha256').update(dbBuf).digest('hex');
    if (dbSha !== manifest.dbSha256) {
      throw new Error(`Bundle integrity check FAILED. Expected ${manifest.dbSha256}, got ${dbSha}.`);
    }
    if (dbBuf.length !== manifest.dbBytes) {
      throw new Error(`Bundle integrity check FAILED. Expected ${manifest.dbBytes} bytes, got ${dbBuf.length}.`);
    }
  }

  const dbOut = options.dbOut ?? path.join(options.repoRoot, '.seer', 'graph.db');
  if (fs.existsSync(dbOut) && !options.overwrite) {
    throw new Error(`Refusing to overwrite existing index at ${dbOut} — pass overwrite=true to replace it.`);
  }
  fs.mkdirSync(path.dirname(dbOut), { recursive: true });
  fs.writeFileSync(dbOut, dbBuf);
  // Drop the WAL/SHM siblings of the previous DB (if any) so the imported
  // file isn't read against a stale journal.
  try { fs.unlinkSync(dbOut + '-wal'); } catch { /* */ }
  try { fs.unlinkSync(dbOut + '-shm'); } catch { /* */ }
  log(`Wrote ${dbBuf.length} bytes to ${dbOut}`);

  return {
    bundlePath, dbPath: dbOut, manifest,
    bytes: fileBuf.length, elapsedMs: Date.now() - start,
  };
}
