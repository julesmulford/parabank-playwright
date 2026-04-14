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

/**
 * Validates and sanitizes a git ref before shell interpolation.
 * Valid git refs contain only alphanumeric chars and a small set of punctuation —
 * anything else is a sign of injection. Exits immediately on violation.
 */
function sanitizeRef(ref: string): string {
  if (!/^[a-zA-Z0-9._\-/~^@{}]+$/.test(ref)) {
    console.error(`✗ Invalid git ref: "${ref}" — contains disallowed characters.`);
    process.exit(1);
  }
  return ref;
}

function validateRef(ref: string): boolean {
  const safe = sanitizeRef(ref); // exits on injection attempts
  try {
    execSync(`git rev-parse --verify ${safe}`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

function getChangedFiles(base: string): string[] {
  const safe = sanitizeRef(base);
  try {
    // --diff-filter=ACMR: Added, Copied, Modified, Renamed-to only.
    // Excludes Deleted (D) and Renamed-from (R old name) — a deleted test file
    // should not trigger its own test run, and the old name of a rename no longer exists.
    const out = execSync(`git diff --name-only --diff-filter=ACMR ${safe}`, {
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
    // --diff-filter=ACMR: same filter as getChangedFiles — exclude deleted and
    // renamed-from files so we don't try to run specs that no longer exist on disk.
    const out = execSync('git diff --cached --name-only --diff-filter=ACMR', {
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

// ── Deterministic pre-computation ──────────────────────────────────────────
// The 8 decision rules in SYSTEM_PROMPT are fully deterministic. Evaluate them
// in TypeScript first — Claude is only invoked for genuinely ambiguous cases
// (e.g. a mix of api + ui spec changes, agents/ files, or unknown directories).
// This makes the orchestrator free to run for the vast majority of CI invocations.

function computeCommandLocally(changed: string[]): string | null {
  // Rule 1: global config changed → full suite, all projects
  if (changed.some((f) => f === 'playwright.config.ts')) return 'npx playwright test';

  // Rule 2: shared test infrastructure (data, fixtures) → full suite
  if (changed.some((f) => f.startsWith('tests/data/') || f.startsWith('tests/fixtures/'))) {
    return 'npx playwright test';
  }

  // Rule 3: page objects or action flows changed → all UI tests on chromium
  if (changed.some((f) => f.startsWith('tests/pages/') || f.startsWith('tests/actions/'))) {
    return 'npx playwright test --project=chromium';
  }

  // Split into runnable test files vs everything else.
  // Exclude tests/agents/ — they are developer tools, not Playwright specs.
  // Without this exclusion, editing an agent file would trigger an ambiguous
  // Claude call that always ends with "npx playwright test" (full suite).
  const testFiles = changed.filter(
    (f) => f.startsWith('tests/') && !f.startsWith('tests/agents/'),
  );

  // Rule 8: only non-test files changed (docs, CI yaml, agent scripts, etc.) → nothing to run
  if (testFiles.length === 0) return 'no-tests-needed';

  // Rule 4: only API specs
  if (testFiles.every((f) => f.startsWith('tests/api/'))) {
    return 'npx playwright test --project=api';
  }

  // Rule 6: only accessibility specs
  if (testFiles.every((f) => f.startsWith('tests/accessibility/'))) {
    return 'npx playwright test tests/accessibility/ --project=chromium';
  }

  // Rule 7: only performance specs
  if (testFiles.every((f) => f.startsWith('tests/performance/'))) {
    return 'npx playwright test tests/performance/ --project=chromium';
  }

  // Rule 5: only specific UI spec files (not directories, page objects, or actions)
  if (testFiles.every((f) => f.startsWith('tests/ui/') && f.endsWith('.spec.ts'))) {
    return `npx playwright test ${testFiles.join(' ')} --project=chromium`;
  }

  // Ambiguous (mixed types, agents/ files, unknown paths) → fall through to Claude
  return null;
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

  // Try deterministic local computation first — zero API cost for all standard cases.
  const local = computeCommandLocally(changed);
  if (local !== null) {
    if (verbose) console.error(`\nDeterministic decision (no Claude call): ${local}`);
    console.log(local);
    if (local === 'no-tests-needed') {
      console.error('ℹ  Only non-test files changed — no Playwright tests required.');
      return;
    }
    if (shouldRun) runPlaywrightCommand(local);
    return;
  }

  // Ambiguous change set — delegate to Claude for the edge case
  if (verbose) console.error('\nAmbiguous change set — asking Claude...');

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

  if (verbose) console.error(`\nClaude decision: ${command}`);

  // Token logging is always emitted to stderr — not gated on --verbose.
  // CI pipelines need cost visibility even when they don't capture verbose output.
  const u = response.usage as unknown as Record<string, number>;
  const cacheNote = [
    u['cache_read_input_tokens'] ? `${u['cache_read_input_tokens']} cache-read` : '',
    u['cache_creation_input_tokens'] ? `${u['cache_creation_input_tokens']} cache-write` : '',
  ].filter(Boolean);
  console.error(
    `Tokens — in: ${u['input_tokens']}, out: ${u['output_tokens']}` +
    (cacheNote.length ? ` (${cacheNote.join(', ')})` : ''),
  );

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
