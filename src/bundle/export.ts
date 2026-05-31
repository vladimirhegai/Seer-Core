import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import zlib from 'zlib';
import { execFileSync } from 'child_process';
import { Store } from '../db/store.js';
import {
  BUNDLE_MAGIC, BUNDLE_FORMAT_VERSION, BundleManifest,
} from './format.js';

export interface ExportOptions {
  /** Where to write the bundle. Defaults to `<repoRoot>/.seer/index.seerbundle`. */
  out?: string;
  /** Gzip level (0-9). Defaults to 6 (zlib's standard balance). */
  compressionLevel?: number;
  /** Logger; defaults to no-op. */
  log?: (msg: string) => void;
  /** Override the gitHead recorded in the manifest (CI sometimes wants this). */
  gitHead?: string;
  /** Override the gitBranch recorded in the manifest. */
  gitBranch?: string;
  /**
   * Pin the manifest's `builtAt` (Unix-millis). Defaults to `Date.now()`,
   * which makes successive exports of the same DB byte-different. Override
   * to a stable value (e.g. the source repo's HEAD commit time) when you
   * need reproducible bundle bytes for build-cache keys.
   */
  builtAt?: number;
}

export interface ExportResult {
  bundlePath: string;
  bytes: number;
  manifest: BundleManifest;
  elapsedMs: number;
}

/**
 * Bundle an existing `.seer/graph.db` into a portable single-file artifact.
 *
 * The DB is first VACUUM INTO'd to a temp file so we ship a tightly packed
 * copy (no WAL, no free pages). The packed DB is hashed, then gzip-compressed
 * and concatenated after the manifest header. The result is deterministic for
 * a given DB content + manifest input.
 */
export async function exportBundle(
  dbPath: string, repoRoot: string, options: ExportOptions = {},
): Promise<ExportResult> {
  const start = Date.now();
  const log = options.log ?? (() => { /* */ });

  if (!fs.existsSync(dbPath)) {
    throw new Error(`No index at ${dbPath} — run \`seer index\` first.`);
  }

  // Open the source DB read-only and harvest the manifest data BEFORE we
  // start the vacuum (vacuum closes implicit locks on its own connection but
  // the source connection stays compatible since we re-open it here).
  const srcStore = Store.openReadOnly(dbPath);
  let manifest: BundleManifest;
  try {
    const stats = srcStore.getStats();
    const scipImports = srcStore.listScipImports();
    const files = srcStore.listFiles();
    const roster = files
      .map(f => ({ relPath: f.relPath, hash: f.hash }))
      .sort((a, b) => a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0);
    const rosterHash = crypto.createHash('sha256')
      .update(roster.map(r => `${r.relPath}\t${r.hash}`).join('\n'))
      .digest('hex');
    const schemaVersion = srcStore.schemaInfo().dbVersion;

    manifest = {
      bundleFormatVersion: BUNDLE_FORMAT_VERSION,
      schemaVersion,
      builtAt: options.builtAt ?? Date.now(),
      builtBy: `seer/${BUNDLE_FORMAT_VERSION}`,
      source: {
        repoRoot: path.resolve(repoRoot),
        gitHead: options.gitHead ?? detectGitHead(repoRoot),
        gitBranch: options.gitBranch ?? detectGitBranch(repoRoot),
        rosterHash,
        fileCount: files.length,
      },
      index: {
        symbols: stats.symbols,
        edges: stats.edges,
        resolvedEdges: stats.resolvedEdges,
        modules: stats.modules ?? 0,
        routes: stats.routes ?? 0,
        externalDependencies: stats.externalDependencies ?? 0,
        configKeys: stats.configKeys ?? 0,
        languages: stats.languages,
        provenance: stats.provenance,
      },
      scipImports: scipImports.map(s => ({
        path: s.path, sha256: s.sha256, tool: s.tool,
        symbolCount: s.symbolCount, refCount: s.refCount,
      })),
      dbSha256: '',  // filled in after we hash the packed DB
      dbBytes: 0,
    };
  } finally {
    srcStore.close();
  }

  // VACUUM INTO produces a fresh, tightly packed DB — fast on small repos,
  // O(rows) on huge ones. We write to a temp file so the source DB stays
  // untouched and aborted exports leave nothing behind.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seer-bundle-'));
  const packedDb = path.join(tmpDir, 'graph.packed.db');
  log(`Vacuuming index into ${packedDb}...`);
  const packStore = new Store(dbPath);
  try {
    packStore.rawDb().exec(`VACUUM INTO '${packedDb.replace(/'/g, "''")}'`);
  } finally {
    packStore.close();
  }

  const dbBuf = fs.readFileSync(packedDb);
  const dbSha = crypto.createHash('sha256').update(dbBuf).digest('hex');
  manifest.dbSha256 = dbSha;
  manifest.dbBytes = dbBuf.length;
  log(`Packed DB: ${dbBuf.length} bytes, sha256 ${dbSha.slice(0, 12)}...`);

  const manifestJson = Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8');
  // Gzip the DB. Level 6 is the zlib default; bumpable for CI artifacts.
  const compressed = zlib.gzipSync(dbBuf, {
    level: options.compressionLevel ?? 6,
  });
  log(`Compressed DB: ${compressed.length} bytes (${(compressed.length / dbBuf.length * 100).toFixed(1)}% of raw)`);

  const header = Buffer.alloc(4 + 4 + 4);
  BUNDLE_MAGIC.copy(header, 0);
  header.writeUInt32BE(BUNDLE_FORMAT_VERSION, 4);
  header.writeUInt32BE(manifestJson.length, 8);

  const outPath = options.out ?? path.join(repoRoot, '.seer', 'index.seerbundle');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const fd = fs.openSync(outPath, 'w');
  try {
    fs.writeSync(fd, header);
    fs.writeSync(fd, manifestJson);
    fs.writeSync(fd, compressed);
  } finally {
    fs.closeSync(fd);
  }
  try { fs.unlinkSync(packedDb); fs.rmdirSync(tmpDir); } catch { /* */ }

  return {
    bundlePath: outPath,
    bytes: header.length + manifestJson.length + compressed.length,
    manifest,
    elapsedMs: Date.now() - start,
  };
}

function detectGitHead(repoRoot: string): string | null {
  try {
    const sha = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], {
      encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return sha.length > 0 ? sha : null;
  } catch { return null; }
}

function detectGitBranch(repoRoot: string): string | null {
  try {
    const branch = execFileSync('git', ['-C', repoRoot, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return branch.length > 0 && branch !== 'HEAD' ? branch : null;
  } catch { return null; }
}
