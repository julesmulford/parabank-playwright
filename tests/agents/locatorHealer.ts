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

const SYSTEM_PROMPT = `You are a Playwright locator expert auditing constructor locator assignments in a TypeScript page object.

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
- Preserve indentation exactly — "original" is a literal string match

Output ONLY a JSON block — no prose before or after:
\`\`\`json
{
  "replacements": [
    {
      "original": "    this.usernameInput = this.page.locator('[id=\\"customer.username\\"]');",
      "replacement": "    this.usernameInput = this.page.getByLabel('Username');",
      "reason": "Label element present in HTML — getByLabel is more resilient than id selector"
    }
  ]
}
\`\`\`

If all locators are already optimal, output exactly: \`\`\`json\n{ "replacements": [] }\n\`\`\`

Critical: "original" must match the source character-for-character including indentation.`;

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

// ── Locator section extractor ───────────────────────────────────────────────

/**
 * Extracts only the parts of a page object that are relevant to a locator audit:
 * the readonly Locator declarations and the constructor body (which contains all
 * this.xxx = this.page.getBy*() assignments).
 *
 * Sending only this extract instead of the full file reduces input tokens by
 * 60-80% on typical page objects — method implementations have no bearing on
 * whether a locator is the right tier choice.
 */
function extractLocatorSection(src: string, filePath: string): string {
  const lines = src.split('\n');
  const locatorDecls: string[] = [];
  const constructorLines: string[] = [];
  let inConstructor = false;
  let braceDepth = 0;

  for (const line of lines) {
    // Collect readonly Locator property declarations (class level)
    if (/\breadonly\b/.test(line) && /\bLocator\b/.test(line)) {
      locatorDecls.push(line);
    }
    // Detect constructor start
    if (/\bconstructor\s*\(/.test(line)) {
      inConstructor = true;
      braceDepth = 0;
    }
    if (inConstructor) {
      constructorLines.push(line);
      braceDepth += (line.match(/\{/g) ?? []).length;
      braceDepth -= (line.match(/\}/g) ?? []).length;
      // Constructor ends when brace depth returns to 0 (after at least one line)
      if (braceDepth <= 0 && constructorLines.length > 1) {
        inConstructor = false;
      }
    }
  }

  // If extraction found nothing (e.g. non-standard structure), fall through to full src
  if (locatorDecls.length === 0 && constructorLines.length === 0) return src;

  const parts: string[] = [`// ${filePath} — locator extract`];
  if (locatorDecls.length > 0) {
    parts.push('// Locator property declarations:', ...locatorDecls);
  }
  if (constructorLines.length > 0) {
    parts.push('', ...constructorLines);
  }
  return parts.join('\n');
}

// ── Targeted HTML filter ────────────────────────────────────────────────────

/**
 * Filters the extracted interactive HTML to only elements relevant to the current
 * locator assignments. Sends Claude a focused subset instead of all interactive
 * elements on the page.
 *
 * Strategy:
 *   1. Extract all string arguments from getBy* and locator('[id=...']') calls in the extract
 *   2. Keep HTML lines/blocks that contain at least one of those string values
 *   3. Always keep <form>/<label>/<fieldset> tags for structural context
 *   4. Fall back to full HTML if filtering removes everything
 *
 * Deliberately does NOT keep all standalone interactive elements — those that share
 * no string overlap with existing locators add tokens without aiding the audit.
 */
function filterHtmlToLocatorContext(html: string, locatorExtract: string): string {
  // Collect all string values used in the current locator assignments
  const usedValues = new Set<string>();
  for (const [, v] of locatorExtract.matchAll(/['"]([^'"]{2,60})['"]/g)) {
    // Exclude very short or very generic strings that would match too broadly
    if (v.length >= 3 && !/^(true|false|null|undefined|\d+)$/i.test(v)) {
      usedValues.add(v.toLowerCase());
    }
  }

  if (usedValues.size === 0) return html;

  const lines = html.split('\n');
  const kept: string[] = [];

  for (const line of lines) {
    const lower = line.toLowerCase();
    // Always keep form/label/fieldset wrappers — they provide the structural context
    // Claude needs to reason about label-for associations and field groupings
    if (/^<\/?( form|label|fieldset)/i.test(' ' + line.trim())) {
      kept.push(line);
      continue;
    }
    // Keep any line that mentions a value used in the current locator assignments
    if ([...usedValues].some((v) => lower.includes(v))) {
      kept.push(line);
    }
    // Standalone interactive elements NOT matching existing locators are omitted:
    // they are not candidates for improving CURRENT locators and inflate token count.
  }

  const filtered = kept.join('\n').trim();
  return filtered.length > 50 ? filtered : html; // fallback if filter was too aggressive
}

// ── Local preclassification ─────────────────────────────────────────────────

/**
 * Attempts deterministic rule-based locator upgrades without calling Claude.
 *
 * Rules applied (in priority order):
 *   R1: locator('[id="X"]') + <label for="X">text → getByLabel('text')
 *   R2: locator('[id="X"]') + <input placeholder="…"> → getByPlaceholder('…')
 *   R3: getByText('text') where HTML has <button>…text → getByRole('button', { name })
 *   R4: locator('[data-testid="X"]') → getByTestId('X')
 *   R5: locator('[id="X"]') where input has no label but has placeholder → getByPlaceholder
 *
 * Returns { replacements, allHandled }:
 *   - replacements: rule-generated Replacement objects (already validated)
 *   - allHandled: true when every sub-optimal locator was covered — caller skips Claude
 */
function preclassifyLocators(
  locatorExtract: string,
  html: string,
): { replacements: Replacement[]; allHandled: boolean } {
  // Sub-optimal tiers: locator('[id=...]'), locator('[data-testid=...]'), getByText
  const subOptimalRe =
    /^( {0,8}this\.\w+\s*=\s*this\.page\.(?:locator\s*\(\s*['"][^'"]*(?:\[id=|\[data-testid=)|getByText\s*\()[^\n;]+;)/gm;
  const subOptimal = [...locatorExtract.matchAll(subOptimalRe)].map(([line]) => line);

  if (subOptimal.length === 0) return { replacements: [], allHandled: true };

  const replacements: Replacement[] = [];
  let unhandledCount = 0;

  for (const line of subOptimal) {
    // R4: locator('[data-testid="X"]') → getByTestId('X') — no HTML needed
    const testidMatch = line.match(/locator\s*\(\s*['"][^'"]*\[data-testid=["']?([^"'\]]+)["']?\]['"]\s*\)/);
    if (testidMatch) {
      const testid = testidMatch[1];
      const replacement = line.replace(
        /this\.page\.locator\s*\(\s*['"][^'"]*\[data-testid=["']?[^"'\]]+["']?\]['"]\s*\)/,
        `this.page.getByTestId('${testid}')`,
      );
      replacements.push({ original: line, replacement, reason: `data-testid="${testid}" → getByTestId (semantic, no HTML scan needed)` });
      continue;
    }

    // For id-based selectors, need HTML to know which upgrade applies
    const idMatch = line.match(/locator\s*\(\s*['"][^'"]*\[id=["']?([^"'\]]+)["']?\]['"]\s*\)/);
    if (idMatch) {
      const fieldId = idMatch[1];

      // R1: <label for="fieldId">text</label> → getByLabel('text')
      if (html) {
        const labelRe = new RegExp(`<label[^>]*\\bfor=["']?${fieldId}["']?[^>]*>([^<]+)<`, 'i');
        const labelMatch = html.match(labelRe);
        if (labelMatch) {
          const labelText = labelMatch[1].trim();
          const replacement = line.replace(
            /this\.page\.locator\s*\(\s*['"][^'"]*\[id=["']?[^"'\]]+["']?\]['"]\s*\)/,
            `this.page.getByLabel('${labelText}')`,
          );
          replacements.push({
            original: line, replacement,
            reason: `Label "${labelText}" found for id="${fieldId}" — getByLabel is more resilient`,
          });
          continue;
        }

        // R2 / R5: <input id="fieldId" placeholder="…"> → getByPlaceholder('…')
        const inputRe = new RegExp(`<input[^>]*\\bid=["']?${fieldId}["']?[^>]*placeholder=["']([^"']+)["']`, 'i');
        const inputRevRe = new RegExp(`<input[^>]*placeholder=["']([^"']+)["'][^>]*\\bid=["']?${fieldId}["']?`, 'i');
        const placeholderMatch = html.match(inputRe) ?? html.match(inputRevRe);
        if (placeholderMatch) {
          const placeholder = placeholderMatch[1].trim();
          const replacement = line.replace(
            /this\.page\.locator\s*\(\s*['"][^'"]*\[id=["']?[^"'\]]+["']?\]['"]\s*\)/,
            `this.page.getByPlaceholder('${placeholder}')`,
          );
          replacements.push({
            original: line, replacement,
            reason: `input id="${fieldId}" has placeholder="${placeholder}" — getByPlaceholder is more readable`,
          });
          continue;
        }
      }
    }

    // R3: getByText('text') + <button> in HTML → getByRole('button', { name })
    const textMatch = line.match(/getByText\s*\(\s*['"]([^'"]+)['"]\s*\)/);
    if (textMatch && html) {
      const text = textMatch[1];
      const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`<button[^>]*>[^<]*${escaped}`, 'i').test(html)) {
        const replacement = line.replace(
          /this\.page\.getByText\s*\(\s*['"]([^'"]+)['"]\s*\)/,
          (_m, t: string) => `this.page.getByRole('button', { name: '${t}' })`,
        );
        replacements.push({
          original: line, replacement,
          reason: `"${text}" is a <button> — getByRole('button') is more resilient than getByText`,
        });
        continue;
      }
    }

    // No rule matched — Claude required for this locator
    unhandledCount++;
  }

  return { replacements, allHandled: unhandledCount === 0 };
}

// ── Replacement validation ──────────────────────────────────────────────────

const ALLOWED_SELECTOR_FAMILIES = [
  'getByRole', 'getByLabel', 'getByTestId', 'getByText', 'getByPlaceholder',
  "locator('[id=", 'locator("[id=',
];

interface Replacement {
  original: string;
  replacement: string;
  reason: string;
}

/**
 * Validates a set of replacements before application:
 *   - Rejects no-ops (original === replacement after trimming)
 *   - Rejects duplicates (same original appearing twice)
 *   - Rejects suggestions that don't use an allowed selector family
 *
 * Returns the filtered list and logs any rejections.
 */
function validateReplacements(replacements: Replacement[]): Replacement[] {
  const seenOriginals = new Set<string>();
  const valid: Replacement[] = [];

  for (const r of replacements) {
    const originalTrimmed = r.original.trim();
    const replacementTrimmed = r.replacement.trim();

    if (originalTrimmed === replacementTrimmed) {
      console.warn(`  ⚠ Skipping no-op replacement: ${originalTrimmed.slice(0, 80)}`);
      continue;
    }
    if (seenOriginals.has(originalTrimmed)) {
      console.warn(`  ⚠ Skipping duplicate replacement for: ${originalTrimmed.slice(0, 80)}`);
      continue;
    }
    if (!ALLOWED_SELECTOR_FAMILIES.some((f) => replacementTrimmed.includes(f))) {
      console.warn(
        `  ⚠ Rejecting replacement — does not use an allowed selector family:\n` +
        `    ${replacementTrimmed.slice(0, 120)}`,
      );
      continue;
    }

    seenOriginals.add(originalTrimmed);
    valid.push(r);
  }

  return valid;
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

  // Send only the locator-relevant section (declarations + constructor) instead of the
  // full file. Method bodies are irrelevant to locator tier decisions and would double
  // the input token count on a typical page object.
  const locatorExtract = extractLocatorSection(originalSrc, pageObjectPath);

  // Filter HTML to only elements relevant to the current locator assignments.
  const filteredHtml = html ? filterHtmlToLocatorContext(html, locatorExtract) : '';

  // ── Stage 0: deterministic preclassification ──────────────────────────────
  // Apply rule-based upgrades (label-for, placeholder, testid, button-role) before
  // reaching for Claude. If every sub-optimal locator is handled by a rule, skip the
  // API call entirely — zero tokens spent, zero latency.
  const locatorCount = (originalSrc.match(/this\.page\./g) ?? []).length;
  const { replacements: localReplacements, allHandled } = preclassifyLocators(locatorExtract, filteredHtml || html);

  if (allHandled && localReplacements.length > 0) {
    console.error(`  ✓ All ${localReplacements.length} locator(s) upgraded locally (no Claude call)\n`);
    console.error(`\n  ${localReplacements.length} improvement(s) found (deterministic):`);
    for (const r of localReplacements) {
      console.error(`    - ${r.reason}`);
      console.error(`      was: ${r.original.trim()}`);
      console.error(`      now: ${r.replacement.trim()}`);
    }
    if (apply) {
      const valid = validateReplacements(localReplacements);
      let updated = originalSrc;
      let applied = 0;
      for (const r of valid) {
        if (updated.includes(r.original)) {
          updated = updated.replace(r.original, r.replacement);
          applied++;
        } else {
          console.warn(`  ⚠ Could not find exact match for: ${r.original.trim()}`);
        }
      }
      if (applied > 0) {
        printDiff(originalSrc, updated);
        fs.writeFileSync(pageObjectPath, updated, 'utf-8');
        console.error(`  ✓ Applied ${applied} deterministic change(s) to ${pageObjectPath}`);
      }
    }
    return;
  }

  if (allHandled && localReplacements.length === 0) {
    console.error('  ✓ All locators already optimal — no changes needed (no Claude call)');
    return;
  }

  // Some locators need Claude reasoning — proceed with API call for the remainder
  if (localReplacements.length > 0) {
    console.error(`  ℹ ${localReplacements.length} locator(s) upgraded locally; ${locatorCount - localReplacements.length} require Claude reasoning`);
  }

  const userMessage =
    `## Locator audit: ${pageObjectPath}\n` +
    '```typescript\n' +
    locatorExtract +
    '\n```\n\n' +
    (filteredHtml
      ? `## Page elements relevant to current locators\n\`\`\`html\n${filteredHtml}\n\`\`\``
      : '<!-- Live HTML unavailable — static analysis only -->');

  // Adaptive model selection:
  //   Live HTML + high locator count (≥8) → Opus+thinking.
  //   Everything else → Sonnet is sufficient.
  const useOpus = locatorCount >= 8 && html.length > 0;
  const model = useOpus ? 'claude-opus-4-6' : 'claude-sonnet-4-6';
  // Sonnet max_tokens reduced to 2500: JSON-only output with ~10-15 replacements
  // averages ~600-800 tokens. 2500 provides headroom without over-allocating.
  const maxTokens = useOpus ? 16000 : 2500;

  console.error(
    `  Asking ${useOpus ? 'Claude Opus (with thinking)' : 'Claude Sonnet'} to audit locators` +
    ` (${locatorCount} locator(s) found)...\n`,
  );

  const stream = await client.messages.stream({
    model,
    max_tokens: maxTokens,
    ...(useOpus ? { thinking: { type: 'enabled', budget_tokens: 5000 } } : {}),
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userMessage }],
  });

  const fullText = await streamToStdout(stream, '  ', {
    locators: locatorCount,
    html_present: filteredHtml.length > 0,
    model: useOpus ? 'opus' : 'sonnet',
    local_pre: localReplacements.length,
  });

  // Parse JSON and print a human-readable summary regardless of --apply.
  {
    const previewMatch = fullText.match(/```json\n([\s\S]*?)```/);
    if (previewMatch) {
      try {
        const { replacements } = JSON.parse(previewMatch[1]) as {
          replacements: Array<{ original: string; replacement: string; reason: string }>;
        };
        if (replacements.length === 0) {
          console.error('  ✓ All remaining locators are optimal — no further changes needed.');
        } else {
          console.error(`\n  ${replacements.length} improvement(s) found:`);
          for (const r of replacements) {
            console.error(`    - ${r.reason}`);
            console.error(`      was: ${r.original.trim()}`);
            console.error(`      now: ${r.replacement.trim()}`);
          }
        }
      } catch { /* JSON parse error surfaced below in the apply block */ }
    }
  }

  if (apply) {
    const jsonMatch = fullText.match(/```json\n([\s\S]*?)```/);
    if (!jsonMatch) {
      console.warn('  ⚠ Could not find JSON replacements block — nothing written.');
      return;
    }
    try {
      const { replacements: claudeReplacements } = JSON.parse(jsonMatch[1]) as {
        replacements: Array<{ original: string; replacement: string; reason: string }>;
      };

      // Merge local (preclassified) and Claude replacements — validate the combined set
      const allReplacements = [...localReplacements, ...claudeReplacements];
      if (allReplacements.length === 0) {
        console.error('  ✓ No changes required — file unchanged.');
        return;
      }
      const validReplacements = validateReplacements(allReplacements);
      if (validReplacements.length === 0) {
        console.warn('  ⚠ All replacements were rejected by validation — nothing written.');
        return;
      }
      let updated = originalSrc;
      let applied = 0;
      for (const r of validReplacements) {
        if (updated.includes(r.original)) {
          updated = updated.replace(r.original, r.replacement);
          applied++;
        } else {
          console.warn(`  ⚠ Could not find exact match for: ${r.original.trim()}`);
        }
      }
      if (applied > 0) {
        const changes = printDiff(originalSrc, updated);
        fs.writeFileSync(pageObjectPath, updated, 'utf-8');
        console.error(`  ✓ Applied ${changes} change(s) to ${pageObjectPath}`);
      } else {
        console.warn('  ⚠ No replacements applied — check the warnings above.');
      }
    } catch {
      console.warn('  ⚠ Could not parse JSON replacements — nothing written.');
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
