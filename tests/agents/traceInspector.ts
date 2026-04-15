/**
 * Trace Inspector Agent
 *
 * Extracts and parses a Playwright trace.zip artefact, then asks Claude to
 * produce a detailed timeline of what went wrong: the exact action that failed,
 * the network calls surrounding it, console errors, and a root-cause verdict.
 *
 * Playwright traces are zip files containing NDJSON event logs. This agent
 * extracts them using platform-native tools (PowerShell on Windows, unzip on
 * Unix) with no extra npm dependencies.
 *
 * Model: claude-opus-4-6 with enabled thinking — trace analysis is a deep
 * reasoning task: the model must correlate action timings, network events, and
 * DOM snapshots to pinpoint where the test diverged from expectations.
 * Prompt caching: the analysis rubric is cached across multiple trace files.
 *
 * Usage:
 *   npx tsx tests/agents/traceInspector.ts --trace test-results/trace.zip
 *   npx tsx tests/agents/traceInspector.ts --trace test-results/trace.zip --output analysis.md
 *   npx tsx tests/agents/traceInspector.ts --all    # inspect every trace.zip in test-results/
 */

import Anthropic from '@anthropic-ai/sdk';
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { streamToStdout } from './lib/streamUtils.js';

const client = new Anthropic();

// ── System prompt (cached) ──────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a Playwright internals expert performing a post-mortem trace analysis.

You will receive structured data extracted from a Playwright trace: a chronological action log, network activity, console messages, and any errors.

Produce a diagnosis in this format:

## Timeline of Events
A numbered, chronological list of significant actions, network requests, and console messages with their timestamps. Highlight failures or anomalies in bold.

## Failure Point
The exact action that failed or timed out, including:
- Action name and target element
- Timestamp
- Error message (verbatim)
- What Playwright expected vs what it found

## Root Cause Analysis
**Category**: [Broken locator | App bug | Network failure | Race condition | Auth/session issue | Data issue | Environment issue]
**Confidence**: [High | Medium | Low]
**Evidence**: The specific log entries that confirm this diagnosis.
**Explanation**: 2–3 sentences on what went wrong and why.

## Fix Recommendations
1. Immediate fix (to get this test passing again)
2. Long-term fix (to prevent recurrence)
3. If flakiness is suspected: a retries or wait strategy to make the test stable while the root cause is addressed

Be precise about timestamps. Quote error messages and selector strings exactly.`;

// ── Zip extraction ──────────────────────────────────────────────────────────

function extractZip(zipPath: string, destDir: string): void {
  fs.mkdirSync(destDir, { recursive: true });
  if (os.platform() === 'win32') {
    // Escape single quotes for PowerShell string literals ('' is the PS escape sequence)
    const psZip = zipPath.replace(/'/g, "''");
    const psDest = destDir.replace(/'/g, "''");
    execSync(
      `powershell -NoProfile -NonInteractive -Command "Expand-Archive -LiteralPath '${psZip}' -DestinationPath '${psDest}' -Force"`,
      { stdio: 'pipe' },
    );
  } else {
    execSync(`unzip -q "${zipPath}" -d "${destDir}"`, { stdio: 'pipe' });
  }
}

// ── Trace parser ────────────────────────────────────────────────────────────

interface TraceAction {
  type: string;
  callId?: string;
  apiName?: string;
  startTime?: number;
  endTime?: number;
  params?: Record<string, unknown>;
  error?: { message?: string; stack?: string };
  result?: unknown;
  class?: string;
  method?: string;
  time?: number;
}

interface ParsedTrace {
  actions: TraceAction[];
  networkEvents: TraceAction[];
  consoleMessages: Array<{ time: number; type: string; text: string }>;
  errors: Array<{ time: number; message: string }>;
  durationMs: number;
}

function parseTraceNdjson(ndjson: string): ParsedTrace {
  const actions: TraceAction[] = [];
  const networkEvents: TraceAction[] = [];
  const consoleMessages: Array<{ time: number; type: string; text: string }> = [];
  const errors: Array<{ time: number; message: string }> = [];

  const lines = ndjson.split('\n').filter(Boolean);
  for (const line of lines) {
    let event: TraceAction;
    try {
      event = JSON.parse(line) as TraceAction;
    } catch {
      continue;
    }

    if (event.type === 'before' || event.type === 'after' || event.type === 'action') {
      // Only collect errors from 'after' events and 'action' events into the errors
      // array — not 'before' events. 'before'-event errors are shown inline in the
      // actions log as "❌ ERROR: ...". Recording them here too causes every failed
      // action to appear twice in the formatted output (inline + Errors section),
      // doubling the error content sent to Claude.
      // 'after' events carry the completion error; 'pageError' (below) carries JS exceptions.
      if (event.type !== 'before' && event.error?.message) {
        errors.push({ time: event.startTime ?? 0, message: event.error.message });
      }
      actions.push(event);
    } else if (event.type === 'event') {
      const method = event.method ?? '';
      if (method === 'console') {
        const params = event.params as Record<string, unknown> | undefined;
        consoleMessages.push({
          time: event.time ?? 0,
          type: String((params?.['type'] as string) ?? 'log'),
          text: String((params?.['text'] as string) ?? ''),
        });
      } else if (
        method.startsWith('Request') ||
        method.startsWith('Response') ||
        method.startsWith('requestFailed')
      ) {
        networkEvents.push(event);
      } else if (method === 'pageError') {
        const params = event.params as Record<string, unknown> | undefined;
        errors.push({ time: event.time ?? 0, message: String(params?.['message'] ?? '') });
      }
    }
  }

  // Sort all event arrays chronologically before formatting — trace NDJSON files may be
  // concatenated out of order when multiple files from the same run are merged.
  actions.sort((a, b) => (a.startTime ?? a.time ?? 0) - (b.startTime ?? b.time ?? 0));
  networkEvents.sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
  consoleMessages.sort((a, b) => a.time - b.time);
  errors.sort((a, b) => a.time - b.time);

  // Use reduce instead of Math.max/min spread — spread can stack-overflow on large traces
  const times = actions.map((a) => a.startTime ?? a.endTime ?? 0).filter(Boolean);
  const durationMs =
    times.length > 1
      ? times.reduce((max, t) => (t > max ? t : max), times[0]) -
        times.reduce((min, t) => (t < min ? t : min), times[0])
      : 0;

  return { actions, networkEvents, consoleMessages, errors, durationMs };
}

/**
 * Extracts a compact failure window from the parsed trace.
 *
 * Adaptive window sizing:
 *   - 1 error: ultra-cheap mode — ±3 actions. Single clear failure needs minimal context.
 *   - 2+ errors: standard mode — ±10 actions. Multiple failures need more surrounding context.
 *
 * Also deduplicates and caps error/console-error sections so repeated timeouts or
 * identical JS exceptions don't multiply the token cost.
 */
function reduceToFailureWindow(trace: ParsedTrace, traceFile: string): string {
  const relevantActions = trace.actions.filter((a) => a.type === 'before' && a.apiName);

  // Adaptive window: single failure → tight 3-action window; multiple → wider 10-action window
  const windowHalf = trace.errors.length <= 1 ? 3 : 10;

  // Find the index of the first action that errored
  const firstFailIdx = relevantActions.findIndex((a) => a.error);

  const lines: string[] = [`## Trace file: ${traceFile}`, `Total duration: ${trace.durationMs}ms`, ''];

  if (firstFailIdx === -1 && trace.errors.length === 0) {
    lines.push(`No failures detected in ${relevantActions.length} actions.`);
    return lines.join('\n');
  }

  // Window: ±windowHalf actions around first failure; fall back to last N*2 if no action-level error
  const windowStart =
    firstFailIdx === -1
      ? Math.max(0, relevantActions.length - windowHalf * 2)
      : Math.max(0, firstFailIdx - windowHalf);
  const windowEnd =
    firstFailIdx === -1
      ? relevantActions.length
      : Math.min(relevantActions.length, firstFailIdx + windowHalf + 1);
  const windowActions = relevantActions.slice(windowStart, windowEnd);
  const failureTime =
    firstFailIdx !== -1 ? (relevantActions[firstFailIdx].startTime ?? 0) : 0;

  lines.push(
    `## Actions (${windowActions.length} of ${relevantActions.length} shown — ` +
    `±${windowHalf} window around first failure)`,
  );
  if (windowStart > 0) lines.push(`... (${windowStart} earlier action(s) omitted)`);

  // Helper: truncate a value string to avoid single long params bloating the payload
  const capStr = (s: string, max: number) => s.length > max ? s.slice(0, max) + '…' : s;

  for (const a of windowActions) {
    const ts = a.startTime ? new Date(a.startTime).toISOString().slice(11, 23) : '??';
    const paramStr = a.params
      ? Object.entries(a.params)
          .slice(0, 2) // reduced from 3 → 2: third param rarely adds diagnostic signal
          .map(([k, v]) => `${k}=${capStr(JSON.stringify(v), 60)}`)
          .join(', ')
      : '';
    const errStr = a.error ? ` ❌ ${capStr(a.error.message ?? '', 120)}` : '';
    lines.push(`[${ts}] ${a.apiName}(${paramStr})${errStr}`);
  }

  // Network events within ±2 s of the failure timestamp
  const NETWORK_WINDOW_MS = 2_000;
  const nearbyNetwork =
    failureTime > 0
      ? trace.networkEvents.filter((n) => Math.abs((n.time ?? 0) - failureTime) <= NETWORK_WINDOW_MS)
      : trace.networkEvents.slice(-8);

  if (nearbyNetwork.length > 0) {
    lines.push('', `## Network (±2 s of failure — ${nearbyNetwork.length} event(s))`);
    for (const n of nearbyNetwork.slice(0, 10)) {
      const ts = n.time ? new Date(n.time).toISOString().slice(11, 23) : '??';
      const params = n.params as Record<string, unknown> | undefined;
      const rawUrl = String(params?.['url'] ?? params?.['response'] ?? '');
      const url = capStr(rawUrl, 100); // cap long URLs — query strings rarely add signal
      const status = params?.['status'] ? ` [${params['status']}]` : '';
      const method = params?.['method'] ? ` ${params['method']}` : '';
      lines.push(`[${ts}] ${n.method}${method}${status} ${url}`);
    }
  }

  // Deduplicated errors — cap message length to avoid stack traces consuming the budget
  const ERROR_CAP = 5;
  if (trace.errors.length > 0) {
    lines.push('', '## Errors');
    const seen = new Set<string>();
    let printed = 0;
    for (const e of trace.errors) {
      const key = e.message.slice(0, 120);
      if (seen.has(key)) continue;
      seen.add(key);
      const ts = e.time ? new Date(e.time).toISOString().slice(11, 23) : '??';
      lines.push(`[${ts}] ${capStr(e.message, 200)}`); // cap at 200 — stack traces truncated
      if (++printed >= ERROR_CAP) {
        const remaining = trace.errors.length - printed;
        if (remaining > 0) lines.push(`... (${remaining} additional error(s) deduplicated)`);
        break;
      }
    }
  }

  // Console errors only — deduplicated and capped at 5
  const CONSOLE_ERROR_CAP = 5;
  const consoleErrors = trace.consoleMessages.filter((m) => m.type === 'error');
  if (consoleErrors.length > 0) {
    lines.push('', '## Console Errors');
    const seen = new Set<string>();
    let printed = 0;
    for (const m of consoleErrors) {
      const key = m.text.slice(0, 120);
      if (seen.has(key)) continue;
      seen.add(key);
      const ts = new Date(m.time).toISOString().slice(11, 23);
      lines.push(`[${ts}] ${m.text}`);
      if (++printed >= CONSOLE_ERROR_CAP) {
        const remaining = consoleErrors.length - printed;
        if (remaining > 0) lines.push(`... (${remaining} additional console error(s) deduplicated)`);
        break;
      }
    }
  }

  return lines.join('\n');
}

function formatTrace(trace: ParsedTrace, traceFile: string): string {
  const lines: string[] = [`## Trace file: ${traceFile}`, `Total duration: ${trace.durationMs}ms`, ''];

  // Actions log (most important — cap at 100 to stay within token budget)
  lines.push('## Actions (chronological)');
  const relevantActions = trace.actions
    .filter((a) => a.type === 'before' && a.apiName)
    .slice(0, 100);

  for (const a of relevantActions) {
    const ts = a.startTime ? new Date(a.startTime).toISOString().slice(11, 23) : '??';
    const paramStr = a.params
      ? Object.entries(a.params)
          .slice(0, 3)
          .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
          .join(', ')
      : '';
    const errStr = a.error ? ` ❌ ERROR: ${a.error.message}` : '';
    lines.push(`[${ts}] ${a.apiName}(${paramStr})${errStr}`);
  }

  // Network (cap at 50 entries)
  if (trace.networkEvents.length > 0) {
    lines.push('', '## Network Events');
    for (const n of trace.networkEvents.slice(0, 50)) {
      const ts = n.time ? new Date(n.time).toISOString().slice(11, 23) : '??';
      const params = n.params as Record<string, unknown> | undefined;
      const url = String(params?.['url'] ?? params?.['response'] ?? '');
      const status = params?.['status'] ? ` [${params['status']}]` : '';
      const method = params?.['method'] ? ` ${params['method']}` : '';
      lines.push(`[${ts}] ${n.method}${method}${status} ${url}`);
    }
  }

  // Console messages (cap at 20)
  if (trace.consoleMessages.length > 0) {
    lines.push('', '## Console Messages');
    for (const m of trace.consoleMessages.slice(0, 20)) {
      const ts = new Date(m.time).toISOString().slice(11, 23);
      lines.push(`[${ts}] [${m.type.toUpperCase()}] ${m.text}`);
    }
  }

  // Errors
  if (trace.errors.length > 0) {
    lines.push('', '## Errors / Exceptions');
    for (const e of trace.errors) {
      const ts = e.time ? new Date(e.time).toISOString().slice(11, 23) : '??';
      lines.push(`[${ts}] ${e.message}`);
    }
  }

  return lines.join('\n');
}

// ── Deterministic single-error diagnosis ────────────────────────────────────

/**
 * For single-error traces where the error message matches a known pattern, produce
 * a local diagnosis without calling Claude. This avoids an API call entirely for
 * the most common, self-explanatory failures (timeout, locator not found, network error).
 *
 * Returns null if the error is ambiguous or multi-cause — caller falls through to Claude.
 */
function buildDeterministicDiagnosis(trace: ParsedTrace, traceFile: string): string | null {
  if (trace.errors.length !== 1) return null;

  const error = trace.errors[0];
  const failingAction = trace.actions
    .filter((a) => a.type === 'before' && a.apiName && a.error)
    .at(0);

  // Only produce local diagnosis for clearly self-explanatory error patterns.
  // Patterns are conservative — prefer false negatives (fall through to Claude)
  // over false positives (wrong local diagnosis).
  const DIAGNOSABLE = [
    { pattern: /timeout.*exceeded|waiting.*timeout|Timeout \d+ms exceeded/i, category: 'Race condition / selector timing' },
    { pattern: /locator.*resolved.*to\s+\d+\s+element|strict mode.*resolved to \d+/i, category: 'Broken locator — multiple matches' },
    { pattern: /element.*not.*visible|element.*outside.*viewport|not visible/i, category: 'Element state issue' },
    { pattern: /no elements match|unable to find element|locator\..*resolve.*0 elements/i, category: 'Broken locator — no match' },
    { pattern: /net::ERR_|navigat.*failed|ERR_CONNECTION_REFUSED|ERR_NAME_NOT_RESOLVED/i, category: 'Network failure' },
    { pattern: /page\.close|Target closed|browser.*closed/i, category: 'Page closed unexpectedly' },
    { pattern: /AssertionError|expect\(received\)\.to|Error: Expected/i, category: 'Assertion failure' },
    { pattern: /frame.*detached|execution context.*destroyed|context was destroyed/i, category: 'Navigation race condition' },
    { pattern: /Response status code does not indicate success: [45]\d\d/i, category: 'API / HTTP error response' },
    { pattern: /Could not find.*role|getByRole.*did not find|No accessible element/i, category: 'ARIA role mismatch' },
  ];

  const matched = DIAGNOSABLE.find(({ pattern }) => pattern.test(error.message));
  if (!matched) return null; // ambiguous — let Claude reason about it

  const actionLine = failingAction
    ? `**Action**: \`${failingAction.apiName}\`(${JSON.stringify(failingAction.params ?? {})})`
    : '';

  // Nearest network failure within ±5s of the error
  const failureTime = failingAction?.startTime ?? error.time;
  const networkFail = trace.networkEvents.find((n) => {
    const params = n.params as Record<string, unknown>;
    return (
      ((params?.['status'] as number) ?? 0) >= 400 &&
      Math.abs((n.time ?? 0) - failureTime) < 5_000
    );
  });
  const networkNote = networkFail
    ? `**Nearby network failure**: \`${(networkFail.params as Record<string, unknown>)?.['url'] ?? ''}\` [${(networkFail.params as Record<string, unknown>)?.['status']}]`
    : '';

  const fixes: string[] = (() => {
    if (/timeout/i.test(error.message)) return [
      '1. **Immediate**: Replace `page.waitForTimeout()` with `expect(locator).toBeVisible()` or a specific state assertion',
      '2. **Long-term**: Add an explicit wait tied to application state rather than a fixed time',
      '3. **Flakiness guard**: Add `test.retries(1)` while investigating',
    ];
    if (/locator.*resolved.*to\s+\d+|strict mode/i.test(error.message)) return [
      '1. **Immediate**: Use `.first()` or `.nth(0)` if the first match is intentional, or make the selector more specific',
      '2. **Long-term**: Add `data-testid` attributes to disambiguate identical elements',
    ];
    if (/no elements match|unable to find/i.test(error.message)) return [
      '1. **Immediate**: Run the locator healer: `npx tsx tests/agents/locatorHealer.ts --page <PageObject.ts>`',
      '2. **Long-term**: Prefer `getByRole`/`getByLabel` over fragile id/text selectors',
      '3. **Verify**: Check whether the element is inside a shadow DOM, iframe, or behind a loading state',
    ];
    if (/net::ERR_/i.test(error.message)) return [
      '1. **Immediate**: Verify the app is running at `BASE_URL` and the DB is initialised',
      '2. **Long-term**: Add a health-check step in `beforeAll` that fails fast with a clear message',
    ];
    if (/AssertionError|expect\(received\)/i.test(error.message)) return [
      '1. **Immediate**: Check the assertion value — the app state may have changed (e.g. different text, different balance)',
      '2. **Long-term**: Assert on data shape/type rather than exact values when content is dynamic',
    ];
    if (/frame.*detached|execution context.*destroyed/i.test(error.message)) return [
      '1. **Immediate**: Add `await page.waitForLoadState(\'networkidle\')` before interacting after navigation',
      '2. **Long-term**: Avoid storing references to elements across navigation boundaries — re-query after each goto()',
    ];
    if (/Response status code does not indicate success/i.test(error.message)) return [
      '1. **Immediate**: Check the API endpoint URL and authentication headers — the server returned 4xx/5xx',
      '2. **Long-term**: Add a `beforeAll` health-check that calls the endpoint and fails fast with a readable message',
    ];
    if (/Could not find.*role|getByRole|No accessible/i.test(error.message)) return [
      '1. **Immediate**: Run the locator healer: `npx tsx tests/agents/locatorHealer.ts --page <PageObject.ts>`',
      '2. **Long-term**: Prefer `getByLabel` or `getByTestId` on elements where ARIA roles are ambiguous or missing',
    ];
    return [
      '1. **Immediate**: Run with `--trace on` and inspect with `npx playwright show-trace`',
      '2. **Long-term**: Add explicit assertions for intermediate states to narrow the failure point',
    ];
  })();

  return [
    `## Trace file: ${traceFile}`,
    '',
    '## Failure Point',
    actionLine,
    `**Error**: \`${error.message}\``,
    ...(networkNote ? [networkNote] : []),
    '',
    '## Root Cause Analysis',
    `**Category**: ${matched.category}`,
    '**Confidence**: High (pattern-matched deterministically — no Claude call)',
    `**Evidence**: Error message matches pattern \`${matched.pattern}\``,
    '',
    '## Fix Recommendations',
    ...fixes,
    '',
    '_Diagnosis generated locally. Re-run without changes to use Claude for a deeper analysis._',
  ]
    .filter((l) => l !== undefined)
    .join('\n');
}

// ── Trace file discovery ────────────────────────────────────────────────────

function findTraceFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === 'trace.zip') results.push(full);
    }
  };
  walk(dir);
  return results;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function inspectTrace(tracePath: string, outputPath: string | null): Promise<void> {
  console.error(`\n▶ Inspecting: ${tracePath}`);

  if (!fs.existsSync(tracePath)) {
    console.error(`  ✗ Trace file not found: ${tracePath}`);
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-trace-'));

  let formattedTrace = '';
  let parsedTrace: ParsedTrace | null = null;
  let traceActionCount = 0;
  let traceErrorCount = 0;
  let traceNetworkCount = 0;

  try {
    extractZip(tracePath, tmpDir);
    console.error('  ✓ Extracted trace zip');

    // Playwright traces store events in NDJSON files: trace.json, 0.json, 1.json, network.json
    const traceJsonFiles = fs
      .readdirSync(tmpDir)
      .filter((f) => f.endsWith('.json') && !f.startsWith('resources'))
      .map((f) => path.join(tmpDir, f));

    if (traceJsonFiles.length === 0) {
      // Check subdirectories (newer Playwright versions use a nested structure).
      // Skip the 'resources' subdirectory — it contains screenshot/asset blobs as
      // JSON-named files (e.g. sha256.jpeg), not trace event NDJSON files.
      for (const entry of fs.readdirSync(tmpDir, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name !== 'resources') {
          const sub = path.join(tmpDir, entry.name);
          for (const f of fs.readdirSync(sub).filter(
            (n) => n.endsWith('.json') && n !== 'resources',
          )) {
            traceJsonFiles.push(path.join(sub, f));
          }
        }
      }
    }

    if (traceJsonFiles.length === 0) {
      console.error('  ⚠ No JSON event files found in trace zip. The trace may be corrupt or use an unsupported format.');
      return;
    }

    const combinedNdjson = traceJsonFiles
      .map((f) => fs.readFileSync(f, 'utf-8'))
      .join('\n');

    parsedTrace = parseTraceNdjson(combinedNdjson);
    formattedTrace = formatTrace(parsedTrace, tracePath);
    traceActionCount = parsedTrace.actions.length;
    traceErrorCount = parsedTrace.errors.length;
    traceNetworkCount = parsedTrace.networkEvents.length;
    console.error(
      `  ✓ Parsed ${traceActionCount} actions, ${traceNetworkCount} network events, ${traceErrorCount} error(s)`,
    );
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  }

  if (!formattedTrace) return;

  // Stage 0: deterministic single-error diagnosis — skip Claude entirely for clear,
  // pattern-matched failures (timeout, locator not found, network error). This is the
  // most common case and requires no LLM reasoning.
  if (parsedTrace && traceErrorCount === 1) {
    const localDiagnosis = buildDeterministicDiagnosis(parsedTrace, tracePath);
    if (localDiagnosis) {
      console.error('  ✓ Single clear error detected — generating deterministic diagnosis (no Claude call)\n');
      process.stdout.write(localDiagnosis + '\n\n');
      if (outputPath) {
        const header = `# Trace Analysis Report\n_Trace: ${tracePath} | Generated: ${new Date().toISOString()} | Mode: deterministic_\n\n`;
        fs.writeFileSync(outputPath, header + localDiagnosis, 'utf-8');
        console.error(`  ✓ Report saved to: ${outputPath}`);
      }
      return;
    }
  }

  // Stage 1 (default): compact failure window → Sonnet. ~70% input token reduction.
  // Stage 2 (complex): ≥3 DISTINCT errors AND ≥2 distinct failing actions AND >40 actions
  //   → full trace → Opus+thinking. Requiring distinct signals prevents repeated identical
  //   timeouts (which are a single root cause) from triggering the expensive Opus path.
  const TRACE_CAP = 24_000;

  const distinctErrorSigs = new Set(
    (parsedTrace?.errors ?? []).map((e) => e.message.slice(0, 80)),
  );
  const distinctFailingActions = new Set(
    (parsedTrace?.actions ?? [])
      .filter((a) => a.error && a.apiName)
      .map((a) => a.apiName!),
  );

  const isComplexTrace =
    traceErrorCount >= 3 &&
    traceActionCount > 40 &&
    distinctErrorSigs.size >= 2 &&
    distinctFailingActions.size >= 2;

  let analysisInput: string;
  if (isComplexTrace) {
    // Full trace for Opus — cap at 24 KB
    if (formattedTrace.length > TRACE_CAP) {
      formattedTrace =
        formattedTrace.slice(0, TRACE_CAP) +
        '\n\n<!-- trace truncated — showing first 24 KB of formatted output -->';
      console.error('  ⚠ Trace truncated to 24 KB before analysis.');
    }
    analysisInput = formattedTrace;
  } else {
    // Compact failure window for Sonnet
    analysisInput = parsedTrace
      ? reduceToFailureWindow(parsedTrace, tracePath)
      : formattedTrace;
  }

  const model = isComplexTrace ? 'claude-opus-4-6' : 'claude-sonnet-4-6';
  const maxTokens = isComplexTrace ? 16000 : 8000;

  console.error(
    `  Asking ${isComplexTrace ? 'Claude Opus (with thinking, full trace)' : 'Claude Sonnet (failure window)'} to diagnose...\n`,
  );

  // Opus: max_tokens covers thinking + text output combined.
  //   budget_tokens: 8000 for reasoning; remaining ~8000 for the structured report.
  // Sonnet: no thinking — compact failure window provides enough signal.
  const stream = await client.messages.stream({
    model,
    max_tokens: maxTokens,
    ...(isComplexTrace ? { thinking: { type: 'enabled', budget_tokens: 8000 } } : {}),
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{ role: 'user', content: analysisInput }],
  });

  const fullText = await streamToStdout(stream, '  ', {
    mode: isComplexTrace ? 'full-trace' : 'failure-window',
    errors: traceErrorCount,
    actions: traceActionCount,
    distinct_errors: distinctErrorSigs.size,
  });

  if (outputPath) {
    const header =
      `# Trace Analysis Report\n` +
      `_Trace: ${tracePath} | Generated: ${new Date().toISOString()}_\n\n`;
    fs.writeFileSync(outputPath, header + fullText, 'utf-8');
    console.error(`  ✓ Report saved to: ${outputPath}`);
  }
}

// ── Entry point ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const traceFlag = args.indexOf('--trace');
const outputFlag = args.indexOf('--output');
const allFlag = args.includes('--all');

const tracePath = traceFlag !== -1 ? args[traceFlag + 1] : null;
const outputPath = outputFlag !== -1 ? args[outputFlag + 1] : null;

if (allFlag) {
  const traces = findTraceFiles('test-results');
  if (traces.length === 0) {
    console.error('No trace.zip files found in test-results/');
    console.error('Run tests with: trace: "on-first-retry" or trace: "on" in playwright.config.ts');
    process.exit(0);
  }
  console.error(`Found ${traces.length} trace file(s).`);
  (async () => {
    for (const trace of traces) {
      const traceOutput = outputPath
        ? outputPath.replace('.md', `-${path.basename(path.dirname(trace))}.md`)
        : null;
      await inspectTrace(trace, traceOutput);
    }
  })().catch((err: Error) => {
    console.error('Trace inspector error:', err.message);
    process.exit(1);
  });
} else if (tracePath) {
  inspectTrace(tracePath, outputPath).catch((err: Error) => {
    console.error('Trace inspector error:', err.message);
    process.exit(1);
  });
} else {
  console.error(
    'Usage:\n' +
      '  npx tsx tests/agents/traceInspector.ts --trace test-results/trace.zip\n' +
      '  npx tsx tests/agents/traceInspector.ts --trace test-results/trace.zip --output analysis.md\n' +
      '  npx tsx tests/agents/traceInspector.ts --all   # inspect every trace in test-results/',
  );
  process.exit(1);
}
