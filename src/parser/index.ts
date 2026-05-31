import type { FileExtraction, Language } from '../types.js';
import { ParserContext, detectLanguage } from './parserContext.js';

// Re-export the pure helpers — they hold no state and can move freely.
export { detectLanguage };
export { detectLanguage as getLanguage };

// ── Default ParserContext for the main-thread API ────────────────────────────
//
// Historically this file held module-level WASM state. After the Step 1
// refactor that state lives in `ParserContext`, and this module backs the
// legacy free-function API (`parseFile`, `wasmResetCount`,
// `setForceBaselineWalker`) with a single lazily-instantiated default
// instance. Worker threads construct their own `ParserContext` directly from
// `./parserContext.js` and do NOT go through these shims.

let _defaultContext: ParserContext | null = null;
function getDefaultContext(): ParserContext {
  if (!_defaultContext) _defaultContext = new ParserContext();
  return _defaultContext;
}

export async function parseFile(
  content: string,
  filePathOrLanguage: string,
  languageOverride?: Language,
): Promise<FileExtraction | null> {
  return getDefaultContext().parseFile(content, filePathOrLanguage, languageOverride);
}

export function wasmResetCount(): number {
  return getDefaultContext().wasmResetCount();
}

export function setForceBaselineWalker(force: boolean): void {
  getDefaultContext().setForceBaselineWalker(force);
}
