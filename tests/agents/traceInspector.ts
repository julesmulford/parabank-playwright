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
  // Trace stats are captured inside the try block and read after it for model selection.
  // Using separate counters avoids hoisting the full parsed object out of the try scope.
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

    const parsed = parseTraceNdjson(combinedNdjson);
    formattedTrace = formatTrace(parsed, tracePath);
    traceActionCount = parsed.actions.length;
    traceErrorCount = parsed.errors.length;
    traceNetworkCount = parsed.networkEvents.length;
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

  // Hard cap on total formatted trace size. Individual section caps (100 actions,
  // 50 network, 20 console) still allow each line to be 200–500 chars, so a full
  // trace can exceed 30 KB. Opus's context window is generous but the signal-to-noise
  // ratio drops sharply past ~24 KB of trace text. Truncate with a clear marker so
  // Claude knows the trace continues beyond what it received.
  const TRACE_CAP = 24_000;
  if (formattedTrace.length > TRACE_CAP) {
    formattedTrace = formattedTrace.slice(0, TRACE_CAP) +
      '\n\n<!-- trace truncated — showing first 24 KB of formatted output -->';
    console.error('  ⚠ Trace truncated to 24 KB before analysis.');
  }

  // Adaptive model selection — Opus with thinking is only justified for traces that
  // are genuinely complex to diagnose: many actions (long test), multiple errors
  // (cascading failures), or significant network activity (timing/auth issues).
  // Simple traces (small test, single obvious error) are well within Sonnet's reach
  // at ~20% of the cost, with no thinking overhead.
  const isComplexTrace =
    traceActionCount > 40 || traceErrorCount > 2 || traceNetworkCount > 30;
  const model = isComplexTrace ? 'claude-opus-4-6' : 'claude-sonnet-4-6';
  const maxTokens = isComplexTrace ? 16000 : 8000;

  console.error(
    `  Asking ${isComplexTrace ? 'Claude Opus (with thinking)' : 'Claude Sonnet'} to diagnose the trace...\n`,
  );

  // For Opus: max_tokens covers thinking + text output combined.
  //   budget_tokens: 10000 for reasoning; remaining ~6000 for the structured report.
  // For Sonnet: no thinking block — straightforward diagnosis task.
  const stream = await client.messages.stream({
    model,
    max_tokens: maxTokens,
    ...(isComplexTrace ? { thinking: { type: 'enabled', budget_tokens: 10000 } } : {}),
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{ role: 'user', content: formattedTrace }],
  });

  const fullText = await streamToStdout(stream, '  ');

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
