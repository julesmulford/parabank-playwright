/**
 * Locator Healing Agent
 *
 * When a test fails because a locator no longer matches, this agent:
 *  1. Reads the page object and infers the target URL (from goto() call or convention)
 *  2. Optionally logs in first so authenticated pages render correctly
 *  3. Fetches live page HTML via a real Chromium instance
 *  4. Asks Claude to suggest better locators following the project's priority order
 *  5. Shows a line-level diff and writes the fix only when --apply is passed
 *
 * Model: claude-opus-4-6 with enabled thinking — locator decisions require
 * reasoning about accessibility tree vs DOM structure tradeoffs.
 * Prompt caching: system prompt (locator rules) is cached across all heals.
 *
 * Usage:
 *   npx tsx tests/agents/locatorHealer.ts --page tests/pages/RegistrationPage.ts
 *   npx tsx tests/agents/locatorHealer.ts --page tests/pages/LoginPage.ts --apply
 *   npx tsx tests/agents/locatorHealer.ts --all                # heal every page object
 *   npx tsx tests/agents/locatorHealer.ts --all --apply        # heal and write all
 *   npx tsx tests/agents/locatorHealer.ts --page ... --auth admin password1
 */

import Anthropic from '@anthropic-ai/sdk';
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { streamToStdout } from './lib/streamUtils.js';

const client = new Anthropic();

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000/parabank/';

// ── System prompt (cached) ──────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a Playwright locator expert performing a locator audit on a TypeScript page object class.

Locator priority order — always prefer the highest applicable tier:
1. page.getByRole('button', { name: '...' })   — most resilient, matches accessibility tree
2. page.getByLabel('...')                        — ideal for all labelled form inputs
3. page.getByTestId('...')                       — when data-testid attributes exist
4. page.getByText('...') / page.getByPlaceholder('...')  — visible text or placeholder
5. page.locator('[id="..."]')                   — last resort when no semantic selector exists

Rules:
- NEVER suggest XPath (//), CSS class selectors (.className), or positional selectors (nth-child, nth-of-type)
- Prefer exact name matches in getByRole to avoid ambiguity
- If a label element is present in the HTML, always prefer getByLabel over locator('[id="..."]')
- Readonly constructor properties must stay readonly

Response format:
For each locator that should change, output:
  Original:    <the exact current line>
  Replacement: <the improved line>
  Reason:      <one sentence explaining the improvement>

If all locators are already optimal, say exactly: "All locators are optimal — no changes needed."

Then output the COMPLETE updated TypeScript file in a \`\`\`typescript block.
If no changes are needed, output the original file unchanged inside the block.`;

// ── URL resolution ──────────────────────────────────────────────────────────

function extractGotoUrl(src: string): string | null {
  // Match: await this.page.goto('login.htm') or await this.page.goto("register.htm")
  // Deliberately excludes template literals with interpolation (e.g. `${BASE_URL}login.htm`)
  // because passing the raw template string to new URL() produces garbage like
  // "http://localhost:3000/parabank/${BASE_URL}login.htm". Those fall through to
  // convention-based URL resolution instead.
  const match = src.match(/\.goto\(\s*(['"])([^'"`${}]+)\1/);
  return match ? match[2] : null;
}

function resolveTargetUrl(pageObjectPath: string, src: string): string {
  const fromGoto = extractGotoUrl(src);
  if (fromGoto) {
    return fromGoto.startsWith('http') ? fromGoto : new URL(fromGoto, BASE_URL).href;
  }
  // Convention: RegistrationPage → register.htm, AccountOverviewPage → account-overview.htm
  // Split on capital letters to produce kebab-case, then strip the trailing "-page" segment.
  const className = path.basename(pageObjectPath, '.ts');
  const slug = className
    .replace(/([A-Z])/g, '-$1')
    .toLowerCase()
    .replace(/^-/, '')
    .replace(/-page$/, '');
  return new URL(`${slug}.htm`, BASE_URL).href;
}

// ── Live HTML fetcher ───────────────────────────────────────────────────────

interface AuthCredentials {
  username: string;
  password: string;
}

/**
 * Extracts only the interactive elements from a page — forms, inputs, labels,
 * buttons, selects, and ARIA-role elements. This is ~80% fewer tokens than
 * sending the full body while giving Claude everything it needs to suggest
 * better locators.
 */
async function fetchInteractiveHtml(
  url: string,
  auth: AuthCredentials | undefined,
  sharedBrowser?: import('playwright').Browser,
): Promise<{ html: string; ownsBrowser: boolean; browser: import('playwright').Browser }> {
  const ownsBrowser = !sharedBrowser;
  const browser = sharedBrowser ?? await chromium.launch({ headless: true });
  // Explicit viewport matches the project standard (1280×720) so responsive elements
  // render identically to what developers see — locator suggestions stay consistent.
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

    // Extract only elements relevant for locator decisions — not the whole body.
    // Ancestor-deduplication avoids double-listing children already inside a <form>.
    const html = await page.evaluate(() => {
      const selectors = [
        'form', 'input', 'label', 'select', 'textarea', 'button',
        '[data-testid]', '[role="button"]', '[role="link"]',
        '[role="textbox"]', '[role="combobox"]', '[role="checkbox"]', 'a[href]',
      ].join(', ');

      const elements = Array.from(document.querySelectorAll(selectors));
      const topLevel = elements.filter((el) => !elements.some((p) => p !== el && p.contains(el)));
      return topLevel.map((el) => (el as HTMLElement).outerHTML).join('\n');
    });

    const capped =
      html.length > 6_000
        ? html.slice(0, 6_000) + '\n<!-- truncated — remaining elements omitted -->'
        : html;
    return { html: capped, ownsBrowser, browser };
  } finally {
    // Always close the context; the caller decides whether to close the browser
    await context.close().catch(() => null);
  }
}

// ── Diff display ────────────────────────────────────────────────────────────

function printDiff(original: string, updated: string): number {
  const origLines = original.split('\n');
  const newLines = updated.split('\n');
  const maxLen = Math.max(origLines.length, newLines.length);

  console.log('\n── Diff ─────────────────────────────────────────────────────────');
  let changes = 0;
  for (let i = 0; i < maxLen; i++) {
    const o = origLines[i] ?? '';
    const n = newLines[i] ?? '';
    if (o !== n) {
      console.log(`  L${String(i + 1).padStart(4, ' ')}  - ${o}`);
      console.log(`         + ${n}`);
      changes++;
    }
  }
  console.log(`─────────────────────────────────────────────── ${changes} line(s) changed\n`);
  return changes;
}

// ── Core heal function ──────────────────────────────────────────────────────

async function healPageObject(
  pageObjectPath: string,
  apply: boolean,
  auth?: AuthCredentials,
  sharedBrowser?: import('playwright').Browser,
): Promise<void> {
  console.error(`\n▶ Healing: ${pageObjectPath}`);

  if (!fs.existsSync(pageObjectPath)) {
    console.error(`  ✗ File not found: ${pageObjectPath}`);
    return;
  }

  const originalSrc = fs.readFileSync(pageObjectPath, 'utf-8');
  const targetUrl = resolveTargetUrl(pageObjectPath, originalSrc);
  console.error(`  Target URL: ${targetUrl}`);

  let html = '';
  try {
    const result = await fetchInteractiveHtml(targetUrl, auth, sharedBrowser);
    html = result.html;
    // Only close the browser if we created it (not when sharing across --all)
    if (result.ownsBrowser) await result.browser.close().catch(() => null);
    console.error('  ✓ Interactive elements extracted');
  } catch (err) {
    console.warn(`  ⚠ Could not reach ${targetUrl}: ${(err as Error).message}`);
    console.warn('  Continuing with static source analysis only (no live HTML).');
  }

  const userMessage =
    `## Page object file: ${pageObjectPath}\n` +
    '```typescript\n' +
    originalSrc +
    '\n```\n\n' +
    (html
      ? `## Interactive page elements (forms, inputs, labels, buttons — targeted extraction)\n\`\`\`html\n${html}\n\`\`\``
      : '<!-- Live HTML unavailable — perform static analysis only -->');

  // Adaptive model selection:
  //   Small page objects with no live HTML — straightforward locator mapping with
  //   clear conventions. Sonnet handles this at ~20% of Opus cost.
  //   Large page objects OR live HTML present — structural reasoning over accessibility
  //   tree vs DOM hierarchy is exactly the extended-thinking use-case; use Opus.
  const locatorCount = (originalSrc.match(/this\.page\./g) ?? []).length;
  const useOpus = locatorCount >= 8 || html.length > 0;
  const model = useOpus ? 'claude-opus-4-6' : 'claude-sonnet-4-6';
  const maxTokens = useOpus ? 16000 : 8000;

  console.error(
    `  Asking ${useOpus ? 'Claude Opus (with thinking)' : 'Claude Sonnet'} to audit locators` +
    ` (${locatorCount} locator(s) found)...\n`,
  );

  // Opus: max_tokens covers thinking + text output combined.
  //   budget_tokens: 5000 for reasoning; remaining ~11000 for healed file + diff summary.
  // Sonnet: no thinking — simple page objects map cleanly to the priority order.
  const stream = await client.messages.stream({
    model,
    max_tokens: maxTokens,
    ...(useOpus ? { thinking: { type: 'enabled', budget_tokens: 5000 } } : {}),
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{ role: 'user', content: userMessage }],
  });

  const fullText = await streamToStdout(stream, '  ');

  if (apply) {
    const match = fullText.match(/```typescript\n([\s\S]*?)```/);
    if (match) {
      const updated = match[1];
      const changes = printDiff(originalSrc, updated);
      if (changes > 0) {
        fs.writeFileSync(pageObjectPath, updated, 'utf-8');
        console.error(`  ✓ Applied ${changes} change(s) to ${pageObjectPath}`);
      } else {
        console.error('  ✓ No changes required — file unchanged.');
      }
    } else {
      console.warn('  ⚠ Could not extract updated TypeScript block — nothing written.');
    }
  }
}

// ── Entry point ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const pageFlag = args.indexOf('--page');
const authFlag = args.indexOf('--auth');

const pageObjectPath = pageFlag !== -1 ? args[pageFlag + 1] : null;
const apply = args.includes('--apply');
const all = args.includes('--all');
const auth: AuthCredentials | undefined =
  authFlag !== -1 ? { username: args[authFlag + 1], password: args[authFlag + 2] } : undefined;

if (all) {
  const pagesDir = 'tests/pages';
  if (!fs.existsSync(pagesDir)) {
    console.error(`Pages directory not found: ${pagesDir}`);
    process.exit(1);
  }
  const pages = fs.readdirSync(pagesDir).filter((f) => f.endsWith('.ts'));
  console.error(`Found ${pages.length} page object(s) to heal.\n`);
  (async () => {
    // Launch one browser for all healings — avoids N cold-start overheads
    const sharedBrowser = await chromium.launch({ headless: true });
    try {
      for (const page of pages) {
        await healPageObject(path.join(pagesDir, page), apply, auth, sharedBrowser);
      }
    } finally {
      await sharedBrowser.close();
    }
    console.error('\n✓ All page objects processed.');
  })().catch((err: Error) => {
    console.error('Healer error:', err.message);
    process.exit(1);
  });
} else if (pageObjectPath) {
  healPageObject(pageObjectPath, apply, auth).catch((err: Error) => {
    console.error('Healer error:', err.message);
    process.exit(1);
  });
} else {
  console.error(
    'Usage:\n' +
      '  npx tsx tests/agents/locatorHealer.ts --page tests/pages/MyPage.ts [--apply]\n' +
      '  npx tsx tests/agents/locatorHealer.ts --all [--apply]\n' +
      '  npx tsx tests/agents/locatorHealer.ts --page ... --auth <username> <password>',
  );
  process.exit(1);
}
