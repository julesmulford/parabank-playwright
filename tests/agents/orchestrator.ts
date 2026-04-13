/**
 * Orchestrator Agent
 *
 * Looks at which files have changed (via git diff) and uses Claude to decide
 * the minimal set of Playwright tests that need to run.  Outputs a ready-to-run
 * `npx playwright test` command and optionally executes it.
 *
 * Model: claude-haiku-4-5 — fast and cheap for a pure classification task.
 * Prompt caching: system prompt is cached so repeated CI runs pay only for
 * the short changed-file list, not the full instructions every time.
 *
 * Usage:
 *   npx tsx tests/agents/orchestrator.ts                     # diff against HEAD
 *   npx tsx tests/agents/orchestrator.ts --run               # diff and execute
 *   npx tsx tests/agents/orchestrator.ts --base main         # diff against main branch
 *   npx tsx tests/agents/orchestrator.ts --verbose           # show token usage + reasoning
 */

import Anthropic from '@anthropic-ai/sdk';
import { execSync, spawn } from 'child_process';

const client = new Anthropic();

// ── System prompt (cached — never changes between runs) ─────────────────────

const SYSTEM_PROMPT = `You are a Playwright CI orchestrator for a TypeScript Playwright framework.

Project layout:
  tests/api/            API specs          → project: api
  tests/ui/             UI specs           → projects: chromium, firefox, webkit
  tests/accessibility/  A11y specs         → project: chromium
  tests/performance/    Performance specs  → project: chromium
  tests/pages/          Page objects       (not runnable — imported by UI tests)
  tests/actions/        Multi-step flows   (not runnable — imported by UI tests)
  tests/data/           Test data          (imported by ALL tests)
  tests/fixtures/       Playwright fixtures (imported by ALL tests)
  playwright.config.ts  Global config

Decision rules — apply the FIRST rule that matches and stop:
1. playwright.config.ts changed                         → npx playwright test
2. tests/data/ OR tests/fixtures/ changed               → npx playwright test
3. tests/pages/ OR tests/actions/ changed               → npx playwright test --project=chromium
4. Only tests/api/ changed                              → npx playwright test --project=api
5. Only some tests/ui/ specs changed                    → npx playwright test <file1> <file2> --project=chromium
6. Only tests/accessibility/ changed                    → npx playwright test tests/accessibility/ --project=chromium
7. Only tests/performance/ changed                      → npx playwright test tests/performance/ --project=chromium
8. Only CI config / docs / non-test files changed       → no-tests-needed

Output exactly ONE shell command starting with "npx playwright test", or the literal string "no-tests-needed".
No explanation. No markdown fences. No surrounding quotes.`;

// ── Git helpers ─────────────────────────────────────────────────────────────

function validateRef(ref: string): boolean {
  try {
    execSync(`git rev-parse --verify "${ref}"`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

function getChangedFiles(base: string): string[] {
  try {
    const out = execSync(`git diff --name-only ${base}`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return out.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function getStagedFiles(): string[] {
  try {
    const out = execSync('git diff --cached --name-only', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return out.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

// ── Safe command runner ─────────────────────────────────────────────────────
// Splits on whitespace but respects single- and double-quoted groups so that
// file paths containing spaces survive intact.

function runPlaywrightCommand(cmd: string): void {
  console.error(`\nExecuting: ${cmd}\n${'─'.repeat(60)}`);
  const parts = cmd.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? ['npx', 'playwright', 'test'];
  const [bin, ...cmdArgs] = parts;
  const proc = spawn(bin, cmdArgs, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  proc.on('close', (code) => process.exit(code ?? 0));
}

// ── Main ────────────────────────────────────────────────────────────────────

async function orchestrate(base: string, shouldRun: boolean, verbose: boolean): Promise<void> {
  if (base !== 'HEAD' && !validateRef(base)) {
    console.error(
      `✗ Git ref "${base}" does not exist.\n` +
        `  For local diffs use: --base HEAD (default)\n` +
        `  For CI branch diffs use: --base origin/main`,
    );
    process.exit(1);
  }

  const changed = [...new Set([...getChangedFiles(base), ...getStagedFiles()])];

  if (verbose) {
    console.error(`\nChanged files (vs ${base}):`);
    if (changed.length === 0) console.error('  (none detected)');
    else changed.forEach((f) => console.error(`  + ${f}`));
  }

  if (changed.length === 0) {
    const fallback = 'npx playwright test';
    console.error('⚠  No changed files detected — running full suite as a safety net.');
    console.log(fallback);
    if (shouldRun) runPlaywrightCommand(fallback);
    return;
  }

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 256,
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      {
        role: 'user',
        content: `Changed files:\n${changed.map((f) => `- ${f}`).join('\n')}`,
      },
    ],
  });

  const command =
    response.content[0].type === 'text'
      ? response.content[0].text.trim()
      : 'npx playwright test';

  if (verbose) {
    const u = response.usage as unknown as Record<string, number>;
    console.error(`\nClaude decision: ${command}`);
    console.error(
      `Tokens — input: ${u['input_tokens']}, output: ${u['output_tokens']}, ` +
        `cache_write: ${u['cache_creation_input_tokens'] ?? 0}, cache_read: ${u['cache_read_input_tokens'] ?? 0}`,
    );
  }

  // stdout only — captured by CI pipeline
  console.log(command);

  if (command === 'no-tests-needed') {
    console.error('ℹ  Only non-test files changed — no Playwright tests required.');
    return;
  }

  if (shouldRun) runPlaywrightCommand(command);
}

// ── Entry point ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const baseFlag = args.indexOf('--base');
const base = baseFlag !== -1 ? args[baseFlag + 1] : 'HEAD';
const shouldRun = args.includes('--run');
const verbose = args.includes('--verbose');

orchestrate(base, shouldRun, verbose).catch((err: Error) => {
  console.error('Orchestrator error:', err.message);
  process.exit(1);
});
