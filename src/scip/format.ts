/**
 * Track-F SCIP import.
 *
 * Seer accepts SCIP-format precision indexes (https://github.com/sourcegraph/scip)
 * as an ADDITIVE precision uplift over the tree-sitter baseline. A SCIP index
 * carries precise definitions and references produced by a real type-aware
 * indexer (rust-analyzer, scip-typescript, scip-java, etc.). Importing one
 * lets Seer overlay precise edges where tree-sitter's syntactic heuristics
 * were guessing.
 *
 * The import is source-labelled (`provenance = 'scip'`) so consumers can
 * always see which signals came from SCIP vs which were tree-sitter's best
 * effort. Tree-sitter rows are never deleted by a SCIP import; when a SCIP
 * symbol overlaps an existing tree-sitter row at the same file/line/kind, the
 * tree-sitter row is re-labeled `'scip-merge'` (precision confirmed) and
 * SCIP edges target its existing id.
 *
 * Format support:
 *   - .scip       : binary protobuf (the canonical SCIP format)
 *   - .scip.json  : Seer's JSON envelope mirroring the protobuf shape. Many
 *                   SCIP producers can dump JSON directly; the schema is also
 *                   easy to hand-author for testing and migration scripts.
 *
 * The JSON envelope is the SUBSET of SCIP that Seer actually consumes — we
 * don't carry hover-doc payloads or signature_documentation because Seer
 * doesn't surface them. Adding more fields later is purely additive: a
 * consumer that doesn't recognize a field ignores it.
 */

export type ScipSymbolKind =
  | 'function' | 'method' | 'constructor' | 'class'
  | 'interface' | 'struct' | 'enum' | 'type' | 'variable';

export interface ScipSymbol {
  /**
   * Globally unique SCIP symbol id. Opaque string; the importer never parses
   * it — it's just a primary key for cross-document references.
   */
  symbolId: string;
  displayName: string;
  /** Optional dotted qualified name (e.g. `auth.AuthService.login`). */
  qualifiedName?: string;
  kind: ScipSymbolKind;
  /** Repo-relative file path. */
  relativePath: string;
  /** 0-indexed source range. */
  range: { startLine: number; startCharacter: number; endLine: number; endCharacter: number };
  signature?: string;
}

export interface ScipOccurrence {
  /** SCIP symbol id being referenced. */
  symbolId: string;
  relativePath: string;
  range: { startLine: number; startCharacter: number; endLine: number; endCharacter: number };
  /**
   * 'definition' for the canonical defining occurrence (one per symbol),
   * 'reference' for every other use site.
   */
  role: 'definition' | 'reference';
}

export interface ScipDocument {
  /**
   * Repo-relative path the document covers. Symbol/occurrence rows can also
   * carry their own relativePath, but the doc-level one is the default.
   */
  relativePath: string;
  symbols: ScipSymbol[];
  occurrences: ScipOccurrence[];
}

export interface ScipIndex {
  /** Producer identifier — e.g. `scip-typescript 0.3.5`. */
  tool?: string;
  /** Absolute project root used by the producer (informational). */
  projectRoot?: string;
  /**
   * Documents keyed by repo-relative path. The same shape SCIP uses, just
   * flattened for ergonomic JSON authoring.
   */
  documents: ScipDocument[];
}
