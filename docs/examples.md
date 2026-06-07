# Examples

Real workflows, the way an agent (or you, from the CLI) would actually use Seer.
Each one links to a fuller walkthrough.

The outputs below are illustrative and trimmed for readability. Shapes are real;
exact numbers depend on your repo.

---

## Before editing unfamiliar code

You are about to change `chargeCard`. Instead of five searches, one call:

```
seer_preflight { "symbol": "chargeCard" }
```

You get the definition, who calls it, the tests that cover it, recent commits,
and a risk verdict in a single packet. Full walkthrough:
[Pre-edit context](examples/pre-edit-context.md).

---

## Find the tests that actually exercise a symbol

```
seer_behavior { "symbol": "chargeCard" }
```

Ranked by how directly each test hits the symbol, not just filename matching.
Full walkthrough: [Behavior and tests](examples/behavior-tests.md).

---

## Follow routes across service boundaries

```
seer_service_links { "pathSubstr": "/invoices" }
```

See which client call in one service resolves to which route handler in another.
Full walkthrough: [Service links](examples/service-links.md).

---

## Understand recent changes

```
seer_preflight { "fromRef": "main", "toRef": "HEAD" }
```

Maps the diff to the affected symbols and their blast radius, then layers on the
history for each. Full walkthrough: [Change history](examples/change-history.md).

---

## Read a giant file cheaply

```
seer_skeleton { "file": "src/server.ts" }
```

Returns every signature with bodies collapsed to `{ ... 40 lines ... }`. Add
`focusSymbol` to expand exactly one body. A 2,000-line file becomes an outline
you can scan for a few hundred tokens.

---

## Find the real argument patterns before writing a new call

You are about to add a new call to `buildInvoice`. Instead of reading the source
file, pull a few call sites with their surrounding context:

```
seer_callers { "symbol": "buildInvoice", "limit": 5, "includeSnippets": true, "snippetContext": 2 }
```

Each result includes the actual source lines around the call — real argument
patterns, not just where the function is called. `snippetContext` controls how
many lines above and below to include (default 2, max 6). Use a small `limit`;
snippets are for sampling patterns, not reading all 80 call sites.

---

## Find what else tends to change alongside a symbol

You are editing `serializeMessage` and want to know whether there are sibling
symbols that have historically changed with it — shared format constants,
parallel implementations, a companion deserializer — coupling that the call graph
cannot see:

```
seer_changes_with { "symbol": "serializeMessage" }
```

The response lists partner symbols with `sharedCommits` (how many commits they
co-changed in) and `confidence` (P(partner changed | target changed) over
non-noisy commits). Check `historyComplete` first: when `false`, the full
symbol-history index has not been built and partners may be partial or absent.
Results are advisory and confidence-labeled — correlation, not causation.

---

## Batch several lookups into one round-trip

```
seer_batch { "calls": [
  { "tool": "seer_definition", "args": { "name": "chargeCard" } },
  { "tool": "seer_callers",    "args": { "symbol": "chargeCard" } },
  { "tool": "seer_behavior",   "args": { "symbol": "chargeCard" } }
] }
```

One request, three results, failure-isolated.
