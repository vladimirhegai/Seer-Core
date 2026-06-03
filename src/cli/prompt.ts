import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import type { ClientId } from './init.js';

/**
 * Interactive `seer init` wizard.
 *
 * The non-interactive installer has to *guess* which agent you use, and when
 * the guess is wrong it writes config for clients you never asked for (the
 * classic "I installed for Antigravity and it also wrote .cursor/ and
 * .vscode/"). A guess is the wrong tool for a one-time setup step — so when a
 * human is at the keyboard we just ask. Everything here is opt-in and the
 * defaults are the safe choice, so mashing Enter does the sensible thing.
 *
 * This module only collects answers. It performs no file writes itself; the
 * caller feeds the result back into the pure `runInit` planner. That keeps the
 * installer testable (tests drive `runInit` directly and never see a prompt).
 */

/** Human-facing client catalogue, in the order we present it. */
const CLIENT_MENU: Array<{ id: ClientId; label: string; hint: string }> = [
  { id: 'antigravity', label: 'Google Antigravity',  hint: 'IDE / CLI' },
  { id: 'claude',      label: 'Claude Code',          hint: 'CLI or IDE extension' },
  { id: 'codex',       label: 'OpenAI Codex',         hint: 'CLI or IDE extension' },
  { id: 'cursor',      label: 'Cursor',               hint: '' },
  { id: 'gemini',      label: 'Gemini CLI',           hint: '' },
  { id: 'vscode',      label: 'VS Code',              hint: 'Copilot / native MCP' },
  { id: 'windsurf',    label: 'Windsurf',             hint: 'user-level config' },
];

/** Agent extensions that can run *inside* Antigravity and read their own MCP config. */
const ANTIGRAVITY_EXTENSIONS: Array<{ id: ClientId; label: string }> = [
  { id: 'claude', label: 'Claude extension' },
  { id: 'codex',  label: 'Codex extension' },
  { id: 'gemini', label: 'Gemini extension' },
];

export interface WizardAnswers {
  clients: ClientId[];
  index: boolean;
  symbolHistory: boolean;
}

/**
 * Minimal I/O surface the wizard needs. Real runs back this with readline; tests
 * inject a scripted version so the full branching is verifiable without a TTY
 * (faking isTTY over a pipe makes readline drain the whole buffer at once).
 */
export interface PromptIO {
  question(prompt: string): Promise<string>;
  log(line: string): void;
}

export function isInteractive(): boolean {
  return Boolean(stdin.isTTY && stdout.isTTY);
}

/** Parse "1,3" / "1 3" / "1, 3" into the matching menu ids; ignores out-of-range. */
export function parseSelection<T>(raw: string, menu: T[]): T[] {
  const picks = new Set<number>();
  for (const tok of raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)) {
    const n = parseInt(tok, 10);
    if (!isNaN(n) && n >= 1 && n <= menu.length) picks.add(n - 1);
  }
  return [...picks].sort((a, b) => a - b).map((i) => menu[i]);
}

async function confirm(io: PromptIO, question: string, defaultYes: boolean): Promise<boolean> {
  const suffix = defaultYes ? '[Y/n]' : '[y/N]';
  const answer = (await io.question(`${question} ${suffix} `)).trim().toLowerCase();
  if (!answer) return defaultYes;
  return answer === 'y' || answer === 'yes';
}

/** Build the default readline-backed I/O for a real interactive run. */
function readlineIO(): { io: PromptIO; close: () => void } {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  return {
    io: { question: (q) => rl.question(q), log: (l) => console.log(l) },
    close: () => rl.close(),
  };
}

/**
 * Run the wizard. `detected` is the installer's best guess at the active
 * client(s); it pre-selects the menu so the common case is a single Enter.
 * Returns null if the user bails out (empty client selection / Ctrl-C).
 *
 * Pass `io` to drive it programmatically (tests); omit it for a real terminal.
 */
export async function runInitWizard(detected: ClientId[], io?: PromptIO): Promise<WizardAnswers | null> {
  const backing = io ? null : readlineIO();
  const prompt = io ?? backing!.io;
  try {
    prompt.log('\nSeer setup\n');

    // 1 ─ Which agent(s)?
    const defaultIdx = CLIENT_MENU
      .map((c, i) => (detected.includes(c.id) ? i + 1 : 0))
      .filter((n) => n > 0);
    const defaultLabel = defaultIdx.length ? defaultIdx.join(',') : '1';

    prompt.log('Which AI agent(s) are you setting up Seer for?');
    for (let i = 0; i < CLIENT_MENU.length; i++) {
      const c = CLIENT_MENU[i];
      const tag = detected.includes(c.id) ? '  (detected)' : '';
      const hint = c.hint ? ` — ${c.hint}` : '';
      prompt.log(`  ${i + 1}) ${c.label}${hint}${tag}`);
    }
    const rawClients = (await prompt.question(`Enter number(s), comma-separated [${defaultLabel}]: `)).trim();
    const picked = rawClients
      ? parseSelection(rawClients, CLIENT_MENU).map((c) => c.id)
      : defaultIdx.map((n) => CLIENT_MENU[n - 1].id);

    if (picked.length === 0) {
      prompt.log('\nNo agent selected — nothing to set up. Re-run when ready.\n');
      return null;
    }

    // 2 ─ Antigravity hosts other agent extensions; offer to wire those too.
    if (picked.includes('antigravity')) {
      prompt.log('\nAntigravity can also host Claude, Codex, and Gemini agent extensions.');
      prompt.log('Set up Seer for any of those too? (each reads its own MCP config)');
      ANTIGRAVITY_EXTENSIONS.forEach((e, i) => prompt.log(`  ${i + 1}) ${e.label}`));
      const rawExt = (await prompt.question('Enter number(s), or leave blank to skip []: ')).trim();
      if (rawExt) {
        for (const e of parseSelection(rawExt, ANTIGRAVITY_EXTENSIONS)) {
          if (!picked.includes(e.id)) picked.push(e.id);
        }
      }
    }

    // 3 ─ Index now? (recommended)
    prompt.log('');
    const index = await confirm(
      prompt,
      'Index this repo now? Builds the local map so the first agent query is instant. (recommended)',
      true,
    );

    // 4 ─ Symbol history? Only meaningful if we are indexing. Off by default —
    // a full history walk is slow on large repos and is fully optional.
    let symbolHistory = false;
    if (index) {
      symbolHistory = await confirm(
        prompt,
        'Also index per-symbol git history? Powers seer_history, but is slow on large repos. (not recommended for big repos)',
        false,
      );
    }

    return { clients: picked, index, symbolHistory };
  } finally {
    backing?.close();
  }
}
