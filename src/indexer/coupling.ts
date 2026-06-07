/**
 * Temporal / logical coupling ("changes-with").
 *
 * Seer's wedge is symbol-level git history. This turns that history into an
 * EDIT-IMPACT signal: when you are about to edit symbol X, which other symbols
 * have historically changed in the same commits? That coupling is invisible to
 * the static call graph — it surfaces links through shared serialization
 * formats, protocol constants, parallel implementations, and config that no
 * caller/callee edge records.
 *
 * Deterministic and zero-AI: it is a pure aggregation over the existing
 * `symbol_history` rows (see Store.coupledSymbols). Honest by construction —
 * huge sweeping commits are dropped as noise, confidence is a plain
 * conditional probability over the non-noisy commits, and everything is
 * confidence-labelled and advisory. It never claims a coupling is causal.
 */
import { Store } from '../db/store.js';

export interface CouplingPartner {
  symbol: {
    id: number;
    name: string;
    qualifiedName: string | null;
    kind: string;
    file: string;
    lineStart: number;
  };
  /** Non-noisy commits where this partner changed together with the target. */
  sharedCommits: number;
  /** P(partner changed | target changed) over the non-noisy commits, 0..1. */
  confidence: number;
  /** Total commits that touched the partner (its base change rate). */
  partnerCommits: number;
  /** True when the partner lives in the same file as the target (proximity
   *  coupling — usually weaker evidence than a cross-file link). */
  sameFile: boolean;
}

export interface CouplingResult {
  ok: boolean;
  reason?: string;
  symbol?: {
    id: number;
    name: string;
    qualifiedName: string | null;
    kind: string;
    file: string;
    lineStart: number;
  };
  /** Distinct commits that touched the target in the window. */
  targetCommits: number;
  /** Commits used after dropping noisy/sweeping ones (the confidence denominator). */
  effectiveCommits: number;
  /** Commits excluded because they touched more than `maxCommitSymbols` symbols. */
  noisyCommitsIgnored: number;
  partners: CouplingPartner[];
  source: 'git-history';
}

export interface CouplingOptions {
  /** Commits touching more than this many distinct symbols are dropped as noise. Default 50. */
  maxCommitSymbols?: number;
  /** Minimum shared commits for a partner to be reported. Default 2. */
  minSupport?: number;
  /** Max partners returned. Default 20. */
  limit?: number;
  /** Unix-seconds lower bound on commit time. */
  since?: number;
  /** Include partners in the same file as the target. Default true. */
  includeSameFile?: boolean;
}

/**
 * Compute coupling partners for an already-resolved symbol id. Returns ok:false
 * with a reason when the symbol is gone; an empty `partners` list with
 * `targetCommits: 0` means "no (built) history overlaps this symbol" — the
 * caller should look at the history-index status to tell that apart from
 * "history not built yet".
 */
export function computeCoupling(
  store: Store, symbolId: number, options: CouplingOptions = {},
): CouplingResult {
  const target = store.getSymbolById(symbolId);
  if (!target) {
    return { ok: false, reason: `no symbol id ${symbolId}`, targetCommits: 0, effectiveCommits: 0, noisyCommitsIgnored: 0, partners: [], source: 'git-history' };
  }
  const includeSameFile = options.includeSameFile !== false;
  // Over-fetch a little when same-file partners may be filtered out, so the
  // post-filter list can still reach `limit`.
  const limit = Math.max(1, Math.min(options.limit ?? 20, 200));
  const raw = store.coupledSymbols(symbolId, {
    maxCommitSymbols: options.maxCommitSymbols,
    minSupport: options.minSupport,
    since: options.since,
    limit: includeSameFile ? limit : limit * 3,
  });

  const denom = raw.effectiveCommits > 0 ? raw.effectiveCommits : 1;
  const partners: CouplingPartner[] = [];
  for (const r of raw.rows) {
    const sym = store.getSymbolById(r.symbolId);
    if (!sym) continue;
    const sameFile = sym.fileId === target.fileId;
    if (!includeSameFile && sameFile) continue;
    partners.push({
      symbol: {
        id: sym.id, name: sym.name, qualifiedName: sym.qualifiedName,
        kind: sym.kind, file: sym.filePath, lineStart: sym.lineStart,
      },
      sharedCommits: r.support,
      confidence: Math.round((r.support / denom) * 100) / 100,
      partnerCommits: r.partnerCommits,
      sameFile,
    });
    if (partners.length >= limit) break;
  }

  return {
    ok: true,
    symbol: {
      id: target.id, name: target.name, qualifiedName: target.qualifiedName,
      kind: target.kind, file: target.filePath, lineStart: target.lineStart,
    },
    targetCommits: raw.targetCommits,
    effectiveCommits: raw.effectiveCommits,
    noisyCommitsIgnored: raw.noisyCommitsIgnored,
    partners,
    source: 'git-history',
  };
}
