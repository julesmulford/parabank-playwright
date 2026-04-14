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
import { streamToStdout } from './lib/streamUtils.js';

const client = new Anthropic();

// ── System prompt (cached) ──────────────────────────────────────────────────

// Used for normal --results mode: failure post-mortem
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

// Used exclusively for --compare mode: flakiness between two runs
// Kept separate because the failure post-mortem categories (Broken locator, Auth failure, etc.)
// are irrelevant when comparing two result files — the question is WHY a test flips, not
// what caused a specific error message.
const COMPARE_SYSTEM_PROMPT = `You are a senior test reliability engineer analysing flakiness between two Playwright result sets.

You will receive a list of tests that changed status between Run A and Run B (passed→failed, failed→passed, or missing).

For each flaky test produce:

### <Test Name>
**Flip direction**: [pass→fail | fail→pass | appeared | disappeared]
**Likely cause**: [Race condition | Data state leak | Environment variance | Selector timing | Auth/session expiry | Parallel isolation issue | Test order dependency]
**Confidence**: [High | Medium | Low]
**Fix**: One specific, actionable recommendation.

Finish with a **## Flakiness Summary**:
- Total flaky: N test(s)
- Most common root cause category
- Team recommendation: one sentence on the highest-priority fix

Be brief. The audience already understands Playwright internals.`;

// ── Result readers ──────────────────────────────────────────────────────────

/**
 * Shared recursive walker for Playwright JSON reporter output.
 * Both parsePlaywrightResultsJson (failure extraction) and extractTestStatuses
 * (status mapping) use the same nested suite/spec/test structure — extracting
 * this prevents the two identical recursive traversals from diverging silently.
 *
 * @param suite   The suite node (root or child) from the JSON data
 * @param visitor Called for each (fullTitle, spec, tests[]) triple found
 * @param prefix  Accumulated parent title for building fully-qualified test names
 */
type SuiteVisitor = (
  title: string,
  spec: Record<string, unknown>,
  tests: Record<string, unknown>[],
) => void;

function walkSuite(suite: Record<string, unknown>, visitor: SuiteVisitor, prefix = ''): void {
  const title = prefix ? `${prefix} > ${suite['title']}` : String(suite['title'] ?? '');
  for (const spec of (suite['specs'] as Record<string, unknown>[] | undefined) ?? []) {
    visitor(title, spec, (spec['tests'] as Record<string, unknown>[] | undefined) ?? []);
  }
  for (const child of (suite['suites'] as Record<string, unknown>[] | undefined) ?? []) {
    walkSuite(child, visitor, title);
  }
}

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

  // Cap failures sent to Claude — large suites can have 100+ failures. Beyond ~20,
  // Claude sees diminishing returns: it categorises the first failures correctly and
  // adding more just increases token cost without changing the diagnosis or summary.
  const FAILURE_CAP = 20;
  const failures: string[] = [];
  let totalFailureCount = 0;

  walkSuite(data as Record<string, unknown>, (title, spec, tests) => {
    for (const t of tests) {
      const status = String(t['status'] ?? '');
      if (status === 'unexpected' || status === 'failed') {
        totalFailureCount++;
        if (failures.length >= FAILURE_CAP) return; // count but don't append
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
                `  Stack:\n${stack.split('\n').slice(0, 5).map((l) => `    ${l}`).join('\n')}`,
              );
            }
          }
        }
        failures.push(...entry, '');
      }
    }
  });

  if (failures.length > 0) {
    const truncationNote = totalFailureCount > FAILURE_CAP
      ? [`(${totalFailureCount - FAILURE_CAP} additional failure(s) omitted — showing first ${FAILURE_CAP})`, '']
      : [];
    lines.push('=== Failures ===', '', ...failures, ...truncationNote);
  } else {
    lines.push('=== No failures detected ===');
  }

  return lines.join('\n');
}

/**
 * Extracts a named attribute from a raw XML tag string.
 * XML attributes have no guaranteed order, so a single ordered regex like
 * /name="..." tests="..." failures="..."/ silently produces no match when a
 * JUnit generator writes the attributes in a different sequence.
 */
function xmlAttr(tag: string, attr: string): string {
  const m = tag.match(new RegExp(`\\b${attr}="([^"]*)"`));
  return m ? m[1] : '';
}

function parseJunitXml(filePath: string): string {
  const xml = fs.readFileSync(filePath, 'utf-8');

  // Match the raw opening tag of every <testsuite> element (order-independent).
  const suiteTagMatches = [...xml.matchAll(/<testsuite\b[^>]*>/g)];

  const caseMatches = [
    ...xml.matchAll(/<testcase[^>]*name="([^"]*)"[^>]*classname="([^"]*)"[^>]*>([\s\S]*?)<\/testcase>/g),
  ];

  const lines: string[] = ['=== JUnit XML Test Results ===', ''];

  for (const [tag] of suiteTagMatches) {
    const name     = xmlAttr(tag, 'name');
    const tests    = xmlAttr(tag, 'tests');
    const failures = xmlAttr(tag, 'failures');
    const errors   = xmlAttr(tag, 'errors');
    const skipped  = xmlAttr(tag, 'skipped');
    if (!name && !tests) continue; // skip empty/malformed tags
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
        const detail = textMatch[1].trim().split('\n').slice(0, 8).join('\n');
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
    const data = JSON.parse(resultsJson) as Record<string, unknown>;
    walkSuite(data, (title, spec, tests) => {
      if (tests.length > 0) {
        statuses.set(`${title} > ${spec['title']}`, String(tests[0]['status'] ?? 'unknown'));
      }
    });
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

  // Cap at 30 flaky entries — enough for Claude to identify patterns without sending
  // hundreds of rows for a badly broken suite where almost every test changed status.
  const FLAKY_CAP = 30;
  let flakyCount = 0;
  const allKeys = new Set([...statusA.keys(), ...statusB.keys()]);

  for (const key of allKeys) {
    const a = statusA.get(key) ?? 'missing';
    const b = statusB.get(key) ?? 'missing';
    if (a !== b) {
      flakyCount++;
      if (flakyCount <= FLAKY_CAP) {
        lines.push(`  FLAKY: ${key}`);
        lines.push(`    Run A: ${a}  →  Run B: ${b}`);
      }
    }
  }

  if (flakyCount > FLAKY_CAP) {
    lines.push(`  (${flakyCount - FLAKY_CAP} additional flaky test(s) omitted — showing first ${FLAKY_CAP})`);
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

async function analyse(resultsSource: string, outputPath: string | null, isCompare = false): Promise<void> {
  // Early exit — zero Claude cost when all tests pass or no diff changes detected.
  // Covers both normal mode (FAIL:) and --compare mode (FLAKY:), plus JUnit XML.
  const hasFailures =
    resultsSource.includes('FAIL:') ||
    resultsSource.includes('FLAKY:') ||   // --compare mode flakiness report
    resultsSource.includes('<failure') ||
    resultsSource.includes('<error');

  if (!hasFailures) {
    const successMsg = isCompare
      ? '✅ No status changes between runs — results are consistent.'
      : '✅ All tests passed — no failures to analyse.';
    console.log(successMsg);
    if (outputPath) {
      const reportTitle = isCompare ? '# Flakiness Comparison Report' : '# Playwright Failure Analysis';
      fs.writeFileSync(
        outputPath,
        `${reportTitle}\n_Generated: ${new Date().toISOString()}_\n\n${successMsg}\n`,
        'utf-8',
      );
      console.error(`✓ Report saved to: ${outputPath}`);
    }
    return;
  }

  // Artefacts (screenshots, traces, error-context files) are only relevant for failure
  // post-mortems, not for --compare mode which diffs two JSON result files. Skip the
  // disk scan entirely in compare mode to avoid irrelevant output and unnecessary I/O.
  const { errorContexts, screenshotPaths, tracePaths } = isCompare
    ? { errorContexts: '', screenshotPaths: [], tracePaths: [] }
    : collectArtefacts('test-results');

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

  // Two-level caching:
  //   Level 1 — system prompt (analysis rubric, never changes) → always a cache hit
  //   Level 2 — test results block (stable for the same CI run, changes between runs)
  //             → cache hit when the agent is re-invoked on the same results file
  //   Level 3 — artefact notes (trace/screenshot paths, unique per run) → never cached
  const resultsBlock = `## Test Results\n\`\`\`\n${resultsSource}\n\`\`\``;
  const artefactsBlock = [
    errorContexts ? `## Error Contexts\n${errorContexts}` : '',
    artefactNotes.length > 0 ? `## Captured Artefacts\n${artefactNotes.join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  console.error('Analysing results with Claude Sonnet...\n');

  // Compare mode uses a dedicated flakiness prompt — the failure post-mortem prompt
  // asks for categories like "Broken locator | Auth failure" which don't apply when
  // comparing two run files to find tests that flip status between runs.
  const activePrompt = isCompare ? COMPARE_SYSTEM_PROMPT : SYSTEM_PROMPT;

  const stream = await client.messages.stream({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: [
      {
        type: 'text',
        text: activePrompt,
        cache_control: { type: 'ephemeral' }, // Level 1
      },
    ],
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: resultsBlock,
            cache_control: { type: 'ephemeral' }, // Level 2: stable for same run
          },
          ...(artefactsBlock
            ? [{ type: 'text' as const, text: artefactsBlock }] // Level 3: unique
            : []),
        ],
      },
    ],
  });

  const fullText = await streamToStdout(stream);

  if (outputPath) {
    const reportTitle = isCompare ? '# Flakiness Comparison Report' : '# Playwright Failure Analysis';
    const header = `${reportTitle}\n_Generated: ${new Date().toISOString()}_\n\n`;
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
  analyse(buildFlakinessReport(pathA, pathB), outputPath, true).catch(console.error);
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
      '.last-run.json',  // Playwright --last-failed writes here; check after test-results/
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
