/**
 * Visual Regression Agent
 *
 * Captures screenshots of key Parabank pages and compares them to stored baselines.
 * A fast MD5 hash check runs first — pixel-identical screenshots produce zero Claude
 * API calls. Only changed pages are sent to Claude Vision, which classifies each diff:
 *
 *   - No significant change   (pixel noise, sub-pixel font rendering differences)
 *   - Intentional redesign    (layout or branding change — needs baseline update)
 *   - Broken layout           (overlapping elements, misalignment, clipped content)
 *   - Missing element         (button, field, or section has disappeared)
 *   - Text / content change   (wrong value displayed, copy regression)
 *
 * Baseline images are stored in tests/visual-baselines/. Use --update-baseline to
 * approve current state as the new baseline after an intentional design change.
 *
 * Model: claude-sonnet-4-6 (vision) — image comparison and classification.
 * No thinking needed — classification is perceptual, not multi-step reasoning.
 * Claude API is only called when a screenshot differs from its baseline.
 *
 * Usage:
 *   npx tsx tests/agents/visualRegressionAgent.ts --update-baseline
 *   npx tsx tests/agents/visualRegressionAgent.ts
 *   npx tsx tests/agents/visualRegressionAgent.ts --auth admin admin123
 *   npx tsx tests/agents/visualRegressionAgent.ts --page login --page registration
 *   npx tsx tests/agents/visualRegressionAgent.ts --output visual-report.md
 */

import Anthropic from '@anthropic-ai/sdk';
import { chromium } from 'playwright';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { streamToStdout } from './lib/streamUtils.js';

const client = new Anthropic();
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000/parabank/';
const BASELINE_DIR = 'tests/visual-baselines';
// 960×540 stays above all common responsive breakpoints (640px, 768px, 1024px edge)
// while reducing Claude Vision tile cost by ~33% vs 1280×720 (4 tiles vs 6 tiles).
// Claude Vision tiles are 512×512px. Tile counts: ⌈960/512⌉×⌈540/512⌉ = 2×2 = 4 tiles
// vs ⌈1280/512⌉×⌈720/512⌉ = 3×2 = 6 tiles. Each tile ≈ 340 tokens: saves ~680 tokens
// per comparison (2 images × 1 fewer tile pair), or ~6K tokens across a full 9-page run.
const VIEWPORT = { width: 960, height: 540 };

// ── System prompt (cached) ──────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a visual QA engineer performing screenshot comparison for Parabank — a Java web banking application.

You will receive two screenshots of the same page:
- Image 1: the baseline (previously approved state)
- Image 2: the current state

Analyse the visual differences and classify the change:

**No significant change** — minor pixel-level differences only (sub-pixel rendering, anti-aliasing, font hinting). No action needed.

**Intentional redesign** — deliberate layout, colour, or branding changes that appear purposeful and consistent. Recommend updating the baseline.

**Broken layout** — elements are overlapping, clipped, misaligned, or the page structure has collapsed. This is a regression that must be fixed.

**Missing element** — a button, form field, navigation link, section heading, or other UI component present in the baseline is absent in the current screenshot.

**Text / content change** — labels, values, error messages, or copy differ between the screenshots in a way that looks unintentional.

Response format:

**Classification**: [No significant change | Intentional redesign | Broken layout | Missing element | Text / content change]
**Confidence**: [High | Medium | Low]
**Differences observed**: Describe each visible difference concisely (bullet list).
**Recommendation**: One sentence — what the team should do next.`;

// ── Page definitions ──────────────────────────────────────────────────────────

interface PageDef {
  name: string;
  slug: string;
  path: string;
  requiresAuth: boolean;
}

const ALL_PAGES: PageDef[] = [
  { name: 'Home / Login',    slug: 'home',         path: '',               requiresAuth: false },
  { name: 'Registration',    slug: 'registration', path: 'register.htm',   requiresAuth: false },
  { name: 'About',           slug: 'about',        path: 'about.htm',      requiresAuth: false },
  { name: 'Contact',         slug: 'contact',      path: 'contact.htm',    requiresAuth: false },
  { name: 'Account Overview',slug: 'overview',     path: 'overview.htm',   requiresAuth: true },
  { name: 'Transfer Funds',  slug: 'transfer',     path: 'transfer.htm',   requiresAuth: true },
  { name: 'Open Account',    slug: 'openaccount',  path: 'openaccount.htm',requiresAuth: true },
  { name: 'Find Transactions',slug: 'findtrans',   path: 'findtrans.htm',  requiresAuth: true },
  { name: 'Request Loan',    slug: 'requestloan',  path: 'requestloan.htm',requiresAuth: true },
];

// ── Utilities ─────────────────────────────────────────────────────────────────

function md5(buf: Buffer): string {
  return crypto.createHash('md5').update(buf).digest('hex');
}

function baselinePath(slug: string): string {
  return path.join(BASELINE_DIR, `${slug}.png`);
}

// ── Visual comparison via Claude Vision ───────────────────────────────────────

interface ComparisonResult {
  page: string;
  slug: string;
  status: 'new-baseline' | 'identical' | 'changed' | 'error';
  classification?: string;
  confidence?: string;
  differences?: string;
  recommendation?: string;
  errorMessage?: string;
}

async function compareWithClaude(
  pageName: string,
  baselineBuffer: Buffer,
  currentBuffer: Buffer,
): Promise<{ classification: string; confidence: string; differences: string; recommendation: string }> {
  const baselineB64 = baselineBuffer.toString('base64');
  const currentB64 = currentBuffer.toString('base64');

  // Stream the response so the user sees output in real time rather than waiting
  // for the full vision response to complete (which can take several seconds).
  const stream = await client.messages.stream({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{
      role: 'user',
      content: [
        {
          type: 'text',
          text: `Page: ${pageName}\n\nImage 1 (baseline):`,
        },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: baselineB64 },
        },
        {
          type: 'text',
          text: 'Image 2 (current):',
        },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: currentB64 },
        },
        {
          type: 'text',
          text: 'Compare these screenshots and classify the visual change.',
        },
      ],
    }],
  });

  const text = await streamToStdout(stream, '  ');

  const extract = (label: string): string => {
    const m = text.match(new RegExp(`\\*\\*${label}\\*\\*:?\\s*(.+)`));
    return m ? m[1].trim() : 'unknown';
  };

  return {
    classification: extract('Classification'),
    confidence: extract('Confidence'),
    differences: text,
    recommendation: extract('Recommendation'),
  };
}

// ── Page screenshot capture ───────────────────────────────────────────────────

async function captureScreenshot(
  page: import('playwright').Page,
  url: string,
): Promise<Buffer> {
  await page.goto(url, { waitUntil: 'networkidle' });
  // Freeze all CSS animations and transitions so screenshots are pixel-stable
  // across runs regardless of animation timing. This prevents false positives from
  // spinner states, hover transitions, or animated banners mid-frame.
  await page.addStyleTag({
    content: '*, *::before, *::after { animation-duration: 0s !important; animation-delay: 0s !important; transition-duration: 0s !important; transition-delay: 0s !important; }',
  });
  return await page.screenshot({ fullPage: false, type: 'png' });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function runVisualRegression(
  updateBaseline: boolean,
  acceptIntentional: boolean,
  selectedSlugs: string[],
  auth: { username: string; password: string } | undefined,
  outputPath: string | null,
): Promise<void> {
  fs.mkdirSync(BASELINE_DIR, { recursive: true });

  const pages = selectedSlugs.length > 0
    ? ALL_PAGES.filter((p) => selectedSlugs.includes(p.slug))
    : ALL_PAGES;

  if (pages.length === 0) {
    console.error(`No pages matched. Available slugs: ${ALL_PAGES.map((p) => p.slug).join(', ')}`);
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  const results: ComparisonResult[] = [];

  try {
    if (auth) {
      console.error('Logging in...');
      await page.goto(new URL('login.htm', BASE_URL).href);
      await page.getByPlaceholder('Username').fill(auth.username);
      await page.getByPlaceholder('Password').fill(auth.password);
      await page.getByRole('button', { name: 'Log In' }).click();
      await page.waitForLoadState('networkidle');
      console.error('  ✓ Logged in\n');
    }

    for (const def of pages) {
      if (def.requiresAuth && !auth) {
        console.error(`  — ${def.name} (skipped — requires --auth)`);
        results.push({ page: def.name, slug: def.slug, status: 'error', errorMessage: 'requires --auth' });
        continue;
      }

      process.stderr.write(`  ${def.name}... `);
      const url = new URL(def.path, BASE_URL).href;
      const bPath = baselinePath(def.slug);

      let currentBuffer: Buffer;
      try {
        // Use a fresh page for each capture to avoid state bleed between pages
        const capturePage = await context.newPage();
        currentBuffer = await captureScreenshot(capturePage, url);
        await capturePage.close();
      } catch (err) {
        console.error(`✗ capture failed: ${(err as Error).message}`);
        results.push({ page: def.name, slug: def.slug, status: 'error', errorMessage: (err as Error).message });
        continue;
      }

      // Update baseline mode: always save current as baseline
      if (updateBaseline) {
        fs.writeFileSync(bPath, currentBuffer);
        console.error('✓ baseline updated');
        results.push({ page: def.name, slug: def.slug, status: 'new-baseline' });
        continue;
      }

      // No baseline exists: save current as baseline
      if (!fs.existsSync(bPath)) {
        fs.writeFileSync(bPath, currentBuffer);
        console.error('✓ baseline captured (first run)');
        results.push({ page: def.name, slug: def.slug, status: 'new-baseline' });
        continue;
      }

      // Baseline exists: compare
      const baselineBuffer = fs.readFileSync(bPath);
      if (md5(baselineBuffer) === md5(currentBuffer)) {
        console.error('✓ identical');
        results.push({ page: def.name, slug: def.slug, status: 'identical' });
        continue;
      }

      // Hashes differ — send both images to Claude Vision (streamed to stdout).
      // Print a header to stdout before streaming so the user sees which page is
      // being analysed while waiting for the first token to arrive.
      // The streamed content already contains the classification — no redundant
      // echo afterward. The icon on stderr provides a one-character CI status line.
      console.error('changed → analysing...');
      console.log(`\n── ${def.name} ${'─'.repeat(Math.max(0, 60 - def.name.length))}`);
      try {
        const { classification, confidence, differences, recommendation } =
          await compareWithClaude(def.name, baselineBuffer, currentBuffer);
        const isIntentional = classification.toLowerCase().includes('intentional');
        const isNoise = classification.toLowerCase().includes('no significant');
        const icon = isNoise ? '✓' : isIntentional ? '⚠' : '✗';
        // One-line stderr verdict — needed for the summary section and breakages loop.
        console.error(`  ${icon} ${classification}`);

        // Auto-promote baseline when --accept-intentional is set and Claude agrees
        // the change is deliberate. Avoids manual --update-baseline runs after design updates.
        if (acceptIntentional && isIntentional) {
          fs.writeFileSync(bPath, currentBuffer);
          console.error('    → Baseline updated (intentional change accepted)');
        }

        results.push({ page: def.name, slug: def.slug, status: 'changed', classification, confidence, differences, recommendation });
      } catch (err) {
        console.error(`✗ vision error: ${(err as Error).message}`);
        results.push({ page: def.name, slug: def.slug, status: 'error', errorMessage: (err as Error).message });
      }
    }
  } finally {
    await context.close().catch(() => null);
    await browser.close().catch(() => null);
  }

  // ── Summary report ────────────────────────────────────────────────────────

  const newBaselines = results.filter((r) => r.status === 'new-baseline').length;
  const identical = results.filter((r) => r.status === 'identical').length;
  const changed = results.filter((r) => r.status === 'changed');
  const errors = results.filter((r) => r.status === 'error').length;

  console.error(`\n── Visual Regression Summary ─────────────────────────────────────────`);
  console.error(`  ${identical} identical, ${newBaselines} new baseline(s), ${changed.length} changed, ${errors} error(s)\n`);

  const breakages = changed.filter((r) =>
    !r.classification?.toLowerCase().includes('no significant') &&
    !r.classification?.toLowerCase().includes('intentional'),
  );

  if (breakages.length > 0) {
    console.error('  ✗ Potential regressions:');
    for (const r of breakages) {
      console.error(`    ${r.page}: ${r.classification} (${r.confidence} confidence)`);
      console.error(`    → ${r.recommendation}`);
    }
  }

  const intentional = changed.filter((r) => r.classification?.toLowerCase().includes('intentional'));
  if (intentional.length > 0) {
    console.error(`\n  ⚠ ${intentional.length} page(s) have intentional changes — run with --update-baseline to accept:`);
    for (const r of intentional) console.error(`    ${r.page}`);
  }

  if (outputPath) {
    const lines: string[] = [
      `# Visual Regression Report — Parabank`,
      `_Generated: ${new Date().toISOString()}_`,
      `_Viewport: ${VIEWPORT.width}×${VIEWPORT.height} | Generated: ${new Date().toISOString()}_\n`,
      `## Summary`,
      `- Identical: ${identical}`,
      `- New baselines: ${newBaselines}`,
      `- Changed: ${changed.length}`,
      `- Errors: ${errors}`,
      '',
    ];

    for (const r of changed) {
      lines.push(`## ${r.page}`);
      lines.push(`**Classification**: ${r.classification}`);
      lines.push(`**Confidence**: ${r.confidence}`);
      lines.push('');
      lines.push(r.differences ?? '');
      lines.push('');
    }

    fs.writeFileSync(outputPath, lines.join('\n'), 'utf-8');
    console.error(`\n✓ Report saved to: ${outputPath}`);
  }

  // Exit non-zero if regressions found
  if (breakages.length > 0) process.exit(1);
}

// ── Entry point ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes('--help')) {
  console.error(
    'Usage:\n' +
    '  npx tsx tests/agents/visualRegressionAgent.ts --update-baseline\n' +
    '  npx tsx tests/agents/visualRegressionAgent.ts\n' +
    '  npx tsx tests/agents/visualRegressionAgent.ts --auth admin admin123\n' +
    '  npx tsx tests/agents/visualRegressionAgent.ts --accept-intentional\n' +
    '  npx tsx tests/agents/visualRegressionAgent.ts --page login --page registration\n' +
    '  npx tsx tests/agents/visualRegressionAgent.ts --output visual-report.md\n' +
    `\nAvailable page slugs: ${ALL_PAGES.map((p) => p.slug).join(', ')}`,
  );
  process.exit(0);
}

const authFlag = args.indexOf('--auth');
const outputFlag = args.indexOf('--output');

// Collect all --page values
const selectedSlugs: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--page' && args[i + 1]) {
    selectedSlugs.push(args[i + 1]);
    i++;
  }
}

const updateBaseline = args.includes('--update-baseline');
const acceptIntentional = args.includes('--accept-intentional');
const auth = authFlag !== -1
  ? { username: args[authFlag + 1], password: args[authFlag + 2] }
  : undefined;
const outputPath = outputFlag !== -1 ? args[outputFlag + 1] : null;

runVisualRegression(updateBaseline, acceptIntentional, selectedSlugs, auth, outputPath).catch((err: Error) => {
  console.error('Visual regression agent error:', err.message);
  process.exit(1);
});
