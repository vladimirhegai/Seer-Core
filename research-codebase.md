# Research Codebases for Seer

This note analyzes the three local codebases under `Resources/`: `aider`, `codebase-memory-mcp`, and `scip`. It uses the checked-in source as the primary evidence, with official public references used only to clarify purpose and project positioning.

Public references:
- Aider GitHub: https://github.com/Aider-AI/aider
- Aider repo map docs: https://aider.chat/docs/repomap.html
- Codebase Memory MCP GitHub: https://github.com/DeusData/codebase-memory-mcp
- Codebase-Memory paper: https://arxiv.org/abs/2603.27277
- SCIP GitHub: https://github.com/scip-code/scip
- SCIP site: https://scip-code.org/
- Sourcegraph SCIP announcement: https://sourcegraph.com/blog/announcing-scip

## Executive Synthesis

These three repos map cleanly onto Seer's intended architecture. Aider is the strongest reference for the interactive agent loop: how to budget code context, rank a repository map, talk to many models, apply edits, run tests, and keep a human in control. Codebase Memory MCP is the strongest reference for Seer's L0/L1 substrate: fast local indexing, tree-sitter extraction, SQLite graph storage, graph query tools, call tracing, semantic search, Louvain-style communities, and an MCP-facing tool API. SCIP is the strongest reference for interoperability and symbol identity: it gives Seer a precise external format for symbols, definitions, references, ranges, relationships, and index validation.

The practical architecture suggested by these repos is: use a Codebase-Memory-like pipeline for local graph construction, make Seer's internal symbol and occurrence model SCIP-compatible, then expose an Aider-like context and navigation layer that never loads raw source unless a user or agent has a specific reason to descend to L0. Aider proves that a small ranked map is better than a giant prompt. Codebase Memory proves that graph tools can replace wasteful grep/read loops. SCIP proves that symbol identity and source ranges need a real protocol, not ad hoc strings.

## Aider

### What It Is

Aider is a Python terminal AI pair programmer for real git repositories. It wraps model selection, terminal I/O, chat state, repo mapping, edit formats, patch application, git commits, lint/test loops, URL/image input, and interactive slash commands into one local workflow. Its central product idea is that an LLM should receive a compact, ranked map of the repository plus explicitly added files, then ask for more context only when needed. In the local checkout, the main application is under `Resources/aider/aider`, edit strategies live under `Resources/aider/aider/coders`, tree-sitter repo-map logic lives in `Resources/aider/aider/repomap.py`, git integration lives in `Resources/aider/aider/repo.py`, and command handling lives in `Resources/aider/aider/commands.py`.

### Technical Analysis for Seer

Aider is highly relevant to Seer because it has already solved a smaller version of Seer's "how does an AI navigate a codebase without wasting tokens?" problem. `RepoMap` extracts definitions and references with tree-sitter queries, falls back to Pygments when references are missing, builds a file graph, ranks it with PageRank, then renders only selected lines of interest through `grep_ast.TreeContext`. This is essentially Seer L1 plus a lightweight L2 rendering layer. It is not a full knowledge graph and does not preserve rich edge semantics, but the ranking and token-budget mechanics are exactly the kind of behavior Seer needs when deciding which modules, symbols, and snippets belong in an answer.

The `Coder` hierarchy is also a useful product reference. `Coder.create()` chooses an edit format based on model capabilities, `format_messages()` assembles the final prompt, `send_message()` manages retries and context-window failures, `apply_updates()` delegates edits to specific coder implementations, and the post-edit loop can auto-commit, lint, test, and reflect errors back into the model. Seer should not become an edit agent first, but onboarding eventually becomes active: "try this kata", "make this safe change", "explain why this test failed". Aider's loop shows how to connect explanation, code context, edits, and verification without making every response a raw source dump.

The most important design constraint Aider reinforces is that the map must be dynamic. Aider boosts files already in chat, mentioned identifiers, mentioned filenames, long meaningful identifiers, and files connected by reference edges. Seer should do the same across L2-L5: if the user asks about `BillingWebhookProcessor`, increase rank for the symbol, its file, its module, its callers, its tests, and its temporal ancestors. The repo map should be a context-packing algorithm, not a static document.

### Implementation Path for Seer

1. Build a first Seer repo-map prototype from Aider's pattern: tree-sitter definitions, references, file graph, PageRank, token-bounded rendering of lines of interest.
2. Replace file-level tags with Seer's richer L1 symbol graph: symbols, call edges, import edges, tests, routes, config, and temporal metadata.
3. Implement a context packer that uses Aider-style personalization: active files, mentioned identifiers, recently viewed nodes, current L4/L5 summaries, and query terms.
4. Add "ask for more context" affordances to Seer chat: source is loaded only through deliberate `read_source(file, range)` or equivalent.
5. Reuse the Aider edit-loop concept later for onboarding katas: run test, capture failure, ask the model to explain, compare against original PR or expected fix.
6. Keep Seer's output provenance stricter than Aider's. Every generated explanation should cite graph nodes, source ranges, commits, PRs, or summaries.

### Codebase Graph for AI Navigation

Use this map when an AI needs to inspect Aider without walking the whole repo.

```text
Resources/aider/
  README.md
    Product summary, features, install, public docs links.

  pyproject.toml
    Package metadata and dependency hints.

  aider/__main__.py
    Minimal Python module entry point.

  aider/main.py
    CLI bootstrap.
    Flow:
      main(argv)
        -> load config and env
        -> parse args
        -> select model
        -> build GitRepo
        -> build Commands
        -> Coder.create(...)
        -> optional lint/test/commit/show-map modes
        -> interactive coder.run()
    Read this for startup, config, model selection, and app lifecycle.

  aider/coders/base_coder.py
    Core agent loop.
    Flow:
      Coder.create()
        -> choose subclass by edit_format
      Coder.__init__()
        -> setup repo, files, repo map, linter, summarizer
      get_repo_map()
        -> RepoMap.get_repo_map(...)
      format_messages()
        -> assemble system, repo map, file context, readonly files, history
      send_message()
        -> LLM call, retries, output capture, edit application, lint/test reflection
      apply_updates()
        -> subclass-specific edit parsing and file writes
    Read this for prompt assembly, token checks, chat state, and post-edit verification.

  aider/coders/
    Edit strategy layer.
    Key files:
      architect_coder.py
        Two-stage "architect then editor" workflow.
      patch_coder.py
        Custom patch format parser/applier.
      editblock_coder.py
        Search/replace blocks with fuzzy matching.
      udiff_coder.py
        Unified diff parsing/application.
      wholefile_coder.py
        Whole-file replacement mode.
      *_prompts.py
        Prompt templates for each edit mode.
    Read here when studying model-specific edit formats or patch robustness.

  aider/repomap.py
    Token-efficient repository map.
    Flow:
      get_tags_raw()
        -> tree-sitter query captures definitions/references
      get_ranked_tags()
        -> build file graph from def/ref edges
        -> personalize with chat files and mentioned identifiers
        -> networkx PageRank
      get_ranked_tags_map_uncached()
        -> binary search how many ranked tags fit token budget
      to_tree()
        -> render selected lines of interest per file
    Read this first for Seer L1/L2 context-packing ideas.

  aider/queries/tree-sitter-languages/
    Language-specific tag queries used by RepoMap.
    Read only when adding or debugging a language.

  aider/repo.py
    Git integration.
    Handles tracked files, ignore logic, diffs, commits, dirty files, and commit-message generation.
    Read this for local-first git behavior and safe repo boundaries.

  aider/commands.py
    Slash command dispatcher.
    Key commands: /add, /drop, /map, /map-refresh, /tokens, /lint, /test, /run, /git, /commit, /undo, /ask, /code, /architect, /context.
    Read this for user-facing command workflows.

  aider/models.py
    Model registry and provider abstraction through LiteLLM/OpenRouter/local providers.
    Read this for token counting, model settings, edit-format selection, weak/editor models, thinking tokens, and environment validation.

  aider/io.py
    Terminal I/O, prompts, confirmations, autocomplete, output styling, chat history.
    Read this for human-in-the-loop ergonomics.

  aider/linter.py, aider/run_cmd.py
    Lint/test/shell execution support.
    Read this for verification loops.

  aider/watch.py, aider/watch_prompts.py
    IDE/watch-file integration.
    Read this for comment-driven or file-change-driven workflows.

  tests/basic/
    Unit tests for core modules.
    Start at test_repomap.py, test_coder.py, test_commands.py, test_repo.py, test_main.py, test_linter.py.

  benchmark/
    SWE-bench and editing benchmarks.
    Read this when designing Seer evaluation suites.
```

High-value Aider paths for Seer:
- Repo-map ranking: `aider/repomap.py`
- Agent prompt assembly: `aider/coders/base_coder.py`
- Edit/verification loop: `aider/coders/base_coder.py`, `aider/linter.py`, `aider/repo.py`
- Commands and UX: `aider/commands.py`, `aider/io.py`
- Model abstraction: `aider/models.py`

## Codebase Memory MCP

### What It Is

Codebase Memory MCP is a C code intelligence engine exposed as an MCP server and CLI. It indexes repositories into a persistent SQLite-backed knowledge graph using tree-sitter grammars, language-specific extractors, LSP-style type resolution, semantic scoring, graph traversals, cross-service linking, git-diff impact analysis, and optional 3D graph visualization. The local checkout is mostly C under `Resources/codebase-memory-mcp/src` and `Resources/codebase-memory-mcp/internal/cbm`, with a React/Vite graph UI under `Resources/codebase-memory-mcp/graph-ui`. Its README positions it as a structural analysis backend for AI coding agents rather than an LLM agent itself.

### Technical Analysis for Seer

This is the closest existing implementation to Seer's deterministic L0/L1 layer. It already has the shape Seer wants: discovery, tree-sitter parsing, extraction passes, a graph buffer, SQLite storage, query tools, semantic edges, call tracing, route nodes, cross-repo links, background watching, and a compressed graph artifact for team sharing. The pipeline comments in `src/pipeline/pipeline.h` describe the core pass order: structure, definitions, imports, calls, usages, semantic edges, then post-passes for tests, communities, HTTP links, config, and git history. That maps almost one-to-one onto Seer's source/symbol/module substrate.

The strongest implementation idea to borrow is the separation between indexing and intelligence. Codebase Memory does not try to answer natural language questions itself. It gives the agent precise tools: `index_repository`, `search_graph`, `query_graph`, `trace_path`, `get_code_snippet`, `get_graph_schema`, `get_architecture`, `search_code`, `detect_changes`, `manage_adr`, and `ingest_traces`. Seer should follow that principle. The LLM should formulate questions and synthesize answers, while deterministic tools return bounded, cited graph facts.

The second major idea is pipeline caching. `pass_parallel.c` describes a three-phase pipeline where files are read and parsed once, results are cached, and later resolution passes reuse `CBMFileResult` rather than reparsing. Seer's full L0-L5 system should adopt this discipline: L0/L1 extraction should produce stable artifacts that are reused by L2 summaries, L3 clustering, L4 subsystem synthesis, and temporal indexing. Repeated parse and repeated LLM summarization are both architectural smells.

The third idea is graph enrichment beyond plain calls. The codebase has extractors for definitions, imports, calls, usages, semantic structures, type references, environment access, channels, Kubernetes, service patterns, cross-repo routes, similarity, semantic edges, and git history. Seer's onboarding goal needs the same breadth. New hires do not only ask "what calls this function?" They ask "what feature area owns this?", "what external service does it hit?", "what config controls it?", "which tests protect it?", and "what changed recently?" Codebase Memory shows that many of these can be deterministic graph edges before any LLM writes prose.

The main place Seer should diverge is the user-facing layer. Codebase Memory is a powerful backend, but Seer needs an onboarding-oriented hierarchy: L2 file summaries, L3 module summaries, L4 subsystem views, L5 system overview, temporal narratives, katas, citations, and confidence markings. Codebase Memory gives the fact substrate; Seer must add durable explanation products on top.

### Implementation Path for Seer

1. Define Seer's internal graph schema by borrowing Codebase Memory's node/edge families: Project, Folder, File, Module, Function, Method, Class, Route, Config, Test, ADR, Commit, PR, Issue, plus edges like CONTAINS, DEFINES, IMPORTS, CALLS, INHERITS, IMPLEMENTS, TESTS, HTTP_CALLS, DATA_FLOWS, SIMILAR_TO, CHANGED_IN, INTRODUCED_BY, FIXED_BY.
2. Build an MVP indexer with the same pass shape: discover files, create structure nodes, extract definitions, resolve imports, resolve calls, extract usages, then write to SQLite.
3. Add graph query tools before adding a chat UI. Minimum tool surface: `search_graph`, `read_symbol`, `trace_calls`, `impact`, `architecture`, `schema`, `list_modules`, `time_travel`.
4. Add Louvain or Leiden module clustering over weighted call/import/test edges. Store cluster membership as deterministic L3 candidates before asking an LLM to summarize.
5. Add artifact sharing similar to `.codebase-memory/graph.db.zst`, but extend it with content hashes and summary parent hashes so teams can share both graph and L2-L5 summaries.
6. Add temporal passes after stable L1 graph indexing: git history, per-symbol chains, commit classification, PR/issue linking, and causal edges.
7. Keep MCP compatibility in mind, even if Seer ships its own UI. MCP-style tools are an excellent boundary between deterministic graph retrieval and LLM synthesis.

### Codebase Graph for AI Navigation

Use this map when an AI needs to inspect Codebase Memory MCP without getting lost in generated grammars and vendored code.

```text
Resources/codebase-memory-mcp/
  README.md
    Product, feature list, tools, performance claims, install, graph artifact, MCP behavior.

  Makefile.cbm
    Build and test wiring for the C codebase.

  src/main.c
    Binary entry point.
    Flow:
      main()
        -> parse subcommands and UI flags
        -> run config/update/install/uninstall/cli modes
        -> create MCP server
        -> create watcher
        -> optional HTTP graph UI
        -> run MCP stdio loop
    Read this for process lifecycle and CLI-vs-MCP behavior.

  src/mcp/mcp.c, src/mcp/mcp.h
    MCP JSON-RPC server and tool dispatch.
    Key concepts:
      TOOLS[] defines tool names, descriptions, JSON schemas.
      cbm_mcp_handle_tool(...) routes calls.
      Query tools open SQLite stores.
      Indexing tools call the pipeline.
    Read this for the external API Seer should emulate or integrate.

  src/pipeline/
    Indexing pipeline and graph construction.
    Main files:
      pipeline.h
        Public pipeline API and high-level pass order.
      pipeline.c
        Orchestrates discovery, structure, definitions, LSP cross pass, calls, usages, semantics, tests, git history, artifact export.
      pipeline_internal.h
        Shared pipeline context and pass declarations.
      pass_parallel.c
        Optimized read/parse-once parallel extraction/resolution path.
      pass_definitions.c
        Converts extraction results into graph nodes and registry entries.
      pass_lsp_cross.c
        Builds project-wide LSP inputs and merges resolved calls back into results.
      pass_calls.c
        Resolves call edges from extracted calls and LSP results.
      pass_usages.c
        Usage and type-reference edges.
      pass_semantic.c
        INHERITS, DECORATES, IMPLEMENTS.
      pass_semantic_edges.c
        SEMANTICALLY_RELATED edges from combined signals.
      pass_similarity.c
        SIMILAR_TO near-clone detection.
      pass_route_nodes.c
        Route nodes and service edges.
      pass_cross_repo.c
        Cross-project route/channel matching.
      pass_githistory.c
        Git history and change coupling.
      pass_gitdiff.c
        Changed-file impact inputs.
      pass_tests.c
        Test detection and test graph enrichment.
      pass_configlink.c, pass_configures.c, pass_envscan.c, pass_infrascan.c, pass_k8s.c
        Config, environment, and infrastructure edges.
      artifact.c
        Compressed graph artifact import/export.
      registry.c
        Function registry used during resolution.
      worker_pool.c
        Parallel execution primitive.
    Read this first for Seer's L0/L1 indexer design.

  internal/cbm/
    Tree-sitter extraction core and language registry.
    Main files:
      cbm.h
        Central data model: definitions, calls, imports, usages, type refs, env accesses, channels, resolved calls, file result.
      cbm.c
        Parse/extract orchestration per file.
      extract_defs.c
        Definition extraction across languages.
      extract_imports.c
        Import extraction.
      extract_calls.c
        Call extraction.
      extract_unified.c
        Unified tree-sitter extraction pass.
      extract_semantic.c, extract_type_refs.c, extract_type_assigns.c, extract_usages.c
        Additional semantic extraction.
      extract_channels.c
        Pub-sub/channel edges.
      extract_k8s.c
        Kubernetes resource extraction.
      lang_specs.c, lang_specs.h
        Language specs and node type lists.
      grammar_*.c
        Thin language grammar bridge files.
      vendored/grammars/
        Huge generated tree-sitter parsers. Ignore unless debugging a parser.
    Read this for extraction internals and the shape of L1 facts.

  internal/cbm/lsp/
    Language-specific LSP-style type resolution.
    Key files:
      type_rep.c/.h
        Internal type representation.
      type_registry.c/.h
        Registered funcs/types and lookup.
      scope.c/.h
        Lexical scope binding.
      go_lsp.c, c_lsp.c, ts_lsp.c, py_lsp.c, php_lsp.c, cs_lsp.c
        Per-language type-aware call resolution.
    Read this when Seer needs more precise call graphs than tree-sitter can provide.

  src/store/store.c, src/store/store.h
    SQLite graph store.
    Responsibilities:
      schema creation
      node/edge upsert
      search
      traversal
      architecture summaries
      Louvain community detection
      project/file metadata
    Read this for persistence, query APIs, and graph algorithms.

  src/graph_buffer/
    In-memory graph buffer before SQLite dump.
    Read this for bulk write strategy and ID management.

  src/cypher/cypher.c
    Cypher-like query engine.
    Read this for custom graph query language tradeoffs.

  src/semantic/
    Semantic scoring and AST profiles.
    Read this for embedding-like or code-shape similarity signals.

  src/simhash/
    MinHash/LSH and near-clone detection.
    Read this for duplicate/similarity edges.

  src/discover/
    File discovery, gitignore handling, language detection, user config.
    Read this for repo walking and ignore semantics.

  src/watcher/
    Background change detection and reindex callbacks.
    Read this for local incremental updates.

  src/traces/
    Runtime trace ingestion.
    Read this for future dynamic-behavior graph edges.

  src/ui/
    Embedded HTTP server, layout, and UI asset serving.

  graph-ui/
    React/Vite 3D graph visualization.
    Key files:
      src/App.tsx
      src/hooks/useGraphData.ts
      src/components/GraphScene.tsx
      src/components/GraphTab.tsx
      src/components/NodeDetailPanel.tsx
      src/components/StatsTab.tsx
      src/api/rpc.ts
    Read this for graph visualization UX, not for indexing logic.

  tests/
    Large C test suite.
    Start with:
      test_pipeline.c
      test_store_*.c
      test_mcp.c
      test_*_lsp.c
      test_cypher.c
      test_incremental.c
      test_integration.c
```

High-value Codebase Memory paths for Seer:
- Indexer orchestration: `src/pipeline/pipeline.c`, `src/pipeline/pipeline.h`
- Extraction model: `internal/cbm/cbm.h`, `internal/cbm/cbm.c`, `internal/cbm/extract_*.c`
- Storage/query: `src/store/store.c`, `src/store/store.h`
- Tool API: `src/mcp/mcp.c`
- Cross-file precision: `src/pipeline/pass_lsp_cross.c`, `internal/cbm/lsp/*`
- Temporal/impact seeds: `src/pipeline/pass_githistory.c`, `src/pipeline/pass_gitdiff.c`
- Visualization reference: `graph-ui/src/components/GraphScene.tsx`, `graph-ui/src/components/StatsTab.tsx`

## SCIP

### What It Is

SCIP, the SCIP Code Intelligence Protocol, is a language-agnostic protocol for source-code indexes. It is not a full codebase explainer and not primarily a storage engine; its design docs explicitly describe it as a transmission format from producers such as language indexers to consumers such as Sourcegraph or other code intelligence tools. The repo contains the Protobuf schema `scip.proto`, Go and Rust bindings, generated TypeScript and Haskell bindings, a `scip` CLI for linting/printing/snapshotting/testing/converting indexes, and `reprolang`, a tiny test language for deterministic SCIP fixture generation.

### Technical Analysis for Seer

SCIP matters to Seer because it solves the hardest low-level naming problem: how to identify code symbols across languages, packages, files, local scopes, definitions, references, implementations, type definitions, and source ranges. Seer could invent its own symbol string format, but SCIP already has a rigorous grammar: scheme, package manager/name/version, descriptors, local symbols, roles, relationships, symbol kinds, signatures, documentation, diagnostics, and enclosing ranges. Seer should treat SCIP as either an import/export format or the inspiration for its internal L1 identity layer.

The most useful SCIP field for Seer beyond basic definitions is `Occurrence.enclosing_range`. SCIP's schema calls out call hierarchies, symbol outlines, breadcrumbs, expand selection, and hover ranges as applications. For Seer, enclosing ranges are also the bridge from L1 to L2: they let us attach a definition occurrence to the complete AST span that should be summarized, cited, diffed, and time-traveled. They are also crucial for test linkage and behavioral explanations because a reference inside a function body should belong to that enclosing function, not just to a file.

SCIP's relationship model is also directly relevant. `Relationship` supports reference, implementation, type definition, and definition relationships. Seer can extend this idea internally with temporal and architectural relationships while retaining a SCIP-compatible core. For example, `IMPLEMENTS`, `INHERITS`, and `TYPE_DEFINES` can be imported from SCIP; `INTRODUCED_BY`, `FIXED_BY`, `TESTED_BY`, `CONFIGURES`, and `EXPLAINS` can be Seer-native.

The CLI is a useful validation model. `scip lint`, `scip print`, `scip snapshot`, `scip test`, `scip stats`, and experimental SQLite conversion show the operational tools a serious index format needs. Seer should ship similar "trust the index" tools: validate graph invariants, print symbol neighborhoods, snapshot expected navigation, show stats, and convert/import external indexes.

### Implementation Path for Seer

1. Define Seer's canonical symbol ID with SCIP compatibility in mind: package identity plus descriptor path plus local symbol support. Avoid opaque integer IDs as the public identity.
2. Add a SCIP importer that maps `Index -> Project`, `Document -> File`, `SymbolInformation -> Symbol nodes`, `Occurrence -> Definition/Reference/Read/Write edges`, and `Relationship -> semantic edges`.
3. Add a SCIP exporter for Seer's deterministic L1 layer so other tools can consume Seer indexes.
4. Use SCIP as a fallback precision source when language-specific indexers are available. For example, import `scip-typescript`, `scip-python`, `scip-clang`, or `rust-analyzer` outputs instead of relying only on tree-sitter heuristics.
5. Build Seer graph validation commands inspired by `scip lint` and `scip snapshot`: validate ranges, missing definitions, duplicate symbols, unresolved references, and broken temporal parent links.
6. Store source ranges with explicit position encoding. SCIP's UTF-8/UTF-16/UTF-32 distinction is not optional if Seer wants editor-grade citations and Monaco integration.
7. Keep SCIP as transmission, not storage. Internally Seer still needs a query-optimized SQLite graph and summary store.

### Codebase Graph for AI Navigation

Use this map when an AI needs to inspect SCIP without confusing it with unrelated "SCIP" projects.

```text
Resources/scip/
  README.md
    Project summary, included artifacts, known indexers, install instructions.

  scip.proto
    The core protocol.
    Main concepts:
      Index
        metadata + documents + external_symbols
      Metadata
        protocol version, tool info, project root, text encoding
      Document
        relative_path, language, occurrences, symbols, optional text, position_encoding
      Symbol
        scheme + package + descriptors
      SymbolInformation
        documentation, relationships, kind, display name, signature, enclosing symbol
      Relationship
        reference, implementation, type definition, definition links
      Occurrence
        range, symbol, roles, syntax kind, diagnostics, enclosing_range
      SymbolRole
        Definition, Import, WriteAccess, ReadAccess, Generated, Test, ForwardDefinition
    Read this first for Seer symbol identity, ranges, and relationship semantics.

  docs/DESIGN.md
    Design rationale.
    Key decisions:
      SCIP is a transmission format, not a storage format.
      Protobuf enables static types and streaming.
      String IDs are preferred over integer IDs.
      Direct graph encoding is avoided to improve indexer parallelism and debugging.
    Read this before designing Seer's import/export boundary.

  docs/CLI.md
    CLI reference.
    Commands:
      lint
      print
      snapshot
      stats
      test
      expt-convert
    Read this when designing Seer diagnostics and golden tests.

  cmd/scip/
    Go CLI implementation.
    Key files:
      main.go
        Command registration and app setup.
      lint.go
        Index validation.
      print.go
        Debug output.
      snapshot.go
        Human-readable golden snapshots.
      test.go
        Test-file validation.
      stats.go
        Index statistics.
      convert.go
        Experimental SCIP-to-SQLite conversion.
    Read this for operational tooling around an index format.

  bindings/go/scip/
    Rich Go helper library.
    Key files:
      scip.pb.go
        Generated schema bindings.
      symbol.go
        Parse/validate symbol API.
      symbol_parser.go
        Low-allocation symbol parser.
      symbol_formatter.go
        Symbol string formatting.
      parse.go
        Streaming parse helpers.
      canonicalize.go
        Canonicalization utilities.
      flatten.go
        Merge duplicate documents, symbols, occurrences, relationships.
      sort.go
        Stable ordering.
      position.go
        Range/position helpers.
      source_file.go
        Source-file utilities.
    Read this if implementing Seer in Go or porting symbol parsing ideas.

  bindings/rust/
    Rust bindings and symbol helpers.
    Read this if Seer's indexer is Rust.

  bindings/typescript/
    Generated TypeScript bindings.
    Read this if Seer's prototype is TypeScript and needs SCIP import/export.

  bindings/haskell/
    Generated Haskell bindings.
    Usually low priority for Seer.

  reprolang/
    Tiny deterministic language used to test SCIP features.
    Key files:
      README.md
      grammar.js
      repro/indexer.go
      repro/scip.go
      repro/parser.go
      repro/namer.go
      testdata/
    Read this for an excellent pattern for Seer golden tests: small artificial programs that produce known graph facts.
```

High-value SCIP paths for Seer:
- Protocol schema: `scip.proto`
- Design rationale: `docs/DESIGN.md`
- Index validation/snapshots: `cmd/scip/lint.go`, `cmd/scip/snapshot.go`, `cmd/scip/test.go`
- Symbol parser/formatter: `bindings/go/scip/symbol_parser.go`, `bindings/go/scip/symbol_formatter.go`
- Dedup/canonicalization: `bindings/go/scip/flatten.go`, `bindings/go/scip/canonicalize.go`
- Deterministic fixture language: `reprolang/`

## Combined Implementation Direction for Seer

The most effective path is not to pick one of these repos as "the base." They solve different layers:

1. Use SCIP's data model for symbol identity, source ranges, occurrence roles, and import/export.
2. Use Codebase Memory's architecture for local indexing, graph storage, query tools, and deterministic enrichment passes.
3. Use Aider's repo-map and agent loop ideas for token-bounded context packing, conversation flow, and human-in-the-loop workflows.
4. Add Seer's unique layer on top: L2-L5 recursive summaries, temporal causal graph, per-symbol time travel, epoch narratives, onboarding paths, katas, and confidence-scored citations.

The first Seer MVP should avoid building a beautiful chat UI before the graph is trustworthy. A better sequence is:

1. Index one repo into SQLite with stable symbol IDs and source ranges.
2. Query definitions, references, callers, imports, and tests from the graph.
3. Render an Aider-style ranked map from the graph.
4. Cluster modules with Louvain/Leiden and create L3 candidates.
5. Generate L2 file summaries and L3 module summaries with citations.
6. Add a minimal chat agent that navigates through graph tools.
7. Add temporal indexing and per-symbol history.
8. Build the polished onboarding UI once the facts and citations are solid.

## Quick Lookup Table

| Seer Question | Best Reference | Where To Look |
|---|---|---|
| How should an AI see a huge repo without reading it all? | Aider | `aider/repomap.py`, `aider/coders/base_coder.py` |
| How should files/symbols be ranked for a prompt? | Aider | `RepoMap.get_ranked_tags()` |
| How should Seer expose graph tools to an agent? | Codebase Memory MCP | `src/mcp/mcp.c` |
| How should local graph indexing be structured? | Codebase Memory MCP | `src/pipeline/*`, `internal/cbm/*` |
| How should Seer store/query graph facts? | Codebase Memory MCP | `src/store/store.c`, `src/store/store.h` |
| How should Seer discover modules? | Codebase Memory MCP plus Louvain paper | `src/store/store.c` Louvain functions |
| How should symbol IDs and ranges work? | SCIP | `scip.proto`, `bindings/go/scip/symbol_parser.go` |
| How should index quality be tested? | SCIP | `cmd/scip/*`, `reprolang/` |
| How should onboarding connect to edits/tests later? | Aider | `base_coder.py`, `repo.py`, `commands.py`, `linter.py` |
| How should cross-language precision be imported? | SCIP | External SCIP indexers and `scip.proto` |

