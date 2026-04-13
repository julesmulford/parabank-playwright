/**
 * Flakiness Detector Agent
 *
 * Runs a Playwright spec file N times, collects pass/fail/status per run,
 * then asks Claude to classify results as: stable-passing, stable-failing,
 * flaky (intermittent), or environment-sensitive. Produces an actionable
 * diagnosis with recommended fixes for each flaky test.
 *
 * Model: claude-sonnet-4-6 — pattern recognition across tabular results;
 * extended thinking adds no value here. Prompt caching on the analysis rubric.
 *
 * Usage:
 *   npx tsx tests/agents/flakinessDetector.ts --spec tests/ui/registration.spec.ts
 *   npx tsx tests/agents/flakinessDetector.ts --spec tests/api/parabank.spec.ts --runs 10
 *   npx tsx tests/agents/flakinessDetector.ts --spec tests/ui/login.spec.ts --runs 5 --output flaky-report.md
 */

import Anthropic from '@anthropic-ai/sdk';
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const client = new Anthropic();

// ── System prompt (cached) ──────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a senior test reliability engineer analysing Playwright test runs for flakiness.

You will receive a table of test results across multiple runs (rows = tests, columns = runs).
Each cell contains: pass | fail | skip | timeout | unknown.

Classification rules:
- **Stable-Passing**:  passes in every run — no action needed
- **Stable-Failing**:  fails in every run — this is a genuine bug, not flakiness
- **Flaky**:           mix of pass and fail — intermittent; needs reliability fix
- **Timeout-prone**:   timeouts appear in some runs — selector/network timing issue
- **Environment-sensitive**: consistent within a run but differs between runs — data or env state issue

For each test that is NOT stable-passing, produce:

### <Test Name>
**Classification**: [Stable-Failing | Flaky | Timeout-prone | Environment-sensitive]
**Pass rate**: X / Y runs (Z%)
**Run pattern**: pass/fail/pass/... (show the sequence)
**Likely cause**: <one sentence — selector timing, data collision, network latency, missing cleanup, etc.>
**Fix**: <specific, actionable recommendation>

End with a **## Reliability Summary** section:
- Total tests analysed
- Flaky count / percentage
- Most likely root-cause category across all flaky tests
- One team recommendation`;

// ── Test runner ─────────────────────────────────────────────────────────────

interface RunResult {
  runNumber: number;
  tests: Record<string, string>; // testTitle → status
  durationMs: number;
}

function parsePlaywrightJson(jsonPath: string): Record<string, string> {
  const tests: Record<string, string> = {};
  if (!fs.existsSync(jsonPath)) return tests;
  try {
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    const walk = (suite: Record<string, unknown>, prefix = '') => {
      const title = prefix ? `${prefix} > ${suite['title']}` : String(suite['title'] ?? '');
      for (const spec of (suite['specs'] as Record<string, unknown>[] | undefined) ?? []) {
        const key = `${title} > ${spec['title']}`;
        const testArr = (spec['tests'] as Record<string, unknown>[] | undefined) ?? [];
        tests[key] = String(testArr[0]?.['status'] ?? 'unknown');
      }
      for (const child of (suite['suites'] as Record<string, unknown>[] | undefined) ?? []) {
        walk(child, title);
      }
    };
    walk(data as Record<string, unknown>);
  } catch {
    // Malformed JSON — return empty (run still counted, status = 'missing')
  }
  return tests;
}

function runSpec(specFile: string, runNumber: number, tmpDir: string): RunResult {
  // PLAYWRIGHT_JSON_OUTPUT_NAME controls where the JSON reporter writes its file.
  // --output sets the artifact folder (screenshots/videos) — do NOT use it for JSON.
  // stdio: 'pipe' suppresses all console output without needing shell redirects,
  // so this works correctly on both Windows and Unix.
  const jsonOut = path.join(tmpDir, `run-${runNumber}.json`);
  const start = Date.now();

  try {
    execSync(`npx playwright test "${specFile}" --reporter=json`, {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 5 * 60 * 1000, // 5-minute ceiling per run — prevents indefinite hangs
      env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: jsonOut },
    });
  } catch (err) {
    // Non-zero exit is expected when tests fail — we still parse the JSON output.
    // Re-throw only on actual timeout (ETIMEDOUT) so the caller can surface it.
    if ((err as NodeJS.ErrnoException).code === 'ETIMEDOUT') throw err;
  }

  const durationMs = Date.now() - start;
  const tests = parsePlaywrightJson(jsonOut);
  return { runNumber, tests, durationMs };
}

// ── Result table builder ────────────────────────────────────────────────────

/**
 * Builds the markdown table sent to Claude. Only includes tests that are NOT
 * stable-passing — Claude gets no value from rows that are all "passed", and
 * filtering them out significantly reduces token usage on large suites.
 */
function buildResultTable(runs: RunResult[]): { table: string; stablePassCount: number } {
  const allTests = new Set<string>();
  for (const run of runs) {
    for (const key of Object.keys(run.tests)) allTests.add(key);
  }

  // Separate stable-passing from everything else
  let stablePassCount = 0;
  const unstableTests = [...allTests].filter((test) => {
    const statuses = runs.map((r) => r.tests[test] ?? 'missing');
    const isStablePass = statuses.every((s) => s === 'passed');
    if (isStablePass) stablePassCount++;
    return !isStablePass;
  });

  const header = ['Test', ...runs.map((r) => `Run ${r.runNumber}`)].join(' | ');
  const separator = ['---', ...runs.map(() => '---')].join(' | ');

  const rows = unstableTests.map((test) => {
    const statuses = runs.map((r) => r.tests[test] ?? 'missing');
    return [test, ...statuses].join(' | ');
  });

  const durations = runs.map((r) => `Run ${r.runNumber}: ${(r.durationMs / 1000).toFixed(1)}s`).join(', ');

  const table = [
    `## Results (${stablePassCount} stable-passing tests omitted — only non-stable shown)`,
    header,
    separator,
    ...(rows.length > 0 ? rows : ['(all tests stable-passing)']),
    '',
    `## Run durations`,
    durations,
  ].join('\n');

  return { table, stablePassCount };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function detectFlakiness(
  specFile: string,
  runs: number,
  outputPath: string | null,
): Promise<void> {
  if (!fs.existsSync(specFile)) {
    console.error(`Spec file not found: ${specFile}`);
    process.exit(1);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-flaky-'));
  console.error(`Running "${specFile}" ${runs} time(s)...\n`);

  const results: RunResult[] = [];
  for (let i = 1; i <= runs; i++) {
    process.stderr.write(`  Run ${i}/${runs}... `);
    const result = runSpec(specFile, i, tmpDir);
    const statusCounts = Object.values(result.tests).reduce<Record<string, number>>((acc, s) => {
      acc[s] = (acc[s] ?? 0) + 1;
      return acc;
    }, {});
    const summary = Object.entries(statusCounts)
      .map(([s, c]) => `${c} ${s}`)
      .join(', ');
    console.error(`${summary} (${(result.durationMs / 1000).toFixed(1)}s)`);
    results.push(result);
  }

  // Cleanup temp dir
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
  }

  const { table, stablePassCount } = buildResultTable(results);
  const totalTests = new Set(results.flatMap((r) => Object.keys(r.tests))).size;
  console.error(
    `\n${stablePassCount}/${totalTests} tests stable-passing (omitted from Claude context).`,
  );

  if (totalTests > 0 && stablePassCount === totalTests) {
    console.log('\n✅ All tests passed in every run — no flakiness detected.');
    return;
  }

  console.error('Asking Claude to classify flakiness patterns...\n');

  const userMessage = `## Spec file: ${specFile}\n## Number of runs: ${runs}\n\n${table}`;

  const stream = await client.messages.stream({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{ role: 'user', content: userMessage }],
  });

  let fullText = '';
  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      process.stdout.write(event.delta.text);
      fullText += event.delta.text;
    }
  }
  console.log('\n');

  if (outputPath) {
    const header =
      `# Flakiness Detection Report\n` +
      `_Spec: ${specFile} | Runs: ${runs} | Generated: ${new Date().toISOString()}_\n\n`;
    fs.writeFileSync(outputPath, header + fullText, 'utf-8');
    console.error(`✓ Report saved to: ${outputPath}`);
  }
}

// ── Entry point ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const specFlag = args.indexOf('--spec');
const runsFlag = args.indexOf('--runs');
const outputFlag = args.indexOf('--output');

const specFile = specFlag !== -1 ? args[specFlag + 1] : null;
const rawRuns = runsFlag !== -1 ? args[runsFlag + 1] : '5';
const runs = parseInt(rawRuns, 10);
const outputPath = outputFlag !== -1 ? args[outputFlag + 1] : null;

if (!specFile) {
  console.error(
    'Usage: npx tsx tests/agents/flakinessDetector.ts --spec <file> [--runs <n>] [--output <file>]',
  );
  process.exit(1);
}

if (isNaN(runs) || runs < 2 || runs > 50) {
  console.error('--runs must be an integer between 2 and 50.');
  process.exit(1);
}

detectFlakiness(specFile, runs, outputPath).catch((err: Error) => {
  console.error('Flakiness detector error:', err.message);
  process.exit(1);
});
