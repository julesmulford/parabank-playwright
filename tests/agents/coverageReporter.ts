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

const SYSTEM_PROMPT = `You are a senior QA architect advising on Playwright test coverage gaps for Parabank, a Java web banking application.

The coverage mapping has already been computed locally. You will receive:
1. Pages/features already confirmed as NOT covered or only partially covered (the local matcher found no spec keyword overlap)
2. Their best-matching spec files (if any partial overlap was found)

Your job is prioritisation and recommendations only — do NOT re-derive coverage from scratch.

Produce a coverage report in this format:

## Coverage Summary
(Totals will be pre-filled — add a one-sentence health assessment)

## ⚠️ Partially Covered
For each partially-covered page: name the specific missing scenarios (error states, auth edge cases, negative paths).

## 🔴 Not Covered — Priority Order
Rank uncovered pages by business/technical risk. For each:
**<Page/Feature Name>**
Risk: [Critical | High | Medium | Low]
Why: <one sentence on the business/technical risk>
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

// ── Local coverage mapper ─────────────────────────────────────────────────────

type CoverageLevel = 'well-covered' | 'partial' | 'uncovered';

interface CoverageMapping {
  page: DiscoveredPage;
  matchedSpecs: Array<{ filePath: string; testCount: number; matchScore: number }>;
  coverageLevel: CoverageLevel;
  normalizedScore: number;
}

// Generic banking words that appear on every Parabank page — including them would match
// almost every spec and produce false "well-covered" classifications.
const COVERAGE_BLACKLIST = new Set([
  'page', 'bank', 'para', 'parabank', 'account', 'overview', 'index', 'home',
  'user', 'customer', 'from', 'list', 'view', 'welcome', 'services', 'about',
  'contact', 'news', 'read', 'more', 'back', 'next', 'submit', 'cancel',
]);

// Synonym normalization — maps aliases to canonical terms so "signin" matches a spec
// titled "login" and "signup" matches "register".
const SYNONYMS: Record<string, string> = {
  signin: 'login', 'sign-in': 'login', signout: 'logout',
  signup: 'register', 'sign-up': 'register', registration: 'register',
  billpay: 'bill', payment: 'bill', bills: 'bill',
  funds: 'fund', funding: 'fund',
  newaccount: 'openaccount', openaccount: 'openaccount',
  findtransaction: 'transaction', transactions: 'transaction',
};

function normalizeWord(w: string): string {
  return SYNONYMS[w] ?? w;
}

/**
 * Computes page-to-spec coverage locally using filtered keyword overlap.
 *
 * Key improvements over naive overlap:
 *   1. Blacklist: generic banking words (account, page, bank) are excluded — they match
 *      every spec and inflate the score without improving precision.
 *   2. Synonym normalization: "signin" → "login", "signup" → "register", etc.
 *   3. Normalized score: divides raw match count by page word count so pages with many
 *      identity words (long titles) don't get false "well-covered" from 2 coincidental matches.
 *
 * Classification (normalized score = raw matches / distinct page keywords):
 *   well-covered  — ≥ 0.30  (30%+ of meaningful page keywords matched a spec)
 *   partial       — ≥ 0.08  (some signal, likely one keyword matched)
 *   uncovered     — < 0.08  (no meaningful overlap)
 */
function computeLocalCoverage(
  pages: DiscoveredPage[],
  specs: SpecSummary[],
): CoverageMapping[] {
  const stripBase = (url: string) =>
    url.replace(BASE_URL, '').replace(/\.htm$/, '').replace(/[/_-]/g, ' ').toLowerCase();

  return pages.map((page) => {
    // Collect and normalize identity words — apply blacklist and synonym map
    const rawWords = [
      ...stripBase(page.url).split(/\s+/),
      ...page.title.toLowerCase().split(/\W+/),
      ...page.navLabel.toLowerCase().split(/\W+/),
    ];
    const pageWords = new Set<string>(
      rawWords
        .filter((w) => w.length > 3 && !COVERAGE_BLACKLIST.has(w))
        .map(normalizeWord),
    );

    if (pageWords.size === 0) {
      // All words were blacklisted — treat as uncovered to avoid false positives
      return { page, matchedSpecs: [], coverageLevel: 'uncovered', normalizedScore: 0 };
    }

    // Score each spec — normalize spec words through the same synonym map
    const scoredSpecs = specs
      .map((spec) => {
        const specText = [
          spec.keywords.join(' ').toLowerCase(),
          spec.filePath.toLowerCase().replace(/[/_\\-]/g, ' '),
        ]
          .join(' ')
          .split(/\W+/)
          .filter((w) => w.length > 3 && !COVERAGE_BLACKLIST.has(w))
          .map(normalizeWord)
          .join(' ');

        const matchScore = [...pageWords].filter((w) => specText.includes(w)).length;
        return { filePath: spec.filePath, testCount: spec.testCount, matchScore };
      })
      .filter((s) => s.matchScore > 0)
      .sort((a, b) => b.matchScore - a.matchScore);

    // Normalize: raw score ÷ page word count — prevents long titles inflating coverage
    const topScore = scoredSpecs[0]?.matchScore ?? 0;
    const normalizedScore = topScore / pageWords.size;
    const coverageLevel: CoverageLevel =
      normalizedScore >= 0.30 ? 'well-covered' :
      normalizedScore >= 0.08 ? 'partial' :
      'uncovered';

    return { page, matchedSpecs: scoredSpecs.slice(0, 2), coverageLevel, normalizedScore };
  });
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

  console.error(`\nDiscovered ${discovered.length} page(s), found ${specs.length} spec file(s).`);
  console.error('Computing local coverage mapping...\n');

  // Cap discovered pages — auth pages first (higher coverage risk), then public.
  const PAGE_CAP = 40;
  const prioritised = [
    ...discovered.filter((p) => p.requiresAuth),
    ...discovered.filter((p) => !p.requiresAuth),
  ].slice(0, PAGE_CAP);

  // Compute coverage locally — avoids sending all pages + all specs to Claude for mapping.
  const mapping = computeLocalCoverage(prioritised, specs);

  const wellCovered = mapping.filter((m) => m.coverageLevel === 'well-covered');
  const partial = mapping.filter((m) => m.coverageLevel === 'partial');
  const uncovered = mapping.filter((m) => m.coverageLevel === 'uncovered');

  console.error(
    `  ✅ Well covered: ${wellCovered.length}  ` +
    `⚠️ Partial: ${partial.length}  ` +
    `🔴 Uncovered: ${uncovered.length}\n`,
  );

  // Cap the gap payload sent to Claude: prioritize auth pages (highest risk) and partial
  // pages (Claude can name specific missing scenarios), then public uncovered pages.
  // Pages beyond the cap are summarized locally as a count — Claude doesn't need to see them
  // individually to give useful recommendations for the top-risk items.
  const GAP_CAP = 15;
  const stripBase = (url: string) => url.replace(BASE_URL, '/');

  // Priority order: partial auth > uncovered auth > partial public > uncovered public
  const prioritizedGaps: CoverageMapping[] = [
    ...partial.filter((m) => m.page.requiresAuth),
    ...uncovered.filter((m) => m.page.requiresAuth),
    ...partial.filter((m) => !m.page.requiresAuth),
    ...uncovered.filter((m) => !m.page.requiresAuth),
  ];
  const capped = prioritizedGaps.slice(0, GAP_CAP);
  const overflow = prioritizedGaps.length - capped.length;

  const buildPageLine = (m: CoverageMapping) => {
    const tag = m.page.requiresAuth ? 'AUTH' : 'PUBLIC';
    const status = m.coverageLevel === 'partial' ? '⚠️' : '🔴';
    const specNote =
      m.matchedSpecs.length > 0
        ? ` → partial match: ${path.basename(m.matchedSpecs[0].filePath)} (${Math.round(m.normalizedScore * 100)}% overlap)`
        : ' → no spec match';
    return `- ${status} [${tag}] ${m.page.navLabel} — ${stripBase(m.page.url)}${specNote}`;
  };

  const overflowNote =
    overflow > 0
      ? `\n\n_(${overflow} additional lower-priority gap(s) omitted — focus on the above first)_`
      : '';

  const gapSection = capped.map(buildPageLine).join('\n') + overflowNote;

  const coverageSummary =
    `Total: ${prioritised.length} pages | ` +
    `✅ Well covered: ${wellCovered.length} | ` +
    `⚠️ Partial: ${partial.length} | ` +
    `🔴 Uncovered: ${uncovered.length}`;

  if (partial.length === 0 && uncovered.length === 0) {
    console.log(`\n✅ ${coverageSummary} — full coverage detected, no gaps to report.`);
    return;
  }

  const userMessage =
    `## Coverage Summary (pre-computed locally)\n${coverageSummary}\n\n` +
    `## Gaps requiring prioritisation (top ${capped.length} of ${prioritizedGaps.length} by risk)\n` +
    gapSection;

  console.error('Asking Claude to prioritise coverage gaps...\n');

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

  const fullText = await streamToStdout(stream, '', {
    pages_total: prioritised.length,
    well_covered: wellCovered.length,
    partial: partial.length,
    uncovered: uncovered.length,
    sent_to_claude: capped.length,
  });

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
