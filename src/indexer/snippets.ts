/**
 * Bounded call-site source snippets (the `seer_usages` capability behind
 * `seer_callers includeSnippets` and `seer callers --include-snippets`).
 *
 * For an agent about to WRITE a new call to an unfamiliar function, the most
 * useful context is not where it is called but HOW — the real argument patterns
 * at a few call sites. This is pure deterministic source elision (we already own
 * the file + the call line), so it stays inside Seer's zero-AI contract and costs
 * one cached read per file.
 *
 * Shared by the MCP server and the CLI so the two surfaces can never drift on
 * the slicing/clamping rules.
 */
import fs from 'fs';

export interface CallSiteSnippet {
  /** Rendered window with 1-based `L:` markers; the call line is prefixed `>`. */
  snippet: string;
  snippetRange: { startLine: number; endLine: number };
}

/** Max physical characters kept per source line (a minified/generated line
 *  cannot blow the token budget). */
const MAX_LINE_CHARS = 400;
/** Hard ceiling on context lines either side of the call. */
const MAX_CONTEXT = 6;

/**
 * Attach a bounded snippet to each row that carries a `file` (absolute path) and
 * a 0-indexed `line` (tree-sitter `startPosition.row`, the call site). Rows whose
 * file can't be read or whose line is out of range are returned unchanged.
 * File contents are cached for the duration of one call.
 */
export function attachCallSiteSnippets<T extends { file: string; line: number }>(
  items: T[], contextLines: number,
): Array<T & Partial<CallSiteSnippet>> {
  const ctx = Math.max(0, Math.min(contextLines, MAX_CONTEXT));
  const fileCache = new Map<string, string[] | null>();
  const readLines = (abs: string): string[] | null => {
    if (fileCache.has(abs)) return fileCache.get(abs)!;
    let lines: string[] | null = null;
    try {
      let src = fs.readFileSync(abs, 'utf8');
      if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
      lines = src.split(/\r?\n/);
    } catch { lines = null; }
    fileCache.set(abs, lines);
    return lines;
  };
  return items.map(it => {
    const lines = readLines(it.file);
    if (!lines || it.line < 0 || it.line >= lines.length) return it;
    const start = Math.max(0, it.line - ctx);
    const end = Math.min(lines.length - 1, it.line + ctx);
    const rendered: string[] = [];
    for (let i = start; i <= end; i++) {
      const raw = lines[i] ?? '';
      const clipped = raw.length > MAX_LINE_CHARS ? raw.slice(0, MAX_LINE_CHARS) + ' …' : raw;
      const marker = i === it.line ? '>' : ' ';
      rendered.push(`${marker} ${i + 1}: ${clipped}`);
    }
    return { ...it, snippet: rendered.join('\n'), snippetRange: { startLine: start + 1, endLine: end + 1 } };
  });
}
