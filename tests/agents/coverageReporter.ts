/**
 * Coverage Reporter Agent
 *
 * Discovers every page and feature in Parabank by crawling its navigation
 * (with optional authenticated crawl for post-login pages), then compares
 * the discovered surface against existing spec files to identify gaps.
 * Produces a prioritised, risk-scored coverage report.
 *
 * Model: claude-sonnet-4-6 — analysis and prioritisation without needing
 * extended reasoning. Prompt caching on the static Parabank feature map.
 *
 * Usage:
 *   npx tsx tests/agents/coverageReporter.ts
 *   npx tsx tests/agents/coverageReporter.ts --auth <username> <password>
 *   npx tsx tests/agents/coverageReporter.ts --output coverage-gaps.md
 */

import Anthropic from '@anthropic-ai/sdk';
import { chromium, type Page } from 'playwright';
import fs from 'fs';
import path from 'path';
import { streamToStdout } from './lib/streamUtils.js';

const client = new Anthropic();
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000/parabank/';

// ── System prompt (cached) ──────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a senior QA architect analysing test coverage for Parabank, a Java web banking application.

Given:
1. A list of discovered pages/features from crawling the live app
2. A summary of existing Playwright spec files and what they cover

Produce a coverage report in this format:

## Coverage Summary
Overall coverage: X / Y pages tested (Z%)

## ✅ Well Covered
List pages/features with solid test coverage.

## ⚠️ Partially Covered
List pages/features with some tests but missing important scenarios (happy path only, no error states, etc.).
For each: describe the specific gaps.

## 🔴 Not Covered — Priority Order
List untested pages/features ranked by risk. For each entry:
**<Page/Feature Name>**
Risk: [Critical | High | Medium | Low]
Why: <one sentence on the business/technical risk of this gap>
Suggest: <one concrete test scenario to write first>

## Recommended Next Sprint
The top 3 test files the team should create, in priority order, with suggested file names.`;

// ── Crawler ─────────────────────────────────────────────────────────────────

interface DiscoveredPage {
  url: string;
  title: string;
  requiresAuth: boolean;
  navLabel: string;
}

async function crawlParabank(auth?: { username: string; password: string }): Promise<DiscoveredPage[]> {
  const browser = await chromium.launch({ headless: true });
  const discovered: DiscoveredPage[] = [];
  const visitedUrls = new Set<string>();

  try {
    // Explicit viewport matches the project standard (1280×720) so Parabank's
    // responsive layout renders identically to what tests see — crawled links
    // reflect the same navigation structure the specs will interact with.
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();

    async function recordPage(p: Page, requiresAuth: boolean, navLabel: string): Promise<void> {
      const url = p.url().replace(/[?#].*$/, ''); // strip query/hash
      if (visitedUrls.has(url)) return;
      visitedUrls.add(url);
      const title = await p.title().catch(() => '');
      discovered.push({ url, title, requiresAuth, navLabel });
    }

    async function extractInternalLinks(p: Page): Promise<string[]> {
      // locator().evaluateAll() replaces the deprecated page.$$eval()
      const links = await p.locator('a[href]').evaluateAll(
        (anchors, base) =>
          (anchors as HTMLAnchorElement[])
            .map((a) => a.href)
            .filter((href) => href.startsWith(base) && !href.includes('logout')),
        BASE_URL,
      );
      return [...new Set(links)];
    }

    // ── Unauthenticated crawl ─────────────────────────────────────────────────
    console.error('Crawling public pages...');
    await page.goto(BASE_URL);
    await page.waitForLoadState('domcontentloaded');
    await recordPage(page, false, 'Home / Login');

    const publicLinks = await extractInternalLinks(page);
    for (const link of publicLinks) {
      if (visitedUrls.has(link)) continue;
      await page.goto(link);
      await page.waitForLoadState('domcontentloaded').catch(() => null);
      const navLabel = link.replace(BASE_URL, '').replace('.htm', '');
      await recordPage(page, false, navLabel);
    }

    // ── Authenticated crawl ───────────────────────────────────────────────────
    if (auth) {
      console.error('Logging in for authenticated page crawl...');
      await page.goto(new URL('login.htm', BASE_URL).href);
      await page.getByPlaceholder('Username').fill(auth.username);
      await page.getByPlaceholder('Password').fill(auth.password);
      await page.getByRole('button', { name: 'Log In' }).click();
      await page.waitForLoadState('networkidle').catch(() => null);

      if (page.url().includes('login')) {
        console.warn('  ⚠ Login may have failed — authenticated pages may be missing from the report.');
      } else {
        await recordPage(page, true, 'Account Overview');
        const authLinks = await extractInternalLinks(page);
        for (const link of authLinks) {
          if (visitedUrls.has(link)) continue;
          await page.goto(link);
          await page.waitForLoadState('domcontentloaded').catch(() => null);
          const navLabel = link.replace(BASE_URL, '').replace('.htm', '');
          await recordPage(page, true, navLabel);
        }
      }
    }
  } finally {
    await browser.close().catch(() => null);
  }

  return discovered;
}

// ── Spec scanner ─────────────────────────────────────────────────────────────

interface SpecSummary {
  filePath: string;
  testCount: number;
  keywords: string[];
}

function scanSpecFiles(): SpecSummary[] {
  const testDirs = ['tests/ui', 'tests/api', 'tests/accessibility', 'tests/performance'];
  const summaries: SpecSummary[] = [];

  const walkDir = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkDir(full); // recurse — catches tests/ui/flows/*.spec.ts etc.
      } else if (entry.name.endsWith('.spec.ts')) {
        const src = fs.readFileSync(full, 'utf-8');
        const testCount = (src.match(/\btest\s*\(/g) ?? []).length;
        const keywords = [
          ...[...src.matchAll(/(?:test|describe)\s*\(\s*['"`]([^'"`]+)['"`]/g)].map(([, t]) => t),
        ].slice(0, 20);
        summaries.push({ filePath: full, testCount, keywords });
      }
    }
  };

  for (const dir of testDirs) walkDir(dir);
  return summaries;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function reportCoverage(
  auth: { username: string; password: string } | undefined,
  outputPath: string | null,
): Promise<void> {
  if (!auth) {
    console.error(
      '⚠  --auth not provided — authenticated pages will be excluded from the coverage report.\n' +
      '   Re-run with: --auth <username> <password> for complete coverage.\n',
    );
  }

  console.error('Starting coverage analysis...\n');

  const specs = scanSpecFiles();
  const discovered = await crawlParabank(auth);

  if (discovered.length === 0) {
    console.error(
      `\n✗ No pages discovered from ${BASE_URL}\n` +
      '  Parabank may not be running. Start it with:\n' +
      '    docker run -d -p 3000:8080 parasoft/parabank\n' +
      `    curl -X POST ${new URL('services/bank/initializeDB', BASE_URL).href}`,
    );
    process.exit(1);
  }

  console.error(`\nDiscovered ${discovered.length} page(s), found ${specs.length} spec file(s).\n`);

  // Strip the common base URL prefix — every line would otherwise repeat the full origin.
  // Claude only needs the path to understand the page identity.
  const stripBase = (url: string) => url.replace(BASE_URL, '/');

  // Cap discovered pages sent to Claude — deep crawls of large apps can produce
  // 50+ URLs (including query-string variants). Priority: auth pages first (higher
  // coverage risk), then public pages. 40 is enough for complete Parabank coverage.
  const PAGE_CAP = 40;
  const prioritised = [
    ...discovered.filter((p) => p.requiresAuth),
    ...discovered.filter((p) => !p.requiresAuth),
  ].slice(0, PAGE_CAP);
  const truncationNote = discovered.length > PAGE_CAP
    ? `\n_(${discovered.length - PAGE_CAP} additional page(s) omitted — showing top ${PAGE_CAP} by auth priority)_`
    : '';

  const discoveredSection = prioritised
    .map((p) => `- [${p.requiresAuth ? 'AUTH' : 'PUBLIC'}] ${p.navLabel} — ${stripBase(p.url)} (title: "${p.title}")`)
    .join('\n') + truncationNote;

  // Limit keywords per spec to 6 — enough for coverage mapping without token bloat
  const specsSection = specs
    .map(
      (s) =>
        `- ${s.filePath} (${s.testCount} test(s))\n  Keywords: ${s.keywords.slice(0, 6).join(', ')}`,
    )
    .join('\n');

  const userMessage =
    `## Discovered pages and features (from live crawl)\n${discoveredSection}\n\n` +
    `## Existing spec files and their coverage keywords\n${specsSection}`;

  console.error('Asking Claude to analyse coverage gaps...\n');

  const stream = await client.messages.stream({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{ role: 'user', content: userMessage }],
  });

  const fullText = await streamToStdout(stream);

  if (outputPath) {
    const header = `# Test Coverage Report — Parabank\n_Generated: ${new Date().toISOString()}_\n\n`;
    fs.writeFileSync(outputPath, header + fullText, 'utf-8');
    console.error(`✓ Report saved to: ${outputPath}`);
  }
}

// ── Entry point ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const authFlag = args.indexOf('--auth');
const outputFlag = args.indexOf('--output');

const auth =
  authFlag !== -1 ? { username: args[authFlag + 1], password: args[authFlag + 2] } : undefined;
const outputPath = outputFlag !== -1 ? args[outputFlag + 1] : null;

reportCoverage(auth, outputPath).catch((err: Error) => {
  console.error('Coverage reporter error:', err.message);
  process.exit(1);
});
