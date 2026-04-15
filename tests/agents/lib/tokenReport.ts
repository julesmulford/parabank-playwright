#!/usr/bin/env npx tsx
/**
 * Token Usage Reporter
 *
 * Aggregates .token-usage.ndjson by agent, model, and mode so optimisation
 * effort targets actual spend rather than guesses.
 *
 * Usage:
 *   npx tsx tests/agents/lib/tokenReport.ts
 *   npx tsx tests/agents/lib/tokenReport.ts --file path/to/.token-usage.ndjson
 *   npx tsx tests/agents/lib/tokenReport.ts --since 2025-01-01
 *   npx tsx tests/agents/lib/tokenReport.ts --top 10   # show only top-N agents by cost
 */

import fs from 'fs';
import path from 'path';

// Approximate cost per million tokens (Claude pricing as of 2025).
// These are used only for relative ranking — not billing.
const COST_PER_M: Record<string, { in: number; out: number }> = {
  'claude-opus-4-6':          { in: 15.00, out: 75.00 },
  'claude-sonnet-4-6':        { in:  3.00, out: 15.00 },
  'claude-haiku-4-5-20251001':{ in:  0.80, out:  4.00 },
};

interface LogEntry {
  ts: string;
  agent: string;
  model: string;
  in: number;
  out: number;
  cache_read: number;
  cache_write: number;
  [key: string]: unknown; // caller-supplied metadata
}

interface AgentStats {
  calls: number;
  totalIn: number;
  totalOut: number;
  totalCacheRead: number;
  totalCacheWrite: number;
  estimatedCostUsd: number;
  models: Set<string>;
  modes: Map<string, number>; // mode → call count
}

function costUsd(entry: LogEntry): number {
  const prices = COST_PER_M[entry.model] ?? { in: 3.00, out: 15.00 };
  return (entry.in / 1_000_000) * prices.in + (entry.out / 1_000_000) * prices.out;
}

function formatNumber(n: number, decimals = 0): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function bar(ratio: number, width = 20): string {
  const filled = Math.round(ratio * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

// ── Main ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const fileFlag = args.indexOf('--file');
const sinceFlag = args.indexOf('--since');
const topFlag = args.indexOf('--top');

const logFile = fileFlag !== -1 ? args[fileFlag + 1] : path.join(process.cwd(), '.token-usage.ndjson');
const sinceDate = sinceFlag !== -1 ? new Date(args[sinceFlag + 1]) : null;
const topN = topFlag !== -1 ? parseInt(args[topFlag + 1], 10) : Infinity;

if (!fs.existsSync(logFile)) {
  console.error(`No token usage log found at: ${logFile}`);
  console.error('Run any agent first to generate telemetry data.');
  process.exit(0);
}

const raw = fs.readFileSync(logFile, 'utf-8');
const entries: LogEntry[] = raw
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    try { return JSON.parse(line) as LogEntry; } catch { return null; }
  })
  .filter((e): e is LogEntry => e !== null)
  .filter((e) => !sinceDate || new Date(e.ts) >= sinceDate);

if (entries.length === 0) {
  console.log('No entries found' + (sinceDate ? ` since ${sinceDate.toISOString()}` : '') + '.');
  process.exit(0);
}

// Aggregate by agent
const byAgent = new Map<string, AgentStats>();

for (const e of entries) {
  let stats = byAgent.get(e.agent);
  if (!stats) {
    stats = { calls: 0, totalIn: 0, totalOut: 0, totalCacheRead: 0, totalCacheWrite: 0, estimatedCostUsd: 0, models: new Set(), modes: new Map() };
    byAgent.set(e.agent, stats);
  }
  stats.calls++;
  stats.totalIn += e.in;
  stats.totalOut += e.out;
  stats.totalCacheRead += e.cache_read ?? 0;
  stats.totalCacheWrite += e.cache_write ?? 0;
  stats.estimatedCostUsd += costUsd(e);
  stats.models.add(e.model.replace('claude-', '').replace(/-\d{8}$/, ''));
  const mode = String(e['mode'] ?? e['model'] ?? 'default');
  stats.modes.set(mode, (stats.modes.get(mode) ?? 0) + 1);
}

// Sort by estimated cost descending
const sorted = [...byAgent.entries()]
  .sort((a, b) => b[1].estimatedCostUsd - a[1].estimatedCostUsd)
  .slice(0, topN);

const totalCost = [...byAgent.values()].reduce((s, v) => s + v.estimatedCostUsd, 0);
const totalIn   = [...byAgent.values()].reduce((s, v) => s + v.totalIn, 0);
const totalOut  = [...byAgent.values()].reduce((s, v) => s + v.totalOut, 0);
const totalCalls = [...byAgent.values()].reduce((s, v) => s + v.calls, 0);

const dateRange =
  entries.length > 0
    ? `${entries[0].ts.slice(0, 10)} → ${entries[entries.length - 1].ts.slice(0, 10)}`
    : 'n/a';

console.log('\n═══════════════════════════════════════════════════════');
console.log('  Token Usage Report — Claude Agents');
console.log(`  Period : ${dateRange}`);
console.log(`  Entries: ${formatNumber(entries.length)} API calls across ${byAgent.size} agent(s)`);
console.log('═══════════════════════════════════════════════════════\n');

console.log(`${'Agent'.padEnd(32)} ${'Calls'.padStart(6)} ${'In (k)'.padStart(8)} ${'Out (k)'.padStart(8)} ${'Cache%'.padStart(7)} ${'Est. $'.padStart(8)}  Share`);
console.log('─'.repeat(90));

for (const [agent, s] of sorted) {
  const inK  = (s.totalIn / 1000).toFixed(1);
  const outK = (s.totalOut / 1000).toFixed(1);
  const cacheRatio = s.totalIn + s.totalCacheRead > 0
    ? s.totalCacheRead / (s.totalIn + s.totalCacheRead)
    : 0;
  const shareFraction = totalCost > 0 ? s.estimatedCostUsd / totalCost : 0;
  const shareBar = bar(shareFraction, 16);
  const models = [...s.models].join(', ');

  console.log(
    `${agent.padEnd(32)} ${String(s.calls).padStart(6)} ${inK.padStart(8)} ${outK.padStart(8)}` +
    ` ${(cacheRatio * 100).toFixed(0).padStart(6)}%` +
    ` ${('$' + s.estimatedCostUsd.toFixed(4)).padStart(8)}  ${shareBar} ${(shareFraction * 100).toFixed(1)}%`,
  );

  // Show mode breakdown if more than one mode
  if (s.modes.size > 1) {
    const modeStr = [...s.modes.entries()].map(([m, c]) => `${m}×${c}`).join(', ');
    console.log(`${''.padEnd(32)}   models: ${models}  modes: ${modeStr}`);
  }
}

console.log('─'.repeat(90));
console.log(
  `${'TOTAL'.padEnd(32)} ${String(totalCalls).padStart(6)} ${(totalIn / 1000).toFixed(1).padStart(8)} ${(totalOut / 1000).toFixed(1).padStart(8)}` +
  ` ${(totalCost > 0 ? 0 : 0).toFixed(0).padStart(6)}%` +
  ` ${('$' + totalCost.toFixed(4)).padStart(8)}`,
);
console.log('\nNote: costs are estimates based on public pricing, not billing actuals.');
console.log('      Cache reads are billed at ~10% of base input cost.\n');
