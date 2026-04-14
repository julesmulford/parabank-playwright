/**
 * Performance Trend Analyzer
 *
 * Collects web performance metrics (LCP, FCP, TTI, TTFB, load time) from live
 * Parabank pages using Playwright CDP sessions and page.evaluate(), appends results
 * to a local history file, then uses Claude to identify degradation trends, flag
 * approaching thresholds, and correlate slowdowns with recent git commits.
 *
 * Unlike the performance test specs (which assert fixed thresholds in isolation),
 * this agent tracks metrics over time — catching a metric that degrades from
 * 800ms → 2400ms across 20 commits before it ever crosses the 2500ms failure line.
 *
 * Metrics collected:
 *   - LCP  (Largest Contentful Paint)    threshold: < 2500ms
 *   - FCP  (First Contentful Paint)      threshold: < 1800ms
 *   - TTI  (Time to Interactive, approx) threshold: < 3500ms
 *   - TTFB (Time to First Byte)          informational
 *   - Load time                          informational
 *   - JS heap size (MB)                  informational
 *
 * History file: tests/performance/.metrics-history.json
 *
 * Model: claude-sonnet-4-6 — trend pattern recognition; no extended thinking needed.
 * Prompt caching: system prompt (thresholds + analysis rules) cached across runs.
 *
 * Usage:
 *   npx tsx tests/agents/performanceTrendAnalyzer.ts --collect
 *   npx tsx tests/agents/performanceTrendAnalyzer.ts --analyze
 *   npx tsx tests/agents/performanceTrendAnalyzer.ts --collect --analyze
 *   npx tsx tests/agents/performanceTrendAnalyzer.ts --collect --auth admin admin123
 *   npx tsx tests/agents/performanceTrendAnalyzer.ts --analyze --last 20 --output trends.md
 */

import Anthropic from '@anthropic-ai/sdk';
import { chromium } from 'playwright';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { streamToStdout } from './lib/streamUtils.js';

const client = new Anthropic();
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000/parabank/';
const HISTORY_FILE = 'tests/performance/.metrics-history.json';

// ── Thresholds (matching performance test specs) ─────────────────────────────

const THRESHOLDS = { lcp: 2500, fcp: 1800, tti: 3500 };

// ── System prompt (cached) ──────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a performance engineering expert analysing web performance trends for Parabank (a Java banking application).

Performance thresholds:
- LCP (Largest Contentful Paint): FAIL if ≥ 2500ms | WARN if ≥ 2000ms
- FCP (First Contentful Paint):   FAIL if ≥ 1800ms | WARN if ≥ 1400ms
- TTI (Time to Interactive):      FAIL if ≥ 3500ms | WARN if ≥ 2800ms

You will receive a time-series of performance measurements with timestamps and git commit references.

For each metric on each page, identify:
1. **Trend direction**: improving / stable / degrading
2. **Rate of change**: estimate ms/run degradation if worsening
3. **Threshold proximity**: flag if any metric is within 20% of its threshold
4. **Anomalies**: single-run spikes that may indicate environment issues vs sustained regressions
5. **Commit correlation**: if git commits are provided between measurements, identify which commit may have introduced a regression

Output format:

## Performance Trend Report

### Overall Health: [Green | Amber | Red]
One sentence summary.

### Per-Page Analysis

#### <Page Name>
For each metric: [LCP | FCP | TTI | TTFB]
- Trend: [↑ Improving | → Stable | ↓ Degrading]
- Latest: Xms | Best: Xms | Worst: Xms | Average: Xms
- Threshold: X% used (threshold: Yms)
- ⚠ [Warning message if approaching threshold or regressing]

### Regressions Detected
Ordered list of the most concerning degradations, with estimated commit or time of introduction.

### Recommendations
Specific, actionable steps for the top 2–3 performance issues.`;

// ── Page definitions ──────────────────────────────────────────────────────────

interface PageDefinition {
  name: string;
  path: string;
  requiresAuth: boolean;
}

const PAGES: PageDefinition[] = [
  { name: 'Home / Login', path: '', requiresAuth: false },
  { name: 'Registration', path: 'register.htm', requiresAuth: false },
  { name: 'About', path: 'about.htm', requiresAuth: false },
  { name: 'Account Overview', path: 'overview.htm', requiresAuth: true },
  { name: 'Transfer Funds', path: 'transfer.htm', requiresAuth: true },
  { name: 'Open Account', path: 'openaccount.htm', requiresAuth: true },
  { name: 'Find Transactions', path: 'findtrans.htm', requiresAuth: true },
];

// ── Metric types ──────────────────────────────────────────────────────────────

interface PageMetrics {
  lcp: number;
  fcp: number;
  tti: number;
  ttfb: number;
  loadTime: number;
  jsHeapMb: number;
}

interface RunRecord {
  timestamp: string;
  commit: string;
  commitMessage: string;
  pages: Record<string, PageMetrics>;
}

interface History {
  runs: RunRecord[];
}

// ── History file I/O ──────────────────────────────────────────────────────────

function loadHistory(): History {
  if (!fs.existsSync(HISTORY_FILE)) return { runs: [] };
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8')) as History;
  } catch {
    console.warn('⚠ History file is corrupt — starting fresh.');
    return { runs: [] };
  }
}

// Maximum runs retained in the history file. Older entries are evicted on each save.
// 200 runs × ~5 pages × ~6 metrics ≈ manageable JSON size; --analyze --last N selects the window.
const HISTORY_CAP = 200;

function saveHistory(history: History): void {
  fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
  if (history.runs.length > HISTORY_CAP) {
    const evicted = history.runs.length - HISTORY_CAP;
    history.runs = history.runs.slice(-HISTORY_CAP);
    console.error(`  (evicted ${evicted} oldest run(s) — history capped at ${HISTORY_CAP})`);
  }
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf-8');
}

// ── Git context ────────────────────────────────────────────────────────────────

function getCurrentCommit(): { hash: string; message: string } {
  try {
    const hash = execSync('git rev-parse --short HEAD', { encoding: 'utf-8', stdio: 'pipe' }).trim();
    const message = execSync('git log -1 --format=%s', { encoding: 'utf-8', stdio: 'pipe' }).trim();
    return { hash, message };
  } catch {
    return { hash: 'unknown', message: 'unknown' };
  }
}

function getCommitsBetween(sinceIso: string): string {
  // Validate ISO 8601 format before interpolating into the shell command.
  // sinceIso comes from the local history JSON file; a corrupt or hand-edited file
  // could otherwise inject arbitrary shell commands via the --since argument.
  if (!/^\d{4}-\d{2}-\d{2}T[\d:.Z+\-]+$/.test(sinceIso)) {
    console.warn(`  ⚠ Invalid timestamp in history file: "${sinceIso}" — skipping commit lookup.`);
    return '';
  }
  try {
    // Cap at 50 commits — busy repos can return hundreds of commits in a long analysis
    // window. Beyond ~50, Claude gains no additional regression-attribution accuracy
    // and the token cost grows linearly with commit count.
    const raw = execSync(
      // Use --since=<date> (no shell quoting needed for ISO format with no spaces)
      `git log --format="%h %s" --since=${sinceIso} -n 50`,
      { encoding: 'utf-8', stdio: 'pipe' },
    ).trim();
    return raw;
  } catch {
    return '';
  }
}

// ── Metric collection via CDP ─────────────────────────────────────────────────

async function measurePage(
  page: import('playwright').Page,
  pageUrl: string,
): Promise<PageMetrics> {
  // String-based script avoids TypeScript DOM lib errors while running correctly
  // in browser context. Buffered: true ensures we catch LCP even if it fired before
  // the observer was attached (common on fast-loading cached pages).
  await page.addInitScript(`
    window.__pw_lcp = 0;
    try {
      new PerformanceObserver(function(list) {
        var entries = list.getEntries();
        var last = entries[entries.length - 1];
        if (last) window.__pw_lcp = last.startTime;
      }).observe({ type: 'largest-contentful-paint', buffered: true });
    } catch(e) {}
  `);

  await page.goto(pageUrl, { waitUntil: 'networkidle' });

  // CDP: JS heap size (Chromium only — silently skipped on other browsers)
  let jsHeapMb = 0;
  try {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    const { metrics } = await cdp.send('Performance.getMetrics');
    const heapEntry = (metrics as Array<{ name: string; value: number }>)
      .find((m) => m.name === 'JSHeapUsedSize');
    jsHeapMb = heapEntry ? Math.round(heapEntry.value / 1024 / 1024 * 10) / 10 : 0;
  } catch { /* CDP unavailable */ }

  // Paint + navigation timing via evaluate.
  // All DOM/browser globals accessed through globalThis cast to avoid TS errors —
  // these types are only available in the browser context at runtime.
  type NavEntry = { responseStart: number; requestStart: number; domInteractive: number; loadEventEnd: number; startTime: number };
  type PaintEntry = { name: string; startTime: number };
  type BrowserGlobals = { __pw_lcp: number; performance: { getEntriesByType(t: string): unknown[] } };

  const timing = await page.evaluate<{ fcp: number; lcp: number; tti: number; ttfb: number; loadTime: number }>(() => {
    const g = (globalThis as unknown as BrowserGlobals);
    const lcp = g.__pw_lcp ?? 0;
    const paint = g.performance.getEntriesByType('paint') as PaintEntry[];
    const nav = g.performance.getEntriesByType('navigation')[0] as NavEntry | undefined;
    const fcpEntry = paint.find((e) => e.name === 'first-contentful-paint');
    return {
      fcp: Math.round(fcpEntry?.startTime ?? 0),
      lcp: Math.round(lcp),
      ttfb: nav ? Math.round(nav.responseStart - nav.requestStart) : 0,
      tti: nav ? Math.round(nav.domInteractive) : 0,          // domInteractive ≈ TTI
      loadTime: nav ? Math.round(nav.loadEventEnd - nav.startTime) : 0,
    };
  });

  return { lcp: timing.lcp, fcp: timing.fcp, tti: timing.tti, ttfb: timing.ttfb, loadTime: timing.loadTime, jsHeapMb };
}

// ── Collection run ────────────────────────────────────────────────────────────

async function collect(auth?: { username: string; password: string }): Promise<void> {
  console.error('Collecting performance metrics...\n');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  const pageMetrics: Record<string, PageMetrics> = {};

  try {
    if (auth) {
      await page.goto(new URL('login.htm', BASE_URL).href);
      await page.getByPlaceholder('Username').fill(auth.username);
      await page.getByPlaceholder('Password').fill(auth.password);
      await page.getByRole('button', { name: 'Log In' }).click();
      await page.waitForLoadState('networkidle');
    }

    for (const def of PAGES) {
      if (def.requiresAuth && !auth) {
        console.error(`  — ${def.name} (skipped — requires --auth)`);
        continue;
      }

      process.stderr.write(`  Measuring: ${def.name}... `);
      try {
        const url = new URL(def.path, BASE_URL).href;
        // Create a fresh page for each measurement to avoid cache effects
        const measurePage_ = await context.newPage();
        const metrics = await measurePage(measurePage_, url);
        await measurePage_.close();
        pageMetrics[def.name] = metrics;

        const lcpStatus = metrics.lcp >= THRESHOLDS.lcp ? '✗' : metrics.lcp >= THRESHOLDS.lcp * 0.8 ? '⚠' : '✓';
        console.error(`${lcpStatus} LCP:${metrics.lcp}ms FCP:${metrics.fcp}ms TTI:${metrics.tti}ms`);
      } catch (err) {
        console.error(`✗ Error: ${(err as Error).message}`);
      }
    }
  } finally {
    await context.close().catch(() => null);
    await browser.close().catch(() => null);
  }

  if (Object.keys(pageMetrics).length === 0) {
    console.error('\n✗ No metrics collected. Check that Parabank is running.');
    process.exit(1);
  }

  const { hash, message } = getCurrentCommit();
  const record: RunRecord = {
    timestamp: new Date().toISOString(),
    commit: hash,
    commitMessage: message,
    pages: pageMetrics,
  };

  const history = loadHistory();
  history.runs.push(record);
  saveHistory(history);

  console.error(`\n✓ Metrics saved to ${HISTORY_FILE} (${history.runs.length} total run(s))`);

  // Exit non-zero if any metric breaches its threshold — makes --collect usable as a CI gate
  const breaches: string[] = [];
  for (const [pageName, m] of Object.entries(pageMetrics)) {
    if (m.lcp >= THRESHOLDS.lcp) breaches.push(`${pageName}: LCP ${m.lcp}ms ≥ ${THRESHOLDS.lcp}ms`);
    if (m.fcp >= THRESHOLDS.fcp) breaches.push(`${pageName}: FCP ${m.fcp}ms ≥ ${THRESHOLDS.fcp}ms`);
    if (m.tti >= THRESHOLDS.tti) breaches.push(`${pageName}: TTI ${m.tti}ms ≥ ${THRESHOLDS.tti}ms`);
  }
  if (breaches.length > 0) {
    console.error('\n✗ Performance threshold breaches:');
    for (const b of breaches) console.error(`  ${b}`);
    process.exit(1);
  }
}

// ── Trend analysis ────────────────────────────────────────────────────────────

// ── Local statistics pre-computation ─────────────────────────────────────────
// Computes min/max/mean/latest/trend per page×metric before sending to Claude.
// For --last 20 runs × 7 pages × 6 metrics, this compresses ~840 raw data cells
// into ~42 stat cells + 3 recent raw rows — cutting input tokens by ~60%.

type MetricKey = 'lcp' | 'fcp' | 'tti' | 'ttfb' | 'loadTime' | 'jsHeapMb';
const METRIC_KEYS: MetricKey[] = ['lcp', 'fcp', 'tti', 'ttfb', 'loadTime', 'jsHeapMb'];

interface MetricStats {
  min: number;
  max: number;
  mean: number;
  latest: number;
  trend: '↑ improving' | '→ stable' | '↓ degrading';
  thresholdPct: string; // e.g. "56%" — how much of the threshold is consumed
}

function computeStats(values: number[], threshold?: number): MetricStats {
  const n = values.length;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const mean = Math.round(values.reduce((s, v) => s + v, 0) / n);
  const latest = values[n - 1];

  // Trend: compare mean of first half vs second half.
  //   >5% worse → degrading; >5% better → improving; otherwise stable.
  const half = Math.floor(n / 2);
  const firstHalfMean = values.slice(0, half).reduce((s, v) => s + v, 0) / half || mean;
  const secondHalfMean = values.slice(half).reduce((s, v) => s + v, 0) / (n - half) || mean;
  const changePct = firstHalfMean > 0 ? (secondHalfMean - firstHalfMean) / firstHalfMean : 0;
  const trend =
    changePct > 0.05 ? '↓ degrading' :
    changePct < -0.05 ? '↑ improving' :
    '→ stable';

  const thresholdPct = threshold
    ? `${Math.round((mean / threshold) * 100)}% of ${threshold}ms limit`
    : 'n/a';

  return { min, max, mean, latest, trend, thresholdPct };
}

function buildStatsSection(runs: RunRecord[]): string {
  const pageNames = [...new Set(runs.flatMap((r) => Object.keys(r.pages)))];
  const thresholdMap: Partial<Record<MetricKey, number>> = {
    lcp: THRESHOLDS.lcp,
    fcp: THRESHOLDS.fcp,
    tti: THRESHOLDS.tti,
  };

  return pageNames.map((pageName) => {
    const pageRuns = runs.filter((r) => r.pages[pageName]);
    if (pageRuns.length === 0) return `### ${pageName}\n(no data)`;

    const statLines: string[] = [
      `### ${pageName} (${pageRuns.length} run(s))`,
      '| Metric | Min | Max | Mean | Latest | Trend | Threshold |',
      '|--------|-----|-----|------|--------|-------|-----------|',
    ];

    for (const key of METRIC_KEYS) {
      const values = pageRuns.map((r) => r.pages[pageName][key]);
      const stats = computeStats(values, thresholdMap[key]);
      const unit = key === 'jsHeapMb' ? 'MB' : 'ms';
      const threshold = thresholdMap[key] ? stats.thresholdPct : '—';
      statLines.push(
        `| ${key.toUpperCase()} | ${stats.min}${unit} | ${stats.max}${unit} | ${stats.mean}${unit} | ${stats.latest}${unit} | ${stats.trend} | ${threshold} |`,
      );
    }

    // Include the 3 most recent raw rows so Claude has sequential evidence for trend calls.
    // Three points is enough to confirm a trend direction without token cost of the full window.
    const recent = pageRuns.slice(-3);
    statLines.push('', 'Recent runs (newest last):');
    for (const r of recent) {
      const m = r.pages[pageName];
      statLines.push(
        `  ${r.timestamp.slice(0, 16)} [${r.commit}] LCP:${m.lcp} FCP:${m.fcp} TTI:${m.tti} TTFB:${m.ttfb}`,
      );
    }

    return statLines.join('\n');
  }).join('\n\n');
}

async function analyze(last: number, outputPath: string | null): Promise<void> {
  const history = loadHistory();

  if (history.runs.length === 0) {
    console.error('No history found. Run with --collect first.');
    process.exit(1);
  }

  // Trend analysis requires at least 2 data points — a single run produces no trend,
  // only a snapshot. --collect --analyze in one shot is the most common first use.
  if (history.runs.length < 2) {
    console.error('Only 1 run in history — collect at least one more before analysing trends.');
    console.error('Run: npx tsx tests/agents/performanceTrendAnalyzer.ts --collect --analyze');
    process.exit(0);
  }

  const runs = history.runs.slice(-last);
  console.error(`Analyzing ${runs.length} run(s) (of ${history.runs.length} total)...\n`);

  // Get git commits between the oldest and newest run in the selected window
  const oldestTimestamp = runs[0]?.timestamp ?? new Date().toISOString();
  const commits = getCommitsBetween(oldestTimestamp);

  // Pre-compute statistics locally before sending to Claude.
  // For N runs × P pages × 6 metrics, the raw time-series is O(N×P×6) cells.
  // The stats table is O(P×6) cells + 3 recent raw rows per page — typically
  // 60–70% fewer input tokens for --last 10+ without losing analytical signal.
  const statsSection = buildStatsSection(runs);
  console.error(`  Pre-computed stats for ${runs.length} run(s) across all pages.`);

  const commitsSection = commits
    ? `## Git commits in this window\n${commits}`
    : '## Git commits\n(not available)';

  const userMessage =
    `## Performance Statistics (${runs.length} runs analysed)\n` +
    `Thresholds: LCP<${THRESHOLDS.lcp}ms, FCP<${THRESHOLDS.fcp}ms, TTI<${THRESHOLDS.tti}ms\n\n` +
    `${statsSection}\n\n${commitsSection}`;

  console.error('Asking Claude to analyse trends...\n');

  const stream = await client.messages.stream({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userMessage }],
  });

  const fullText = await streamToStdout(stream);

  if (outputPath) {
    const header = `# Performance Trend Report — Parabank\n_Runs: ${runs.length} | Generated: ${new Date().toISOString()}_\n\n`;
    fs.writeFileSync(outputPath, header + fullText, 'utf-8');
    console.error(`✓ Report saved to: ${outputPath}`);
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes('--help') || args.length === 0) {
  console.error(
    'Usage:\n' +
    '  npx tsx tests/agents/performanceTrendAnalyzer.ts --collect\n' +
    '  npx tsx tests/agents/performanceTrendAnalyzer.ts --analyze\n' +
    '  npx tsx tests/agents/performanceTrendAnalyzer.ts --collect --analyze\n' +
    '  npx tsx tests/agents/performanceTrendAnalyzer.ts --collect --auth admin admin123\n' +
    '  npx tsx tests/agents/performanceTrendAnalyzer.ts --analyze --last 20 --output trends.md',
  );
  process.exit(args.length === 0 ? 1 : 0);
}

const doCollect = args.includes('--collect');
const doAnalyze = args.includes('--analyze');
const authFlag = args.indexOf('--auth');
const lastFlag = args.indexOf('--last');
const outputFlag = args.indexOf('--output');

const auth = authFlag !== -1 ? { username: args[authFlag + 1], password: args[authFlag + 2] } : undefined;
const last = lastFlag !== -1 ? parseInt(args[lastFlag + 1], 10) : 10;
const outputPath = outputFlag !== -1 ? args[outputFlag + 1] : null;

if (!doCollect && !doAnalyze) {
  console.error('Specify at least one of --collect or --analyze.');
  process.exit(1);
}

if (isNaN(last) || last < 2) {
  console.error('--last must be an integer ≥ 2.');
  process.exit(1);
}

(async () => {
  if (doCollect) await collect(auth);
  if (doAnalyze) await analyze(last, outputPath);
})().catch((err: Error) => {
  console.error('Performance trend analyzer error:', err.message);
  process.exit(1);
});
