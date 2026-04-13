/**
 * Analyser Agent
 *
 * Reads Playwright test results (JSON reporter output or JUnit XML) plus any
 * artefacts in test-results/ and uses Claude to produce a structured failure
 * post-mortem: root cause category, confidence, evidence, and a concrete fix.
 *
 * Model: claude-sonnet-4-6 — strong analysis without extended thinking overhead
 * (analysis/summarisation does not benefit from chain-of-thought reasoning).
 * Prompt caching: system prompt is cached so repeated runs stay cheap.
 *
 * Usage:
 *   npx tsx tests/agents/analyser.ts                              # auto-detect results
 *   npx tsx tests/agents/analyser.ts --results results.json       # explicit JSON
 *   npx tsx tests/agents/analyser.ts --results junit.xml          # JUnit XML
 *   npx tsx tests/agents/analyser.ts --output report.md           # save to file
 *   npx tsx tests/agents/analyser.ts --compare run-a.json run-b.json  # flakiness diff
 */

import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';

const client = new Anthropic();

// ── System prompt (cached) ──────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a senior Playwright test automation engineer performing a failure post-mortem.

For each failed test produce a structured entry in this exact format:

### <Full Test Name>
**Root cause**: [Broken locator | App regression | Environment issue | Test data collision | Timing/flakiness | Config error | Auth failure]
**Confidence**: [High | Medium | Low]
**Evidence**: The key line(s) from the error or stack trace that confirm the diagnosis — quote them exactly.
**Fix**: A concrete, actionable next step. Be specific: name the locator to change, the endpoint to check, the Docker command to run.

---

Group tests that share the same root cause under a single heading and list the affected test names beneath it.

Finish with a **## Summary** section containing:
- Total: X passed, Y failed, Z skipped
- Most common failure category
- Overall health verdict: ✅ Healthy | ⚠️ At Risk | 🔴 Critical
- One priority action the team should take before the next release

Be concise and technical. Your audience is a senior QA engineer who reads error traces for a living.`;

// ── Result readers ──────────────────────────────────────────────────────────

/**
 * Pre-processes Playwright JSON reporter output to extract only the information
 * Claude needs: suite stats + failure details with error messages and stack traces.
 * Raw JSON for large suites can be several MB of passing-test metadata — sending
 * that to Claude wastes tokens and adds no diagnostic value.
 */
function parsePlaywrightResultsJson(filePath: string): string {
  const raw = fs.readFileSync(filePath, 'utf-8');
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return raw; // Malformed JSON — pass as-is so Claude can at least see the raw output
  }

  const lines: string[] = ['=== Playwright JSON Test Results ===', ''];

  const stats = data['stats'] as Record<string, number> | undefined;
  if (stats) {
    lines.push(
      `Total: ${stats['expected'] ?? 0} passed, ${stats['unexpected'] ?? 0} failed, ${stats['skipped'] ?? 0} skipped`,
      `Duration: ${((stats['duration'] ?? 0) / 1000).toFixed(1)}s`,
      '',
    );
  }

  const failures: string[] = [];
  const walk = (suite: Record<string, unknown>, prefix = '') => {
    const title = prefix ? `${prefix} > ${suite['title']}` : String(suite['title'] ?? '');
    for (const spec of (suite['specs'] as Record<string, unknown>[] | undefined) ?? []) {
      const tests = (spec['tests'] as Record<string, unknown>[] | undefined) ?? [];
      for (const t of tests) {
        const status = String(t['status'] ?? '');
        if (status === 'unexpected' || status === 'failed') {
          const entry: string[] = [`FAIL: ${title} > ${spec['title']}`];
          const results = (t['results'] as Record<string, unknown>[] | undefined) ?? [];
          for (const result of results) {
            const error = result['error'] as Record<string, unknown> | undefined;
            if (error) {
              // Both message and stack go into the same entry so they stay together
              const msg = String(error['message'] ?? '');
              if (msg) entry.push(`  Error: ${msg.split('\n').slice(0, 5).join('\n         ')}`);
              const stack = String(error['stack'] ?? '');
              if (stack) {
                entry.push(
                  `  Stack:\n${stack.split('\n').slice(0, 8).map((l) => `    ${l}`).join('\n')}`,
                );
              }
            }
          }
          failures.push(...entry, '');
        }
      }
    }
    for (const child of (suite['suites'] as Record<string, unknown>[] | undefined) ?? []) {
      walk(child, title);
    }
  };
  walk(data as Record<string, unknown>);

  if (failures.length > 0) {
    lines.push('=== Failures ===', '', ...failures);
  } else {
    lines.push('=== No failures detected ===');
  }

  return lines.join('\n');
}

function parseJunitXml(filePath: string): string {
  const xml = fs.readFileSync(filePath, 'utf-8');

  const suiteMatches = [
    ...xml.matchAll(
      /<testsuite[^>]*name="([^"]*)"[^>]*tests="(\d+)"[^>]*failures="(\d+)"[^>]*errors="(\d+)"[^>]*skipped="(\d+)"/g,
    ),
  ];

  const caseMatches = [
    ...xml.matchAll(/<testcase[^>]*name="([^"]*)"[^>]*classname="([^"]*)"[^>]*>([\s\S]*?)<\/testcase>/g),
  ];

  const lines: string[] = ['=== JUnit XML Test Results ===', ''];

  for (const [, name, tests, failures, errors, skipped] of suiteMatches) {
    lines.push(`Suite: ${name}`);
    lines.push(`  Total: ${tests} | Failures: ${failures} | Errors: ${errors} | Skipped: ${skipped}`);
    lines.push('');
  }

  const failures = caseMatches.filter(([, , , body]) => body.includes('<failure') || body.includes('<error'));

  if (failures.length > 0) {
    lines.push('=== Failures ===', '');
    for (const [, name, classname, body] of failures) {
      lines.push(`FAIL: ${classname} > ${name}`);
      const msgMatch = body.match(/message="([^"]*)"/);
      if (msgMatch) lines.push(`  Message: ${msgMatch[1]}`);
      const textMatch = body.match(/<(?:failure|error)[^>]*>([\s\S]*?)<\/(?:failure|error)>/);
      if (textMatch) {
        const detail = textMatch[1].trim().split('\n').slice(0, 15).join('\n');
        lines.push(`  Stack:\n${detail}`);
      }
      lines.push('');
    }
  } else {
    lines.push('=== No failures detected ===');
  }

  return lines.join('\n');
}

// ── Artefact scanner ────────────────────────────────────────────────────────

interface Artefacts {
  errorContexts: string;
  screenshotPaths: string[];
  tracePaths: string[];
}

function collectArtefacts(dir: string): Artefacts {
  const errorContexts: string[] = [];
  const screenshotPaths: string[] = [];
  const tracePaths: string[] = [];

  if (!fs.existsSync(dir)) return { errorContexts: '', screenshotPaths, tracePaths };

  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name === 'error-context.md') {
        errorContexts.push(`\n--- ${full} ---\n${fs.readFileSync(full, 'utf-8')}`);
      } else if (/\.(png|jpg|jpeg)$/i.test(entry.name)) {
        screenshotPaths.push(full);
      } else if (entry.name === 'trace.zip') {
        tracePaths.push(full);
      }
    }
  };

  walk(dir);
  // Cap total error context to ~8 KB — beyond that it's noise not signal for Claude
  const joined = errorContexts.join('\n');
  const capped =
    joined.length > 8_000
      ? joined.slice(0, 8_000) + '\n\n<!-- error-context truncated — showing first 8 KB -->'
      : joined;
  return { errorContexts: capped, screenshotPaths, tracePaths };
}

// ── Flakiness comparison ────────────────────────────────────────────────────

function extractTestStatuses(resultsJson: string): Map<string, string> {
  const statuses = new Map<string, string>();
  try {
    const data = JSON.parse(resultsJson);
    const walk = (suite: Record<string, unknown>, prefix = '') => {
      const title = prefix ? `${prefix} > ${suite['title']}` : String(suite['title'] ?? '');
      for (const spec of (suite['specs'] as Record<string, unknown>[] | undefined) ?? []) {
        const key = `${title} > ${spec['title']}`;
        const tests = (spec['tests'] as Record<string, unknown>[] | undefined) ?? [];
        if (tests.length > 0) {
          statuses.set(key, String(tests[0]['status'] ?? 'unknown'));
        }
      }
      for (const child of (suite['suites'] as Record<string, unknown>[] | undefined) ?? []) {
        walk(child, title);
      }
    };
    walk(data as Record<string, unknown>);
  } catch {
    // Malformed JSON — return empty map
  }
  return statuses;
}

function buildFlakinessReport(pathA: string, pathB: string): string {
  const statusA = extractTestStatuses(fs.readFileSync(pathA, 'utf-8'));
  const statusB = extractTestStatuses(fs.readFileSync(pathB, 'utf-8'));

  const lines = [
    '=== Flakiness Comparison Report ===',
    `Run A: ${pathA}`,
    `Run B: ${pathB}`,
    '',
    'Tests that changed status between runs:',
    '',
  ];

  let flakyCount = 0;
  const allKeys = new Set([...statusA.keys(), ...statusB.keys()]);

  for (const key of allKeys) {
    const a = statusA.get(key) ?? 'missing';
    const b = statusB.get(key) ?? 'missing';
    if (a !== b) {
      lines.push(`  FLAKY: ${key}`);
      lines.push(`    Run A: ${a}  →  Run B: ${b}`);
      flakyCount++;
    }
  }

  lines.push('');
  lines.push(
    flakyCount === 0
      ? '✅ No status changes detected — results are consistent between runs.'
      : `⚠️  ${flakyCount} test(s) changed status — investigate for race conditions, selector timing, or environment variance.`,
  );

  return lines.join('\n');
}

// ── Main analyser ───────────────────────────────────────────────────────────

async function analyse(resultsSource: string, outputPath: string | null): Promise<void> {
  const { errorContexts, screenshotPaths, tracePaths } = collectArtefacts('test-results');

  const artefactNotes: string[] = [];
  if (screenshotPaths.length > 0) {
    const names = screenshotPaths.map((f) => path.relative('test-results', f)).join(', ');
    artefactNotes.push(`📸 ${screenshotPaths.length} failure screenshot(s): ${names}`);
  }
  if (tracePaths.length > 0) {
    artefactNotes.push(
      `🔍 ${tracePaths.length} Playwright trace(s) captured — run the trace-inspector agent for deep timeline analysis:\n` +
        tracePaths.map((p) => `   npx tsx tests/agents/traceInspector.ts --trace "${p}"`).join('\n'),
    );
  }

  const userContent = [
    '## Test Results',
    '```',
    resultsSource,
    '```',
    errorContexts ? `\n## Error Contexts\n${errorContexts}` : '',
    artefactNotes.length > 0 ? `\n## Captured Artefacts\n${artefactNotes.join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  console.error('Analysing results with Claude Sonnet...\n');

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
    messages: [{ role: 'user', content: userContent }],
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
    const header = `# Playwright Failure Analysis\n_Generated: ${new Date().toISOString()}_\n\n`;
    fs.writeFileSync(outputPath, header + fullText, 'utf-8');
    console.error(`✓ Report saved to: ${outputPath}`);
  }
}

// ── Entry point ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const resultsFlag = args.indexOf('--results');
const outputFlag = args.indexOf('--output');
const compareFlag = args.indexOf('--compare');
const outputPath = outputFlag !== -1 ? args[outputFlag + 1] : null;

if (compareFlag !== -1) {
  const pathA = args[compareFlag + 1];
  const pathB = args[compareFlag + 2];
  if (!pathA || !pathB) {
    console.error('Usage: analyser.ts --compare <run-a.json> <run-b.json>');
    process.exit(1);
  }
  analyse(buildFlakinessReport(pathA, pathB), outputPath).catch(console.error);
} else {
  let resultsSource: string | null = null;

  const resultsFile = resultsFlag !== -1 ? args[resultsFlag + 1] : null;
  if (resultsFile) {
    if (!fs.existsSync(resultsFile)) {
      console.error(`Results file not found: ${resultsFile}`);
      process.exit(1);
    }
    resultsSource = resultsFile.endsWith('.xml') ? parseJunitXml(resultsFile) : parsePlaywrightResultsJson(resultsFile);
  } else {
    const candidates = [
      'test-results/results.json',
      'test-results/junit.xml',
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        resultsSource = c.endsWith('.xml') ? parseJunitXml(c) : parsePlaywrightResultsJson(c);
        console.error(`Auto-detected: ${c}`);
        break;
      }
    }
  }

  if (!resultsSource) {
    console.error(
      'No results file found. Generate one with:\n' +
        '  npx playwright test --reporter=json > test-results/results.json\n' +
        'Or pass explicitly: --results <file>',
    );
    process.exit(1);
  }

  analyse(resultsSource, outputPath).catch(console.error);
}
