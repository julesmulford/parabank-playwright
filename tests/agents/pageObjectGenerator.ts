/**
 * Page Object Generator
 *
 * Given a URL, launches a real Chromium instance, extracts all interactive
 * elements (forms, inputs, buttons, labels, ARIA roles), and generates a
 * production-ready TypeScript page object class following project conventions.
 *
 * Complements testGenerator — use this to create the page object first (when
 * a page has no existing coverage), then testGenerator to write specs that use it.
 *
 * The generated class:
 *   - Follows the project locator priority: getByRole → getByLabel → getByTestId
 *     → getByText/getByPlaceholder → locator('[id="..."]')
 *   - Declares all locators as readonly constructor properties
 *   - Contains action methods only — no assertions
 *   - Exports a typed data interface alongside the class when the page takes input
 *   - Is ready to drop into tests/pages/ and register in fixtures.ts
 *
 * Model: claude-opus-4-6 with enabled thinking — generating optimal locators from
 * live HTML requires reasoning about the accessibility tree vs DOM structure.
 * Prompt caching: system prompt (rules + conventions) cached across all calls.
 *
 * Usage:
 *   npx tsx tests/agents/pageObjectGenerator.ts --url http://localhost:3000/parabank/register.htm
 *   npx tsx tests/agents/pageObjectGenerator.ts --url .../transfer.htm --name TransferPage
 *   npx tsx tests/agents/pageObjectGenerator.ts --url .../overview.htm --auth admin admin123 --write
 */

import Anthropic from '@anthropic-ai/sdk';
import { chromium } from 'playwright';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { streamToStdout } from './lib/streamUtils.js';

const client = new Anthropic();
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000/parabank/';

// ── System prompt (cached) ──────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a senior Playwright test automation engineer generating a TypeScript page object class from live page HTML.

Project conventions — follow exactly:

CLASS STRUCTURE:
- One class per page, named <PageName>Page (e.g. TransferPage, RegistrationPage)
- Export the class
- Export a typed data interface alongside the class if the page accepts form input
- Constructor: constructor(private readonly page: Page)
- All locators declared as readonly Locator properties initialised in the constructor body

LOCATOR PRIORITY (highest to lowest — use the highest applicable):
1. this.page.getByRole('button', { name: 'Submit' })   — most resilient
2. this.page.getByLabel('Username')                     — all labelled form inputs
3. this.page.getByTestId('submit-btn')                  — data-testid attributes
4. this.page.getByPlaceholder('Enter amount')           — placeholder text
5. this.page.getByText('Forgot password?')              — visible link/button text
6. this.page.locator('[id="customer.firstName"]')       — last resort

STRICT RULES:
- NEVER use XPath, CSS class selectors (.btn-primary), or positional selectors (nth-child)
- NEVER put assertions (expect) inside page object methods
- NEVER use page.waitForTimeout()
- Methods are actions only: async fillForm(data: MyData), async submit(), async clickLink()

OUTPUT FORMAT:
Return ONLY a JSON block. goto(), imports, and class boilerplate are all assembled locally.

\`\`\`json
{
  "className": "ExamplePage",
  "dataInterface": "export interface ExampleData { username: string; password: string; }",
  "locators": [
    { "name": "usernameInput", "selector": "this.page.getByLabel('Username')" },
    { "name": "submitButton", "selector": "this.page.getByRole('button', { name: 'Submit' })" }
  ],
  "methods": [
    {
      "name": "fillForm",
      "params": "data: ExampleData",
      "steps": [
        { "target": "usernameInput", "action": "fill", "args": ["data.username"] },
        { "target": "passwordInput", "action": "fill", "args": ["data.password"] }
      ]
    },
    {
      "name": "submit",
      "params": "",
      "steps": [
        { "target": "submitButton", "action": "click", "args": [] }
      ]
    }
  ]
}
\`\`\`

Rules for the JSON:
- "dataInterface": full "export interface" string, or null if no form input
- "locators[].selector": right-hand side ONLY — no "this.xxx =" prefix
- "methods[].steps": each step is { target, action, args[] }
  - "target": the locator property name (must be declared in "locators")
  - "action": the Playwright method (fill, click, selectOption, check, press, waitFor)
  - "args": array of argument strings passed verbatim (e.g. ["data.username"] or ["networkidle"])
  - Assembled as: await this.<target>.<action>(<args joined by ", ">);
- goto() is generated automatically — do NOT include it in methods
- Choose className from the page title when it implies a clearer name than the URL slug
- No text outside the JSON block`;

// ── Local TypeScript assembler ─────────────────────────────────────────────────
// Renders the JSON sections from Claude into a complete page object file.
// Structured step objects let Claude output semantic intent; TypeScript is assembled locally.

interface LocatorDef {
  name: string;
  selector: string;
}

// Structured step: Claude emits { target, action, args } — assembler renders TypeScript.
// Eliminates method-call syntax from Claude output and enables local validation.
interface StepDef {
  target: string;  // locator property name
  action: string;  // Playwright method: fill, click, selectOption, check, press …
  args: string[];  // arguments passed verbatim (e.g. ["data.username"] or ["networkidle"])
}

interface MethodDef {
  name: string;
  params: string;
  steps: StepDef[];
}

interface PageObjectResult {
  className: string;
  dataInterface: string | null;
  locators: LocatorDef[];
  methods: MethodDef[];
}

/**
 * Validates method steps before writing:
 *   - Rejects steps referencing undeclared locators
 *   - Rejects goto() steps (always generated locally)
 *
 * Returns { valid, warnings } — caller warns and skips invalid steps rather than aborting.
 */
function validateSteps(
  methods: MethodDef[],
  locatorNames: Set<string>,
): { valid: boolean; warnings: string[] } {
  const warnings: string[] = [];
  let valid = true;
  for (const method of methods) {
    for (const step of method.steps) {
      if (step.action === 'goto') {
        warnings.push(`Method "${method.name}": goto() step removed — generated automatically`);
        valid = false;
        continue;
      }
      if (step.target !== 'page' && !locatorNames.has(step.target)) {
        warnings.push(`Method "${method.name}": target "${step.target}" not in declared locators`);
        valid = false;
      }
    }
  }
  return { valid, warnings };
}

function assemblePageObjectFile(result: PageObjectResult, targetUrl: string): string {
  const lines: string[] = ["import { Locator, Page } from '@playwright/test';", ''];

  if (result.dataInterface) {
    lines.push(result.dataInterface, '');
  }

  lines.push(`export class ${result.className} {`);
  for (const loc of result.locators) {
    lines.push(`  readonly ${loc.name}: Locator;`);
  }

  lines.push('', `  constructor(private readonly page: Page) {`);
  for (const loc of result.locators) {
    lines.push(`    this.${loc.name} = ${loc.selector};`);
  }
  lines.push('  }');

  // goto() always generated locally
  const gotoUrl = new URL(targetUrl).pathname.replace(/^\/parabank\//, '');
  lines.push('', `  async goto(): Promise<void> {`);
  lines.push(`    await this.page.goto('${gotoUrl}');`);
  lines.push('  }');

  // Render structured steps: { target, action, args } → await this.<target>.<action>(<args>);
  const locatorNames = new Set(result.locators.map((l) => l.name));
  for (const method of result.methods) {
    const validSteps = method.steps.filter((s) => s.action !== 'goto' && (s.target === 'page' || locatorNames.has(s.target)));
    const body = validSteps.map((step) =>
      `    await this.${step.target}.${step.action}(${step.args.join(', ')});`
    ).join('\n');
    lines.push(
      '',
      `  async ${method.name}(${method.params}): Promise<void> {`,
      body || '    // no steps',
      '  }',
    );
  }

  lines.push('}', '');
  return lines.join('\n');
}

// ── Class name derivation ─────────────────────────────────────────────────────

function deriveClassName(url: string): string {
  const parsed = new URL(url);
  const segment = path.basename(parsed.pathname, '.htm') || 'Home';
  // Convert kebab/dot separated to PascalCase then append Page
  const pascal = segment
    .split(/[-_.]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join('');
  return pascal.endsWith('Page') ? pascal : `${pascal}Page`;
}

// ── Live HTML extractor ───────────────────────────────────────────────────────

interface AuthCredentials {
  username: string;
  password: string;
}

interface PageSnapshot {
  html: string;
  title: string;
}

async function fetchInteractiveHtml(url: string, auth?: AuthCredentials): Promise<PageSnapshot> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });

  try {
    const page = await context.newPage();

    if (auth) {
      await page.goto(new URL('login.htm', BASE_URL).href);
      await page.getByPlaceholder('Username').fill(auth.username);
      await page.getByPlaceholder('Password').fill(auth.password);
      await page.getByRole('button', { name: 'Log In' }).click();
      await page.waitForLoadState('networkidle');
    }

    await page.goto(url);
    await page.waitForLoadState('domcontentloaded');

    // Capture page title — used to help Claude choose a better class name than
    // the URL slug provides. "ParaBank - Open New Account" → OpenAccountPage
    // rather than the URL-derived "OpenaccountPage".
    const title = await page.title();

    // Extract interactive elements only — avoids sending MB of layout HTML
    // Ancestor-deduplication prevents double-listing children already inside a <form>
    const html = await page.evaluate(() => {
      const selectors = [
        'form', 'input', 'select', 'textarea', 'button', 'label',
        '[data-testid]', '[role="button"]', '[role="link"]', '[role="textbox"]',
        '[role="combobox"]', '[role="checkbox"]', '[role="radio"]', 'a[href]',
        'h1', 'h2', '[aria-label]',
      ].join(', ');

      const elements = Array.from(document.querySelectorAll(selectors));
      const topLevel = elements.filter(
        (el) => !elements.some((p) => p !== el && p.contains(el)),
      );
      return topLevel.map((el) => (el as HTMLElement).outerHTML).join('\n');
    });

    const capped =
      html.length > 8_000
        ? html.slice(0, 8_000) + '\n<!-- truncated — remaining elements omitted -->'
        : html;

    return { html: capped, title };
  } finally {
    await context.close().catch(() => null);
    await browser.close().catch(() => null);
  }
}

// ── Confirmation prompt ───────────────────────────────────────────────────────

function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y');
    });
  });
}

// ── Fixtures registration check ───────────────────────────────────────────────

function isRegisteredInFixtures(className: string): boolean {
  const fixturesPath = 'tests/fixtures/fixtures.ts';
  if (!fs.existsSync(fixturesPath)) return false;
  return fs.readFileSync(fixturesPath, 'utf-8').includes(className);
}

// ── TypeScript validation ────────────────────────────────────────────────────
// Runs tsc --noEmit project-wide (respects tsconfig.json) and filters output to
// lines referencing the written file. Same approach as testGenerator.ts.

function validateTypeScript(writtenPath: string): { valid: boolean; errors: string } {
  try {
    execSync('npx tsc --noEmit', { encoding: 'utf-8', stdio: 'pipe' });
    return { valid: true, errors: '' };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const raw = (e.stdout ?? e.stderr ?? e.message ?? '').trim();
    const normalizedPath = writtenPath.replace(/\\/g, '/');
    const relevant = raw
      .split('\n')
      .filter((line) => line.replace(/\\/g, '/').includes(normalizedPath));
    if (relevant.length === 0) return { valid: true, errors: '' };
    return { valid: false, errors: relevant.join('\n') };
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function generatePageObject(
  url: string,
  className: string,
  write: boolean,
  auth?: AuthCredentials,
): Promise<void> {
  console.error(`\nGenerating page object for: ${url}`);
  console.error(`Class name: ${className}\n`);

  let html = '';
  let pageTitle = '';
  try {
    const snapshot = await fetchInteractiveHtml(url, auth);
    html = snapshot.html;
    pageTitle = snapshot.title;
    console.error(`✓ Interactive elements extracted (page title: "${pageTitle}")\n`);
  } catch (err) {
    console.warn(`⚠ Could not load page: ${(err as Error).message}`);
    console.warn('Continuing with URL-only generation (no live HTML).\n');
  }

  // Build user message — skip sections that have no content to avoid "not available" noise.
  const msgParts: string[] = [`## Target URL\n${url}`];
  // Include page title only when we actually have one — Claude picks better class names
  // from real titles ("ParaBank - Open New Account" → OpenAccountPage) than from the slug.
  if (pageTitle) {
    msgParts.push(`## Page title (prefer for naming over URL slug)\n${pageTitle}`);
  }
  msgParts.push(`## Suggested class name\n${className}`);
  if (html) {
    msgParts.push(`## Interactive elements from live page\n\`\`\`html\n${html}\n\`\`\``);
  }
  const userMessage = msgParts.join('\n\n');

  const elementCount = html ? (html.match(/^</gm) ?? []).length : 0;
  // Model selection:
  //   >8 elements with live HTML → Opus+thinking (complex accessibility tree reasoning)
  //   ≤8 elements with HTML     → Sonnet (clear structure, straightforward locator choices)
  //   No HTML (URL/title only)  → Sonnet-first; escalate to Opus only if JSON invalid/incomplete
  const useOpusDirect = html.length > 0 && elementCount > 8;
  const useSonnetFirst = html.length === 0; // no live HTML — try cheap path first

  const systemBlock = [{ type: 'text' as const, text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' as const } }];

  const buildRequest = (model: string, maxTokens: number, thinking?: boolean) =>
    client.messages.stream({
      model,
      max_tokens: maxTokens,
      ...(thinking ? { thinking: { type: 'enabled' as const, budget_tokens: 5000 } } : {}),
      system: systemBlock,
      messages: [{ role: 'user', content: userMessage }],
    });

  let fullText: string;

  if (useOpusDirect) {
    console.error(`  Using Claude Opus (with thinking) — ${elementCount} elements, complex page\n`);
    const stream = await buildRequest('claude-opus-4-6', 16000, true);
    fullText = await streamToStdout(stream, '', { model: 'opus', elements: elementCount, html_available: true });
  } else if (useSonnetFirst) {
    console.error(`  No HTML — trying Claude Sonnet first (URL/title-only generation)\n`);
    const sonnetStream = await buildRequest('claude-sonnet-4-6', 8000, false);
    fullText = await streamToStdout(sonnetStream, '', { model: 'sonnet-first', elements: 0, html_available: false });
    // Check if Sonnet produced a valid JSON block with required fields
    const jsonCheck = fullText.match(/```json\n([\s\S]*?)```/);
    let sonnetOk = false;
    if (jsonCheck) {
      try {
        const parsed = JSON.parse(jsonCheck[1]) as PageObjectResult;
        sonnetOk = !!(parsed.className && Array.isArray(parsed.locators) && Array.isArray(parsed.methods));
      } catch { /* fall through */ }
    }
    if (!sonnetOk) {
      console.error('\n⚠  Sonnet JSON invalid or incomplete — escalating to Opus+thinking...\n');
      const opusStream = await buildRequest('claude-opus-4-6', 16000, true);
      fullText = await streamToStdout(opusStream, '', { model: 'opus-escalated', elements: 0, html_available: false });
    }
  } else {
    console.error(`  Using Claude Sonnet — ${elementCount} element(s), live HTML available\n`);
    const stream = await buildRequest('claude-sonnet-4-6', 8000, false);
    fullText = await streamToStdout(stream, '', { model: 'sonnet', elements: elementCount, html_available: true });
  }

  if (!write) return;

  const jsonMatch = fullText.match(/```json\n([\s\S]*?)```/);
  if (!jsonMatch) {
    console.error('⚠  Could not find JSON block in response. Review the output above.');
    return;
  }

  let result: PageObjectResult;
  try {
    result = JSON.parse(jsonMatch[1]) as PageObjectResult;
  } catch {
    console.error('⚠  Could not parse JSON block — review the output above.');
    return;
  }

  if (!result.className || !Array.isArray(result.locators) || !Array.isArray(result.methods)) {
    console.error('⚠  JSON block is missing required fields (className, locators, methods).');
    return;
  }

  // Validate steps before assembling — reject unknown locator refs and goto() calls
  const locatorNames = new Set(result.locators.map((l) => l.name));
  const { valid: stepsValid, warnings: stepWarnings } = validateSteps(result.methods, locatorNames);
  if (stepWarnings.length > 0) {
    for (const w of stepWarnings) console.warn(`  ⚠ ${w}`);
  }
  if (!stepsValid) {
    console.warn('  ⚠ Step validation failed — file assembled with invalid steps filtered out.');
  }

  const fileContent = assemblePageObjectFile(result, url);
  const filePath = `tests/pages/${result.className}.ts`;
  const exists = fs.existsSync(filePath) ? ' ⚠ OVERWRITES EXISTING' : ' (new)';
  console.error(`\nFile to write: ${filePath}${exists}`);

  const ok = await confirm('Write this file?');
  if (!ok) { console.error('Aborted — nothing written.'); return; }

  fs.mkdirSync('tests/pages', { recursive: true });
  fs.writeFileSync(filePath, fileContent, 'utf-8');
  console.error(`✓ Written: ${filePath}`);
  reportPostWrite(filePath, result.className);
}

function reportPostWrite(filePath: string, className: string): void {
  // TypeScript validation — catches import errors or type mismatches in the generated class
  console.error('\nValidating TypeScript...');
  const { valid, errors } = validateTypeScript(filePath);
  if (valid) {
    console.error('  ✓ No TypeScript errors');
  } else {
    console.error('  ✗ TypeScript errors detected:');
    console.error(errors.split('\n').map((l) => `    ${l}`).join('\n'));
    console.error('  File written — fix errors manually or re-run the generator.');
  }

  if (!isRegisteredInFixtures(className)) {
    // Generate the fixture entry locally — no need for Claude to emit it.
    const fixtureName = className.charAt(0).toLowerCase() + className.slice(1);
    console.error(`\n⚠  Register ${className} in tests/fixtures/fixtures.ts:`);
    console.error(`   import { ${className} } from '../pages/${className}';`);
    console.error(`   ${fixtureName}: async ({ page }, use) => { await use(new ${className}(page)); },`);
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes('--help') || args.length === 0) {
  console.error(
    'Usage:\n' +
    '  npx tsx tests/agents/pageObjectGenerator.ts --url http://localhost:3000/parabank/register.htm\n' +
    '  npx tsx tests/agents/pageObjectGenerator.ts --url .../transfer.htm --name TransferPage\n' +
    '  npx tsx tests/agents/pageObjectGenerator.ts --url .../overview.htm --auth admin admin123 --write',
  );
  process.exit(args.length === 0 ? 1 : 0);
}

const urlFlag = args.indexOf('--url');
const nameFlag = args.indexOf('--name');
const authFlag = args.indexOf('--auth');

const url = urlFlag !== -1 ? args[urlFlag + 1] : null;
const write = args.includes('--write');
const auth: AuthCredentials | undefined =
  authFlag !== -1 ? { username: args[authFlag + 1], password: args[authFlag + 2] } : undefined;

if (!url) {
  console.error('--url <url> is required.');
  process.exit(1);
}

// Resolve relative URLs against BASE_URL
const resolvedUrl = url.startsWith('http') ? url : new URL(url, BASE_URL).href;
const className = nameFlag !== -1 ? args[nameFlag + 1] : deriveClassName(resolvedUrl);

generatePageObject(resolvedUrl, className, write, auth).catch((err: Error) => {
  console.error('Page object generator error:', err.message);
  process.exit(1);
});
