// Core shared types for the Seer indexer

export type Language =
  | 'python'
  | 'javascript'
  | 'typescript'
  | 'go'
  | 'java'
  | 'rust'
  | 'c'
  | 'cpp'
  | 'csharp';

export type SymbolKind =
  | 'function'
  | 'class'
  | 'method'
  | 'interface'
  | 'struct'
  | 'enum'
  | 'type'
  | 'constructor'
  | 'variable';

export type EdgeKind = 'call' | 'import' | 'inherits' | 'implements' | 'tests';

/**
 * What variety of symbol this row represents.
 *   - 'definition'  — the canonical, body-bearing definition site. The default
 *                     and the only role indexed by every extractor on every
 *                     symbol historically. Rankable when the kind allows it.
 *   - 'declaration' — a forward declaration or prototype (no body). C/C++
 *                     class-body method declarations and forward declarations
 *                     fall here. Not rankable; excluded from agent-facing
 *                     defaults unless `includeDeclarations=true`.
 *   - 'type_ref'    — a bare use of a type name (no body, no declaration).
 *                     Not yet emitted by any extractor — the slot exists so a
 *                     future indexing mode can store reference sites without
 *                     re-shaping the schema.
 */
export type SymbolRole = 'definition' | 'declaration' | 'type_ref';

// A symbol definition extracted from source
export interface SymbolDef {
  name: string;
  /**
   * Dotted path including all enclosing class/struct/impl scopes.
   * Computed by the walker from the def stack — extractors should not set it.
   * E.g. `Alpha.run`, `AuthService.login`, `PaymentService.process_payment`.
   * Equals `name` for top-level definitions.
   */
  qualifiedName?: string;
  kind: SymbolKind;
  lineStart: number; // 0-indexed row
  lineEnd: number;
  colStart: number;
  colEnd: number;
  signature?: string; // first line of the definition, truncated
  /**
   * Complexity metrics, populated by language extractors via the walker.
   * `loc`/`cyclomatic`/`cognitive`/`maxNesting` are non-null only for
   * function-like symbols (function, method, constructor) where they make
   * sense. For classes/structs/enums/types they stay null.
   */
  loc?: number;
  cyclomatic?: number;
  cognitive?: number;
  maxNesting?: number;
  /**
   * Optional. When omitted, the Store treats this as `'definition'` —
   * matches all pre-existing extractor behavior. C/C++ field_declaration
   * (class-body method declarations) and forward declarations set this to
   * `'declaration'` so default agent-facing queries can hide them.
   */
  symbolRole?: SymbolRole;
}

// A reference (call/usage) extracted from source
export interface SymbolRef {
  calleeName: string;  // the name being called/referenced
  callerName: string;  // name of the enclosing function/method, or '' for module level
  kind: EdgeKind;
  line: number; // 0-indexed row
}

/**
 * One HTTP route detected during parsing — Express/Fastify/FastAPI/Flask/Spring.
 * The handler is named when the route maps to a local function; the post-pass
 * resolves `handlerName` → a `symbol_id` after all definitions are inserted.
 */
export interface RouteDef {
  method: string;
  path: string;
  framework: string;
  handlerName?: string;
  line: number;
}

/** A static read of an environment variable or config key. */
export interface ConfigKeyRead {
  key: string;
  source: 'env' | 'config';
  callerName?: string;   // enclosing symbol qualified name, '' for module-level
  line: number;
}

// Everything extracted from one file
export interface FileExtraction {
  language: Language;
  definitions: SymbolDef[];
  references: SymbolRef[];
  importedModules: string[]; // raw module/file paths imported
  routes?: RouteDef[];
  configKeys?: ConfigKeyRead[];
}

// ── DB result types ────────────────────────────────────────────────────────────

export interface SymbolRow {
  id: number;
  name: string;
  qualifiedName: string | null;
  kind: string;
  fileId: number;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  signature: string | null;
  pagerank: number;
  loc?: number | null;
  cyclomatic?: number | null;
  cognitive?: number | null;
  maxNesting?: number | null;
  /**
   * Stored variety of symbol. Null on pre-v5 DBs that haven't yet been
   * re-indexed; the Store treats null as `'definition'` for filter logic.
   */
  symbolRole?: SymbolRole | null;
}

export interface CallerRow {
  callerName: string;
  callerQualifiedName: string | null;
  callerKind: string;
  callerFile: string;
  callerLine: number;
  edgeKind: string;
}

export interface CalleeRow {
  calleeName: string;
  calleeKind: string | null;
  calleeFile: string | null;
  calleeLineStart: number | null;
  edgeKind: string;
}

export interface RouteRow {
  id: number;
  method: string;
  path: string;
  framework: string;
  handlerName: string | null;
  handlerId: number | null;
  handlerSymbol: string | null;
  handlerFile: string | null;
  filePath: string;
  line: number;
}

export interface ExternalDepRow {
  id: number;
  ecosystem: string;
  name: string;
  versionRange: string | null;
  manifestPath: string;
  isDev: number;
}

export interface ConfigKeyRow {
  id: number;
  key: string;
  source: string;
  filePath: string;
  symbolId: number | null;
  symbolName: string | null;
  line: number;
}

export interface FileChurnRow {
  fileId: number;
  filePath: string;
  commitCount: number;
  lastCommitSha: string | null;
  lastCommitAt: number | null;
  topAuthor: string | null;
  secondAuthor: string | null;
}

export interface SymbolHistoryRow {
  id: number;
  symbolId: number;
  symbolKey: string;
  commitSha: string;
  authorName: string | null;
  authorEmail: string | null;
  committedAt: number;
  message: string | null;
  linesAdded: number;
  linesRemoved: number;
  prNumber: number | null;
  prUrl: string | null;
  matchStrategy: string;
  confidence: number;
}

export interface StatsRow {
  files: number;
  symbols: number;
  edges: number;
  resolvedEdges: number;
  languages: Record<string, number>;
  roles?: { project: number; vendor: number; generated: number; test: number };
  routes?: number;
  externalDependencies?: number;
  configKeys?: number;
  symbolHistory?: number;
}
