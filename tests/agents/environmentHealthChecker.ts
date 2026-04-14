/**
 * Environment Health Checker
 *
 * Pre-flight validation before any Playwright test run. Zero Claude API calls
 * when all checks pass — this is a pure-Node fast gate. Claude Haiku is only
 * invoked when failures are detected, to produce human-readable diagnosis and
 * ordered remediation steps tailored to the specific errors.
 *
 * Checks (run in parallel):
 *   1. Target port is open (TCP connection)
 *   2. Parabank HTTP — application returns a 2xx/3xx response
 *   3. Database initialised — REST API responds with valid data
 *   4. Playwright browser binaries installed
 *   5. .env file present (warns if missing)
 *
 * Model: claude-haiku-4-5-20251001 — fast, cheap; only called on failure.
 * Prompt caching: system prompt cached for repeated invocations in CI pipelines.
 *
 * Usage:
 *   npx tsx tests/agents/environmentHealthChecker.ts
 *   npx tsx tests/agents/environmentHealthChecker.ts --fix
 *   npx tsx tests/agents/environmentHealthChecker.ts --url http://staging:3000/parabank/
 *   npx tsx tests/agents/environmentHealthChecker.ts --json
 *   npx tsx tests/agents/environmentHealthChecker.ts --help
 */

import Anthropic from '@anthropic-ai/sdk';
import { execSync } from 'child_process';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as fs from 'fs';
import { streamToStdout } from './lib/streamUtils.js';

const client = new Anthropic();
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000/parabank/';

// ── System prompt (cached) ──────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a DevOps and test infrastructure expert diagnosing a Playwright test environment for Parabank — a Java banking application running in Docker on port 3000 (mapped to container port 8080).

Given a set of failed health checks, produce:
1. A plain-English explanation of each failure
2. The exact shell commands to fix each issue
3. The correct order to apply fixes (some depend on others)

Format as a numbered markdown checklist. Be specific and immediately actionable.`;

// ── Types ────────────────────────────────────────────────────────────────────

type CheckStatus = 'pass' | 'fail' | 'warn';

interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
  fixCmd?: string;
}

// ── Network helpers ──────────────────────────────────────────────────────────

function isPortOpen(host: string, port: number, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    sock.setTimeout(timeoutMs);
    sock.connect(port, host, () => { sock.destroy(); resolve(true); });
    sock.on('error', () => resolve(false));
    sock.on('timeout', () => { sock.destroy(); resolve(false); });
  });
}

function httpGet(url: string, timeoutMs = 6000): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => (body += chunk.toString()));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('request timed out')); });
    req.on('error', reject);
  });
}

// ── Individual checks ────────────────────────────────────────────────────────

async function checkPort(): Promise<CheckResult> {
  const parsed = new URL(BASE_URL);
  const host = parsed.hostname;
  const port = parseInt(parsed.port || (parsed.protocol === 'https:' ? '443' : '80'), 10);

  const open = await isPortOpen(host, port);
  if (open) {
    return { name: `Port ${port}`, status: 'pass', detail: `${host}:${port} is accepting connections` };
  }
  return {
    name: `Port ${port}`,
    status: 'fail',
    detail: `${host}:${port} refused connection — Docker container may be stopped`,
    fixCmd: `docker run -d -p ${port}:8080 --name parabank parasoft/parabank`,
  };
}

async function checkHttp(): Promise<CheckResult> {
  try {
    const { status } = await httpGet(BASE_URL);
    if (status >= 200 && status < 400) {
      return { name: 'Parabank HTTP', status: 'pass', detail: `GET ${BASE_URL} → ${status}` };
    }
    return {
      name: 'Parabank HTTP',
      status: 'fail',
      detail: `GET ${BASE_URL} returned HTTP ${status}`,
      fixCmd: 'docker logs parabank --tail 50',
    };
  } catch (err) {
    return {
      name: 'Parabank HTTP',
      status: 'fail',
      detail: `GET ${BASE_URL} failed: ${(err as Error).message}`,
      fixCmd: 'docker start parabank',
    };
  }
}

async function checkDatabase(): Promise<CheckResult> {
  // A 200 or 404 from the REST API means the DB layer is responding.
  // A 500 typically means the DB has not been seeded.
  const apiUrl = new URL('services/bank/customers/12212', BASE_URL).href;
  try {
    const { status } = await httpGet(apiUrl, 5000);
    if (status === 200 || status === 404) {
      return { name: 'Database', status: 'pass', detail: `REST API responding (HTTP ${status})` };
    }
    if (status >= 500) {
      return {
        name: 'Database',
        status: 'warn',
        detail: 'REST API returned 5xx — database may need initialisation',
        fixCmd: `curl -X POST ${new URL('services/bank/initializeDB', BASE_URL).href}`,
      };
    }
    return { name: 'Database', status: 'warn', detail: `REST API returned unexpected ${status}` };
  } catch {
    return {
      name: 'Database',
      status: 'warn',
      detail: 'Could not reach REST API — Parabank may still be starting',
    };
  }
}

async function checkBrowsers(): Promise<CheckResult> {
  try {
    execSync('npx playwright --version', { stdio: 'pipe', encoding: 'utf-8' });
  } catch {
    return {
      name: 'Playwright CLI',
      status: 'fail',
      detail: 'playwright not found — is @playwright/test installed?',
      fixCmd: 'npm install @playwright/test',
    };
  }

  try {
    // Exits 1 and prints which browsers are missing when any are absent
    execSync('npx playwright install --check', { stdio: 'pipe', encoding: 'utf-8' });
    return { name: 'Browser binaries', status: 'pass', detail: 'All browsers installed' };
  } catch (err) {
    const raw = ((err as { stdout?: string }).stdout ?? '').trim();
    const firstLine = raw.split('\n')[0] ?? 'one or more browsers missing';
    return {
      name: 'Browser binaries',
      status: 'fail',
      detail: firstLine,
      fixCmd: 'npx playwright install',
    };
  }
}

function checkDotEnv(): CheckResult {
  if (fs.existsSync('.env')) {
    return { name: '.env file', status: 'pass', detail: '.env present' };
  }
  if (fs.existsSync('.env.example')) {
    return {
      name: '.env file',
      status: 'warn',
      detail: 'No .env found — using defaults. Copy .env.example to configure local overrides.',
      fixCmd: 'cp .env.example .env',
    };
  }
  return { name: '.env file', status: 'warn', detail: 'No .env or .env.example found' };
}

// ── Auto-fix ─────────────────────────────────────────────────────────────────

function applyFix(result: CheckResult): void {
  if (!result.fixCmd) return;
  console.error(`  → ${result.fixCmd}`);
  try {
    execSync(result.fixCmd, { encoding: 'utf-8', stdio: 'inherit', timeout: 30_000 });
    console.error('    ✓ Done');
  } catch (e) {
    console.error(`    ✗ Failed: ${(e as Error).message}`);
  }
}

// ── Claude diagnosis (only called on failure) ────────────────────────────────

async function diagnoseWithClaude(problems: CheckResult[]): Promise<void> {
  const summary = problems
    .map((r) => `[${r.status.toUpperCase()}] ${r.name}: ${r.detail}`)
    .join('\n');

  console.error('\n── Claude Diagnosis ─────────────────────────────────────────────────\n');

  const stream = await client.messages.stream({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{
      role: 'user',
      content: `Base URL: ${BASE_URL}\n\nFailed/warned checks:\n${summary}`,
    }],
  });

  await streamToStdout(stream);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function runChecks(autoFix: boolean, jsonMode: boolean): Promise<void> {
  // Port check first: HTTP and database both fail with confusing errors when
  // the port is closed. Short-circuiting avoids triple-failure noise from one root cause.
  const portResult = await checkPort();
  const portOpen = portResult.status !== 'fail';

  const [httpResult, dbResult, browserResult, envResult] = await Promise.all([
    portOpen ? checkHttp()     : Promise.resolve<CheckResult>({ name: 'Parabank HTTP', status: 'fail', detail: 'Skipped — port is not open (fix port first)' }),
    portOpen ? checkDatabase() : Promise.resolve<CheckResult>({ name: 'Database',      status: 'fail', detail: 'Skipped — port is not open (fix port first)' }),
    checkBrowsers(),
    checkDotEnv(),
  ]);

  const results = [portResult, httpResult, dbResult, browserResult, envResult];

  if (jsonMode) {
    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      baseUrl: BASE_URL,
      results,
      passed: results.filter((r) => r.status === 'pass').length,
      total: results.length,
    }, null, 2));
    process.exit(results.some((r) => r.status === 'fail') ? 1 : 0);
  }

  const icon: Record<CheckStatus, string> = { pass: '✓', warn: '⚠', fail: '✗' };

  console.error('\n── Environment Health Check ─────────────────────────────────────────');
  console.error(`   Target: ${BASE_URL}\n`);

  for (const r of results) {
    const label = r.status === 'pass' ? 'PASS' : r.status === 'warn' ? 'WARN' : 'FAIL';
    console.error(`  ${icon[r.status]} [${label}] ${r.name}`);
    if (r.status !== 'pass') console.error(`         ${r.detail}`);
  }

  const failures = results.filter((r) => r.status === 'fail');
  const warnings = results.filter((r) => r.status === 'warn');
  const passed = results.filter((r) => r.status === 'pass').length;

  console.error(`\n  ${passed}/${results.length} checks passed`);
  if (warnings.length > 0) console.error(`  ${warnings.length} warning(s)`);
  if (failures.length > 0) console.error(`  ${failures.length} failure(s)`);

  if (autoFix) {
    const fixable = [...failures, ...warnings].filter((r) => r.fixCmd);
    if (fixable.length > 0) {
      console.error('\n── Applying fixes ───────────────────────────────────────────────────');
      for (const r of fixable) applyFix(r);
    }
  }

  if (failures.length > 0) {
    await diagnoseWithClaude([...failures, ...warnings]);
    process.exit(1);
  }

  if (warnings.length === 0) {
    console.error('\n✓  All checks passed — environment is ready for testing.\n');
  } else {
    console.error('\n⚠  Warnings present. Run with --fix to attempt auto-remediation.\n');
  }
}

// ── Entry point ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes('--help')) {
  console.error(
    'Usage:\n' +
    '  npx tsx tests/agents/environmentHealthChecker.ts\n' +
    '  npx tsx tests/agents/environmentHealthChecker.ts --fix\n' +
    '  npx tsx tests/agents/environmentHealthChecker.ts --url http://staging:3000/parabank/\n' +
    '  npx tsx tests/agents/environmentHealthChecker.ts --json',
  );
  process.exit(0);
}

const urlFlag = args.indexOf('--url');
if (urlFlag !== -1) process.env.BASE_URL = args[urlFlag + 1];

runChecks(args.includes('--fix'), args.includes('--json')).catch((err: Error) => {
  console.error('Health checker error:', err.message);
  process.exit(1);
});
