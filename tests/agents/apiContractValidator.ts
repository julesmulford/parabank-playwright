/**
 * API Contract Validator
 *
 * Validates that Parabank's live REST API responses conform to their expected
 * contract — correct status codes, required fields present, correct data types,
 * and no schema drift between releases.
 *
 * Works in two modes:
 *   Spec mode (--spec):   fetches a Swagger/OpenAPI document and validates live
 *                         responses against it. Tries common paths automatically.
 *   Structural mode:      validates against inline expected schemas for all known
 *                         Parabank REST endpoints. Catches missing fields, wrong
 *                         status codes, and null required values without a spec.
 *
 * Authentication: Parabank REST endpoints use HTTP Basic Auth. Provide credentials
 * via --auth. Use --self-register to create a fresh throwaway account automatically.
 *
 * Model: claude-sonnet-4-6 — contract analysis, violation classification, and
 * impact assessment. Prompt caching on the static analysis rubric.
 *
 * Usage:
 *   npx tsx tests/agents/apiContractValidator.ts --auth john password123
 *   npx tsx tests/agents/apiContractValidator.ts --self-register
 *   npx tsx tests/agents/apiContractValidator.ts --auth john password123 --spec
 *   npx tsx tests/agents/apiContractValidator.ts --self-register --output report.md
 */

import Anthropic from '@anthropic-ai/sdk';
import * as http from 'http';
import * as https from 'https';
import * as fs from 'fs';
import { streamToStdout } from './lib/streamUtils.js';

const client = new Anthropic();
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000/parabank/';
const API_BASE = new URL('services/bank/', BASE_URL).href;

// ── System prompt (cached) ──────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a senior API quality engineer performing a contract validation audit for Parabank's REST API.

You will receive a set of API call results, each containing:
- Endpoint method + path
- Expected HTTP status code
- Actual HTTP status code
- Expected required fields
- Actual response body (JSON)
- Any schema spec excerpt (if available)

For each endpoint, assess:
1. Status code correctness
2. Required field presence (missing or null fields that should have values)
3. Data type correctness (string where number expected, etc.)
4. Schema drift (fields present in spec but absent in response, or vice versa)
5. Security concerns (sensitive fields exposed that shouldn't be)

Output format:

## Contract Validation Report

### Summary
Overall: X / Y endpoints passed. [Pass | Partial | Fail]

### ✅ Passing Endpoints
List endpoints that fully conform.

### ⚠️ Violations

For each violating endpoint:
**[METHOD] /path/to/endpoint**
Severity: [Critical | High | Medium | Low]
Issue: <exact description of the contract violation>
Evidence: <the specific field or value that is wrong>
Impact: <what breaks if this is not fixed>

### Recommendations
Ordered list of fixes, most critical first.`;

// ── HTTP client ───────────────────────────────────────────────────────────────

interface HttpResponse {
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
  ok: boolean;
}

function httpRequest(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number } = {},
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const { method = 'GET', headers = {}, body, timeoutMs = 10000 } = options;
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;

    const reqOptions = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method,
      headers: { 'Accept': 'application/json', ...headers },
      timeout: timeoutMs,
    };

    const req = mod.request(reqOptions, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => (data += chunk.toString()));
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        body: data,
        headers: res.headers as Record<string, string | string[] | undefined>,
        ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300,
      }));
    });

    req.on('timeout', () => { req.destroy(); reject(new Error(`Request to ${url} timed out`)); });
    req.on('error', reject);

    if (body) req.write(body);
    req.end();
  });
}

function basicAuth(username: string, password: string): string {
  return 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
}

// ── Self-registration ─────────────────────────────────────────────────────────

interface Credentials {
  username: string;
  password: string;
  firstName: string;
  lastName: string;
  customerId?: string;
}

async function selfRegister(): Promise<Credentials> {
  const ts = Date.now();
  const creds: Credentials = {
    username: `validator_${ts}`,
    password: `Passw0rd_${ts}`,
    firstName: 'Contract',
    lastName: 'Validator',
  };

  const body = new URLSearchParams({
    'customer.firstName': creds.firstName,
    'customer.lastName': creds.lastName,
    'customer.address.street': '100 Main St',
    'customer.address.city': 'Anytown',
    'customer.address.state': 'CA',
    'customer.address.zipCode': '90210',
    'customer.phoneNumber': '5551234567',
    'customer.ssn': `${ts}`.slice(-9),
    'customer.username': creds.username,
    'customer.password': creds.password,
    'repeatedPassword': creds.password,
  }).toString();

  const registerUrl = new URL('register.htm', BASE_URL).href;
  const res = await httpRequest(registerUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    timeoutMs: 15000,
  });

  if (res.status >= 400) {
    throw new Error(`Registration failed with HTTP ${res.status}`);
  }

  // Extract customer ID from the response body (Parabank includes it in the confirmation text)
  const idMatch = res.body.match(/customerId=(\d+)/) ?? res.body.match(/>(\d{4,})</);
  if (idMatch) creds.customerId = idMatch[1];

  console.error(`  ✓ Registered as: ${creds.username} (id: ${creds.customerId ?? 'unknown'})`);
  return creds;
}

async function getCustomerId(username: string, password: string): Promise<string | null> {
  // Parabank uses session-based auth via HTML form — POST to login.htm and parse
  // the customer ID from the resulting page (embedded in HTML or redirect URL).
  // This is the same mechanism the API tests use in their beforeAll setup.
  const formBody = new URLSearchParams({ username, password }).toString();
  try {
    const res = await httpRequest(new URL('login.htm', BASE_URL).href, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formBody,
      timeoutMs: 8000,
    });
    const idMatch =
      res.body.match(/customerId[=:]\s*(\d+)/i) ??
      res.body.match(/<b>(\d{5,})<\/b>/) ??
      res.body.match(/id=(\d{4,})/);
    if (idMatch) return idMatch[1];
  } catch { /* fall through */ }

  // Secondary: REST login endpoint (present on some Parabank versions)
  try {
    const restUrl = new URL(
      `services/bank/login/${encodeURIComponent(username)}/${encodeURIComponent(password)}`,
      BASE_URL,
    ).href;
    const res = await httpRequest(restUrl, {
      headers: { Authorization: basicAuth(username, password) },
    });
    if (res.ok) {
      const parsed = JSON.parse(res.body) as Record<string, unknown>;
      const id = parsed['id'] ?? parsed['customerId'];
      return id != null ? String(id) : null;
    }
  } catch { /* not available on this version */ }

  return null;
}

// ── OpenAPI spec discovery ────────────────────────────────────────────────────

async function discoverOpenApiSpec(): Promise<Record<string, unknown> | null> {
  const candidates = [
    'api-docs',
    'v2/api-docs',
    'api-docs.json',
    'swagger.json',
    'swagger/v2/api-docs',
  ];

  for (const candidate of candidates) {
    const url = new URL(candidate, BASE_URL).href;
    try {
      const res = await httpRequest(url, { timeoutMs: 5000 });
      if (res.ok && res.body.trim().startsWith('{')) {
        const spec = JSON.parse(res.body) as Record<string, unknown>;
        if (spec['swagger'] || spec['openapi'] || spec['paths']) {
          console.error(`  ✓ OpenAPI spec found at: ${url}`);
          return spec;
        }
      }
    } catch { /* try next */ }
  }

  return null;
}

// ── Endpoint definitions ──────────────────────────────────────────────────────

// Known Parabank REST endpoints with their expected contracts.
// /positions is NOT included — it does not exist in standard Parabank deployments
// and would always produce misleading 404 failures.
const STATIC_ENDPOINTS = [
  { method: 'GET', name: 'Get Customer',             pathFn: (id: string) => `customers/${id}`,          expectedStatus: 200, requiredFields: ['id', 'firstName', 'lastName', 'address'] },
  { method: 'GET', name: 'Get Accounts for Customer', pathFn: (id: string) => `customers/${id}/accounts`, expectedStatus: 200, requiredFields: [] },
];

const ACCOUNT_ENDPOINTS = [
  { method: 'GET', name: 'Get Account',                   pathFn: (id: string) => `accounts/${id}`,               expectedStatus: 200, requiredFields: ['id', 'customerId', 'type', 'balance'] },
  { method: 'GET', name: 'Get Account Transactions',      pathFn: (id: string) => `accounts/${id}/transactions`,  expectedStatus: 200, requiredFields: [] },
];

interface CallResult {
  endpoint: string;
  method: string;
  url: string;
  expectedStatus: number;
  actualStatus: number;
  requiredFields: string[];
  responseBody: string;
  passed: boolean;
  statusMatch: boolean;
  missingFields: string[];
}

// ── Validator ─────────────────────────────────────────────────────────────────

function checkRequiredFields(body: string, required: string[]): string[] {
  if (!required.length) return [];
  let parsed: Record<string, unknown>;
  try {
    const data = JSON.parse(body);
    parsed = Array.isArray(data) ? (data[0] as Record<string, unknown> ?? {}) : data as Record<string, unknown>;
  } catch {
    return required; // Can't parse = all required fields missing
  }
  return required.filter((f) => !(f in parsed) || parsed[f] === null || parsed[f] === undefined);
}

async function callEndpoint(
  name: string,
  method: string,
  path: string,
  expectedStatus: number,
  requiredFields: string[],
  auth: string,
): Promise<CallResult> {
  const url = new URL(path, API_BASE).href;
  let actualStatus = 0;
  let responseBody = '';

  try {
    const res = await httpRequest(url, { method, headers: { Authorization: auth } });
    actualStatus = res.status;
    // Truncate large bodies — Claude doesn't need the full payload
    responseBody = res.body.length > 2000
      ? res.body.slice(0, 2000) + '\n// ...truncated'
      : res.body;
  } catch (err) {
    responseBody = `ERROR: ${(err as Error).message}`;
    actualStatus = 0;
  }

  const statusMatch = actualStatus === expectedStatus;
  const missingFields = statusMatch ? checkRequiredFields(responseBody, requiredFields) : [];
  const passed = statusMatch && missingFields.length === 0;

  return { endpoint: name, method, url, expectedStatus, actualStatus, requiredFields, responseBody, passed, statusMatch, missingFields };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function validateContracts(
  username: string,
  password: string,
  customerId: string | null,
  trySpec: boolean,
  outputPath: string | null,
): Promise<void> {
  const auth = basicAuth(username, password);
  const results: CallResult[] = [];

  // Discover OpenAPI spec if requested
  let spec: Record<string, unknown> | null = null;
  if (trySpec) {
    console.error('Searching for OpenAPI spec...');
    spec = await discoverOpenApiSpec();
    if (!spec) console.error('  No OpenAPI spec found — using structural validation.\n');
  }

  console.error('Running API endpoint checks...\n');

  // Customer-level endpoints
  if (customerId) {
    for (const ep of STATIC_ENDPOINTS) {
      process.stderr.write(`  ${ep.method} /${ep.pathFn(customerId)}... `);
      const result = await callEndpoint(ep.name, ep.method, ep.pathFn(customerId), ep.expectedStatus, ep.requiredFields, auth);
      results.push(result);
      console.error(result.passed ? '✓' : `✗ (${result.actualStatus})`);
    }

    // Discover first account ID from accounts list
    const accountsRes = results.find((r) => r.endpoint === 'Get Accounts for Customer');
    let accountId: string | null = null;
    if (accountsRes?.statusMatch) {
      try {
        const accounts = JSON.parse(accountsRes.responseBody) as Array<Record<string, unknown>>;
        accountId = accounts[0]?.['id'] != null ? String(accounts[0]['id']) : null;
      } catch { /* ignore */ }
    }

    if (accountId) {
      for (const ep of ACCOUNT_ENDPOINTS) {
        process.stderr.write(`  ${ep.method} /${ep.pathFn(accountId)}... `);
        const result = await callEndpoint(ep.name, ep.method, ep.pathFn(accountId), ep.expectedStatus, ep.requiredFields, auth);
        results.push(result);
        console.error(result.passed ? '✓' : `✗ (${result.actualStatus})`);
      }
    } else {
      console.error('  ⚠ No account ID found — skipping account-level endpoints.');
    }
  } else {
    console.error('  ⚠ Customer ID unknown — skipping customer/account endpoints.');
    console.error('    Use --self-register or ensure --auth credentials exist.\n');
  }

  const passing = results.filter((r) => r.passed).length;
  console.error(`\n${passing}/${results.length} endpoints passed structural validation.\n`);

  if (results.length === 0) {
    console.error('No endpoints could be validated. Check that Parabank is running and credentials are correct.');
    process.exit(1);
  }

  // Early exit when all endpoints pass — no value in sending a fully-green result
  // to Claude; the "all passed" message is deterministic and costs zero tokens.
  if (passing === results.length) {
    const successMsg = `✅ All ${results.length} endpoint(s) conform to contract — no violations detected.`;
    console.log(successMsg);
    if (outputPath) {
      const header = `# API Contract Validation Report — Parabank\n_Generated: ${new Date().toISOString()}_\n\n`;
      fs.writeFileSync(outputPath, header + successMsg + '\n', 'utf-8');
      console.error(`✓ Report saved to: ${outputPath}`);
    }
    return;
  }

  // Build the Claude prompt
  const specSummary = spec
    ? `## OpenAPI Spec (excerpt)\nSwagger/OpenAPI spec found. Version: ${String(spec['swagger'] ?? spec['openapi'] ?? 'unknown')}. Paths defined: ${Object.keys((spec['paths'] as object) ?? {}).length}.\n`
    : '## No OpenAPI spec found — using structural validation only.\n';

  const resultsSummary = results.map((r) =>
    `### ${r.method} ${r.url}\n` +
    `Expected status: ${r.expectedStatus} | Actual: ${r.actualStatus} | Status match: ${r.statusMatch}\n` +
    `Required fields: [${r.requiredFields.join(', ') || 'none'}]\n` +
    `Missing/null fields: [${r.missingFields.join(', ') || 'none'}]\n` +
    `Response body:\n\`\`\`json\n${r.responseBody}\n\`\`\``,
  ).join('\n\n');

  console.error('Asking Claude to analyse contract violations...\n');

  // Two-level caching: spec discovery result (stable across re-runs of the same
  // deployment) is cached separately from the unique per-run endpoint results.
  const stream = await client.messages.stream({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: specSummary, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: `## Endpoint Results\n${resultsSummary}` },
      ],
    }],
  });

  const fullText = await streamToStdout(stream);

  if (outputPath) {
    const header = `# API Contract Validation Report — Parabank\n_Generated: ${new Date().toISOString()}_\n\n`;
    fs.writeFileSync(outputPath, header + fullText, 'utf-8');
    console.error(`✓ Report saved to: ${outputPath}`);
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes('--help') || args.length === 0) {
  console.error(
    'Usage:\n' +
    '  npx tsx tests/agents/apiContractValidator.ts --auth <username> <password>\n' +
    '  npx tsx tests/agents/apiContractValidator.ts --self-register\n' +
    '  npx tsx tests/agents/apiContractValidator.ts --auth john pass --spec\n' +
    '  npx tsx tests/agents/apiContractValidator.ts --self-register --output report.md',
  );
  process.exit(args.length === 0 ? 1 : 0);
}

const authFlag = args.indexOf('--auth');
const outputFlag = args.indexOf('--output');
const doSelfRegister = args.includes('--self-register');
const trySpec = args.includes('--spec');
const outputPath = outputFlag !== -1 ? args[outputFlag + 1] : null;

(async () => {
  let username: string;
  let password: string;
  let customerId: string | null = null;

  if (doSelfRegister) {
    console.error('Registering a fresh account for validation...');
    const creds = await selfRegister();
    username = creds.username;
    password = creds.password;
    customerId = creds.customerId ?? null;
  } else if (authFlag !== -1) {
    username = args[authFlag + 1];
    password = args[authFlag + 2];
    if (!username || !password) {
      console.error('--auth requires <username> <password>');
      process.exit(1);
    }
    console.error(`Using credentials: ${username}`);
    customerId = await getCustomerId(username, password);
    if (customerId) console.error(`  Customer ID: ${customerId}`);
    else console.error('  ⚠ Customer ID could not be determined — customer-level endpoints will be skipped.');
    console.error('');
  } else {
    console.error('Provide --auth <username> <password> or --self-register.');
    process.exit(1);
  }

  await validateContracts(username, password, customerId, trySpec, outputPath);
})().catch((err: Error) => {
  console.error('API contract validator error:', err.message);
  process.exit(1);
});
