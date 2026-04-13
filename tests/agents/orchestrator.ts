/**
 * Orchestrator Agent
 *
 * Looks at which files have changed (via git diff) and uses Claude to decide
 * the minimal set of Playwright tests that need to run.  Outputs a ready-to-run
 * `npx playwright test` command and optionally executes it.
 *
 * Usage:
 *   npx tsx tests/agents/orchestrator.ts              # diff against HEAD
 *   npx tsx tests/agents/orchestrator.ts --run        # diff and execute
 *   npx tsx tests/agents/orchestrator.ts --base main  # diff against main branch
 */

import Anthropic from '@anthropic-ai/sdk';
import { execSync, spawn } from 'child_process';

const client = new Anthropic();

// ── helpers ────────────────────────────────────────────────────────────────

function getChangedFiles(base = 'HEAD'): string[] {
  try {
    const output = execSync(`git diff --name-only ${base}`, {
      encoding: 'utf-8',
    });
    return output.trim().split('\n').filter(Boolean);
  } catch {
    // Fallback: all tracked files if git isn't available
    return [];
  }
}

function getStagedFiles(): string[] {
  try {
    const output = execSync('git diff --cached --name-only', {
      encoding: 'utf-8',
    });
    return output.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function runCommand(cmd: string): void {
  console.log(`\nRunning: ${cmd}\n`);
  const [bin, ...cmdArgs] = cmd.split(' ');
  const proc = spawn(bin, cmdArgs, { stdio: 'inherit', shell: true });
  proc.on('close', (code) => {
    process.exit(code ?? 0);
  });
}

// ── main ───────────────────────────────────────────────────────────────────

async function orchestrate(base: string, shouldRun: boolean) {
  const changed = [...getChangedFiles(base), ...getStagedFiles()];
  const unique = [...new Set(changed)];

  if (unique.length === 0) {
    console.log('No changed files detected. Running full suite.');
    if (shouldRun) runCommand('npx playwright test');
    return;
  }

  const prompt = `You are a Playwright CI orchestrator for a TypeScript Playwright framework.

Project structure:
- tests/api/          API specs (--project=api)
- tests/ui/           UI specs (--project=chromium or --project=firefox or --project=webkit)
- tests/accessibility/ A11y specs (--project=chromium)
- tests/performance/   Performance specs (--project=chromium)
- tests/pages/         Page objects (not test files — used by UI tests)
- tests/actions/       Multi-step flows (used by UI tests)
- tests/data/          Test data factories (used by all tests)
- tests/fixtures/      Fixtures (used by all tests)
- playwright.config.ts Config changes affect everything

Changed files:
${unique.map((f) => `  - ${f}`).join('\n')}

Rules:
- If playwright.config.ts changed → run ALL tests
- If tests/data/ or tests/fixtures/ changed → run ALL tests
- If tests/pages/ changed → run the UI tests that use those pages (and API if relevant)
- If tests/api/ changed → run only api project
- If tests/ui/ changed → run only affected spec files
- If CI config changed (azure-pipelines.yml, buildspec.yml, .circleci/) → no tests needed
- Minimise what runs to save CI minutes

Respond with ONLY a single shell command starting with "npx playwright test".
No explanation. No markdown. Just the command.`;

  console.log(`Checking changed files against ${base}...\n`);
  unique.forEach((f) => console.log(`  ${f}`));
  console.log('\nAsking Claude which tests to run...\n');

  const response = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 256,
    messages: [{ role: 'user', content: prompt }],
  });

  const command =
    response.content[0].type === 'text'
      ? response.content[0].text.trim()
      : 'npx playwright test';

  console.log(`Recommended command:\n  ${command}\n`);

  if (shouldRun) {
    runCommand(command);
  }
}

// ── entry point ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const baseFlag = args.indexOf('--base');
const base = baseFlag !== -1 ? args[baseFlag + 1] : 'HEAD';
const shouldRun = args.includes('--run');

orchestrate(base, shouldRun);
