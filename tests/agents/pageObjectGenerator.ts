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
- Export a typed data interface alongside the class if the page accepts form input (e.g. interface TransferData { fromAccount: string; toAccount: string; amount: string })
- Constructor: constructor(private readonly page: Page)
- All locators declared as readonly properties initialised in the constructor body

LOCATOR PRIORITY (highest to lowest resilience — use the highest applicable):
1. this.page.getByRole('button', { name: 'Submit' })   — most resilient
2. this.page.getByLabel('Username')                     — all labelled form inputs
3. this.page.getByTestId('submit-btn')                  — data-testid attributes
4. this.page.getByPlaceholder('Enter amount')           — placeholder text
5. this.page.getByText('Forgot password?')              — visible link/button text
6. this.page.locator('[id="customer.firstName"]')       — last resort (no semantic selector)

STRICT RULES:
- NEVER use XPath, CSS class selectors (.btn-primary), or positional selectors (nth-child)
- NEVER put assertions (expect) inside page object methods
- NEVER use page.waitForTimeout() — use Playwright's built-in action auto-wait
- Methods are actions only: async fillForm(data: MyData), async submit(), async clickForgotPassword()
- Add a goto() method: async goto() { await this.page.goto('<url>'); }

OUTPUT FORMAT:
// tests/pages/<ClassName>.ts
\`\`\`typescript
<complete file content>
\`\`\`

Then a short note listing which fixtures.ts entry to add.`;

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

  // Pass the page title so Claude can choose a semantically correct class name.
  // "ParaBank - Open New Account" → OpenAccountPage, not the URL-derived "OpenaccountPage".
  const userMessage =
    `## Target URL\n${url}\n\n` +
    `## Page title (prefer this for naming over the URL slug)\n${pageTitle || '(not available)'}\n\n` +
    `## Suggested class name (override if title implies a better name)\n${className}\n\n` +
    (html
      ? `## Interactive elements extracted from live page\n\`\`\`html\n${html}\n\`\`\``
      : `<!-- Live HTML unavailable — generate based on URL and class name conventions only -->`);

  // budget_tokens: 6000 for planning locator choices; remaining ~10000 for the generated class
  const stream = await client.messages.stream({
    model: 'claude-opus-4-6',
    max_tokens: 16000,
    thinking: { type: 'enabled', budget_tokens: 6000 },
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userMessage }],
  });

  const fullText = await streamToStdout(stream);

  if (!write) return;

  // Extract the typescript block
  const match = fullText.match(/\/\/ (tests\/pages\/[^\n]+\.ts)\s*\n```typescript\n([\s\S]*?)```/);
  if (!match) {
    // Fallback: extract any typescript block
    const fallback = fullText.match(/```typescript\n([\s\S]*?)```/);
    if (!fallback) {
      console.error('⚠  Could not parse a typescript block from the response. Review the output above.');
      return;
    }
    const outputPath = `tests/pages/${className}.ts`;
    const exists = fs.existsSync(outputPath) ? ' ⚠ OVERWRITES EXISTING' : ' (new)';
    console.error(`\nFile to write: ${outputPath}${exists}`);
    const ok = await confirm('Write this file?');
    if (!ok) { console.error('Aborted — nothing written.'); return; }
    fs.mkdirSync('tests/pages', { recursive: true });
    fs.writeFileSync(outputPath, fallback[1], 'utf-8');
    console.error(`✓ Written: ${outputPath}`);
    reportPostWrite(outputPath, className);
    return;
  }

  const [, filePath, content] = match;
  const exists = fs.existsSync(filePath) ? ' ⚠ OVERWRITES EXISTING' : ' (new)';
  console.error(`\nFile to write: ${filePath}${exists}`);

  const ok = await confirm('Write this file?');
  if (!ok) { console.error('Aborted — nothing written.'); return; }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
  console.error(`✓ Written: ${filePath}`);
  reportPostWrite(filePath, className);
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
    console.error(`\n⚠  Register ${className} in tests/fixtures/fixtures.ts before running UI tests:`);
    console.error(`   import { ${className} } from '../pages/${className}';`);
    console.error(`   ${className.charAt(0).toLowerCase() + className.slice(1)}: async ({ page }, use) => { await use(new ${className}(page)); },`);
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
