/**
 * Track-F portable .seer bundle format.
 *
 * A bundle is a single self-describing file that lets a team ship a fully
 * built index without every developer having to re-run `seer index`. The
 * format is deliberately tiny and dependency-free:
 *
 *   [4 bytes: magic 'SEER']
 *   [4 bytes: bundle format version (uint32 BE)]
 *   [4 bytes: manifest length (uint32 BE)]
 *   [N bytes: manifest JSON (utf-8)]
 *   [M bytes: gzip-compressed SQLite DB]
 *
 * Why not tar/zip? Both add a dependency or a hand-rolled archive writer for
 * a single payload file. Our payload IS the DB; everything else is a few
 * structured fields. One header + one gzip stream gets us:
 *   - O(1) manifest read without decompressing the DB
 *   - cross-platform, no native deps
 *
 * On determinism: the gzip stream and the VACUUM INTO'd DB ARE deterministic
 * for fixed input. The manifest, however, defaults `builtAt = Date.now()` so
 * out-of-the-box exports of the same DB at different wall-clock times
 * produce different bytes. If you need bit-identical bundles (build-cache
 * keys, reproducible-builds CI), pass an explicit `builtAt` to `exportBundle`
 * to pin it.
 *
 * The manifest is the source of truth for:
 *   - schema_version (so the consumer can refuse incompatible bundles)
 *   - source signature (repo root, git head, file count + hash) so the
 *     bundle's "shape" is auditable before the agent trusts it
 *   - tool versions, build time, SCIP layers contributing precision
 *
 * Bundles are produced by `seer bundle export` and consumed by
 * `seer bundle import`. CI mode (`seer ci bundle`) is a thin wrapper that
 * runs `index` then `bundle export` and surfaces the resulting path.
 */

export const BUNDLE_MAGIC = Buffer.from('SEER', 'utf-8');
export const BUNDLE_FORMAT_VERSION = 1;

export interface BundleManifest {
  /**
   * Bundle format version — bumped when the on-disk layout changes
   * incompatibly. Distinct from the DB schema version, which can bump
   * independently when only the SQL evolves.
   */
  bundleFormatVersion: number;
  /** Schema version of the embedded DB. Consumers refuse on mismatch. */
  schemaVersion: number;
  /** Wall-clock millis the bundle was built. */
  builtAt: number;
  /** Tool that produced the bundle. */
  builtBy: string;
  /** Source identity. */
  source: {
    repoRoot: string;
    gitHead: string | null;
    gitBranch: string | null;
    /** Stable hash over the source file roster — `(relPath, fileHash)` pairs. */
    rosterHash: string;
    /** Number of source files indexed. */
    fileCount: number;
  };
  /** Index summary so a consumer can size-check without unpacking. */
  index: {
    symbols: number;
    edges: number;
    resolvedEdges: number;
    modules: number;
    routes: number;
    externalDependencies: number;
    configKeys: number;
    languages: Record<string, number>;
    /** v7: provenance counts. */
    provenance?: {
      symbols: Record<string, number>;
      edges: Record<string, number>;
    };
  };
  /** SCIP layers folded into the DB (if any). */
  scipImports: Array<{
    path: string; sha256: string; tool: string | null;
    symbolCount: number; refCount: number;
  }>;
  /**
   * Sha-256 of the embedded DB (computed BEFORE compression). Lets the
   * consumer verify a transferred bundle without trusting the gzip CRC alone.
   */
  dbSha256: string;
  /** Uncompressed DB size in bytes. */
  dbBytes: number;
}
