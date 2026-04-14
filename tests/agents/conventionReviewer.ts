/**
 * Convention Reviewer Agent
 *
 * Two-phase review of Playwright test files:
 *
 * Phase 1 — Static analysis (zero Claude calls, instant):
 *   Regex-based checks for the most common, unambiguous violations:
 *   - Wrong import source (not from fixtures)
 *   - page.waitForTimeout() usage
 *   - XPath selectors (//)
 *   - CSS class selectors (.someClass)
 *   - Assertions inside page object methods
 *   - Missing test.describe block
 *   - Hardcoded unique fields (static username/ssn strings)
 *   - nth-child / nth-of-type positional selectors
 *
 * Phase 2 — AI review (Claude Haiku — fast and cheap for rule-checking):
 *   Sends file content + static findings to Claude for subtler violations
 *   the regex can't catch: poor locator choices that technically pass rules
 *   but could be better, missing @smoke tags, test isolation issues, etc.
 *
 * Usage:
 *   npx tsx tests/agents/conventionReviewer.ts                          # review all test files
 *   npx tsx tests/agents/conventionReviewer.ts --files tests/ui/login.spec.ts
 *   npx tsx tests/agents/conventionReviewer.ts --files tests/ui/ tests/api/
 *   npx tsx tests/agents/conventionReviewer.ts --files tests/ui/login.spec.ts --output review.md
 *   npx tsx tests/agents/conventionReviewer.ts --staged                 # git staged only
 *   npx tsx tests/agents/conventionReviewer.ts --staged --skip-ai       # static analysis only (instant, free)
 *   npx tsx tests/agents/conventionReviewer.ts --files tests/ui/ --force-ai  # deep AI review even if static is clean
 */

import Anthropic from '@anthropic-ai/sdk';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { streamToStdout } from './lib/streamUtils.js';

const client = new Anthropic();

// ── System prompt (cached) ──────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a senior Playwright automation engineer performing a code review.
Your role is to catch convention violations that static analysis misses.

Project conventions (from CLAUDE.md):
1. Import { test, expect } from '../fixtures/fixtures' — NEVER from @playwright/test in UI/a11y/performance tests
2. API tests may import from @playwright/test directly
3. Page object methods must be actions only — no expect() calls inside tests/pages/ files
4. Never use page.waitForTimeout() — use expect(locator).toBeVisible()
5. Locator priority: getByRole → getByLabel → getByTestId → getByText/getByPlaceholder → locator('[id="..."]')
6. Never use XPath (//), CSS class selectors (.className), nth-child, nth-of-type
7. Never hardcode usernames, SSNs, or other unique data — use factories with Date.now() or randomUUID()
8. Wrap tests in test.describe blocks
9. Tag happy-path / smoke tests with @smoke in the test title
10. New page objects must be registered in tests/fixtures/fixtures.ts
11. No page object should be imported directly in a spec — always via the fixture

Review the provided file(s) and the static analysis findings already reported.
Focus on violations that static analysis MISSED — avoid repeating what was already flagged.

For each issue found, output:
**[SEVERITY] Rule N violated** — <file>:<line>
> <quote the exact offending code>
Fix: <one concrete action>

Severity levels: CRITICAL (will cause test failures) | MAJOR (breaks conventions) | MINOR (style/best-practice)

If no additional issues are found beyond the static analysis, say: "✅ No further violations found."`;

// ── Static analysis rules ───────────────────────────────────────────────────

interface Violation {
  file: string;
  line: number;
  rule: string;
  severity: 'CRITICAL' | 'MAJOR' | 'MINOR';
  code: string;
  fix: string;
}

const STATIC_RULES: Array<{
  pattern: RegExp;
  rule: string;
  severity: 'CRITICAL' | 'MAJOR' | 'MINOR';
  fix: string;
  skipFor?: (filePath: string) => boolean;
}> = [
  {
    pattern: /from\s+['"]@playwright\/test['"]/,
    rule: 'Wrong import source — use fixtures wrapper',
    severity: 'CRITICAL',
    fix: "Change to: import { test, expect } from '../fixtures/fixtures'",
    skipFor: (f) => f.includes('tests/api/') || f.includes('tests/agents/'),
  },
  {
    pattern: /page\.waitForTimeout\s*\(/,
    rule: 'waitForTimeout usage — replace with Playwright auto-wait',
    severity: 'CRITICAL',
    fix: "Use expect(locator).toBeVisible() or await page.waitForLoadState() instead",
  },
  {
    pattern: /locator\s*\(\s*['"`]\/\//,
    rule: 'XPath selector — forbidden by convention',
    severity: 'MAJOR',
    fix: 'Use getByRole, getByLabel, getByTestId, or getByText instead',
  },
  {
    // Matches selectors that START with a CSS class (.btn-primary) or have an element.class
    // pattern (div.form-control). The old regex `/[^'"]+\.[a-z]/` was too broad and
    // false-positived on attribute selectors like `[id="customer.firstName"]` where the dot
    // is inside a quoted attribute value, not a CSS class combinator.
    pattern: /locator\s*\(\s*['"`](?:[a-z][a-z0-9]*)?\.(?:[a-z][-a-z0-9_]+)/,
    rule: 'CSS class selector — forbidden by convention',
    severity: 'MAJOR',
    fix: 'Use semantic selectors (getByRole, getByLabel) instead of CSS class names',
  },
  {
    pattern: /nth-(?:child|of-type)/,
    rule: 'Positional selector — brittle and forbidden',
    severity: 'MAJOR',
    fix: 'Use getByRole with a name, or add a data-testid attribute to the element',
  },
  {
    pattern: /\bexpect\s*\(/,
    rule: 'Assertion inside page object — actions only in tests/pages/',
    severity: 'CRITICAL',
    fix: 'Move assertion to the spec file; page object methods must be pure actions',
    skipFor: (f) => !f.includes('tests/pages/'),
  },
  {
    pattern: /username\s*[:=]\s*['"`][a-zA-Z][a-zA-Z0-9_]+['"`]/,
    rule: 'Hardcoded username — will cause collisions in parallel runs',
    severity: 'MAJOR',
    fix: 'Use a factory: buildCustomer() or `testuser_${Date.now()}`',
    skipFor: (f) => f.includes('tests/agents/'),
  },
  {
    pattern: /\bssn\s*[:=]\s*['"`]\d+['"`]/,
    rule: 'Hardcoded SSN — use factories or Math.random()',
    severity: 'MAJOR',
    fix: 'Use: String(Math.floor(100000000 + Math.random() * 900000000))',
    skipFor: (f) => f.includes('tests/agents/'),
  },
  {
    // Spec files must access page objects through the fixture, not via direct import.
    // Direct imports bypass the fixture lifecycle (beforeEach setup, proper page injection).
    pattern: /from\s+['"].*\/pages\//,
    rule: 'Direct page object import in spec — use fixture instead',
    severity: 'CRITICAL',
    fix: "Remove the direct import; access the page object via the test fixture parameter (e.g. async ({ loginPage }) => { ... })",
    skipFor: (f) => !f.endsWith('.spec.ts'),
  },
  {
    // test.only / describe.only left in code ships a partially-run suite to CI.
    // Every other test is silently skipped — CI appears green but coverage collapses.
    pattern: /\btest\.only\s*\(|describe\.only\s*\(/,
    rule: 'test.only / describe.only left in code — skips all other tests in CI',
    severity: 'CRITICAL',
    fix: 'Remove .only — use --grep or pass the file path to run focused tests',
  },
  {
    // page.pause() opens the Playwright Inspector and suspends the test indefinitely,
    // waiting for the user to press Resume. In CI there is no user — the job hangs
    // until the pipeline timeout kills it, burning CI minutes and blocking the queue.
    pattern: /\bpage\.pause\s*\(/,
    rule: 'page.pause() left in code — suspends CI indefinitely (no user to resume)',
    severity: 'CRITICAL',
    fix: 'Remove page.pause() — use --debug flag at the CLI level for interactive debugging',
  },
  {
    // page.$eval, page.$$eval, page.$, and page.$$ are all deprecated in Playwright.
    // They silently continue to work until removed, then break without clear guidance.
    pattern: /\bpage\.\$\$?eval\s*\(|\bpage\.\$\$?\s*\(/,
    rule: 'Deprecated Playwright API — page.$eval / page.$$eval / page.$ / page.$$',
    severity: 'MAJOR',
    fix: 'Replace with page.locator().evaluate() or locator.evaluateAll()',
  },
];

function staticAnalyse(filePath: string): Violation[] {
  const violations: Violation[] = [];
  if (!fs.existsSync(filePath)) return violations;

  const src = fs.readFileSync(filePath, 'utf-8');
  const lines = src.split('\n');

  for (const rule of STATIC_RULES) {
    if (rule.skipFor?.(filePath)) continue;
    lines.forEach((line, idx) => {
      // Skip comment lines — a commented-out waitForTimeout or XPath is not a live violation.
      // Avoids false positives on // TODO: remove page.waitForTimeout() or * @example //-style docs.
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
      if (rule.pattern.test(line)) {
        violations.push({
          file: filePath,
          line: idx + 1,
          rule: rule.rule,
          severity: rule.severity,
          code: trimmed,
          fix: rule.fix,
        });
      }
    });
  }

  // Spec files must have a test.describe block
  if (filePath.endsWith('.spec.ts') && !src.includes('test.describe')) {
    violations.push({
      file: filePath,
      line: 1,
      rule: 'Missing test.describe block',
      severity: 'MINOR',
      code: '(no describe block found)',
      fix: 'Wrap all tests in: test.describe("Feature name", () => { ... })',
    });
  }

  return violations;
}

function formatStaticViolations(violations: Violation[]): string {
  if (violations.length === 0) return '✅ Static analysis: no violations found.';
  return violations
    .map(
      (v) =>
        `[${v.severity}] ${v.rule} — ${v.file}:${v.line}\n` +
        `  > ${v.code}\n` +
        `  Fix: ${v.fix}`,
    )
    .join('\n\n');
}

// ── Context window extractor ──────────────────────────────────────────────────

/**
 * Extracts only the lines around each violation rather than sending entire file
 * content to the AI. Reduces token cost by 60–80% on typical spec files while
 * preserving enough context for Claude to spot subtler issues nearby.
 *
 * For files with no static violations (--force-ai path), falls back to the
 * first 50 lines as a representative structural sample.
 */
function extractContextWindows(src: string, violationLines: number[], context = 15): string {
  const lines = src.split('\n');

  if (violationLines.length === 0) {
    const sample = lines.slice(0, 50).map((l, i) => `${i + 1}: ${l}`).join('\n');
    return lines.length > 50
      ? `${sample}\n// ... (${lines.length - 50} more lines not shown)`
      : sample;
  }

  // Build windows and merge overlapping ranges so adjacent violations share context
  const windows: Array<[number, number]> = violationLines
    .map((l) => [Math.max(0, l - 1 - context), Math.min(lines.length, l + context)] as [number, number])
    .sort((a, b) => a[0] - b[0]);

  const merged: Array<[number, number]> = [];
  for (const [s, e] of windows) {
    if (merged.length === 0 || merged[merged.length - 1][1] < s) merged.push([s, e]);
    else merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], e);
  }

  return merged
    .map(([s, e]) => {
      const snippet = lines.slice(s, e).map((l, i) => `${s + i + 1}: ${l}`).join('\n');
      return `// Lines ${s + 1}–${e}\n${snippet}`;
    })
    .join('\n// ...\n');
}

// ── File resolver ────────────────────────────────────────────────────────────

function resolveFiles(targets: string[]): string[] {
  const files: string[] = [];

  const walkDir = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkDir(full); // recurse so tests/ui/flows/ and similar are included
      } else if (entry.name.endsWith('.ts')) {
        files.push(full);
      }
    }
  };

  for (const target of targets) {
    if (!fs.existsSync(target)) continue;
    if (fs.statSync(target).isDirectory()) {
      walkDir(target);
    } else {
      files.push(target);
    }
  }
  return [...new Set(files)];
}

function getStagedTypeScriptFiles(): string[] {
  try {
    const out = execSync('git diff --cached --name-only --diff-filter=ACMR', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return out
      .trim()
      .split('\n')
      .filter((f) => f.endsWith('.ts') && f.startsWith('tests/') && !f.startsWith('tests/agents/'));
  } catch {
    return [];
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function reviewConventions(
  files: string[],
  outputPath: string | null,
  skipAi: boolean,
  forceAi: boolean,
): Promise<void> {
  if (files.length === 0) {
    console.error('No TypeScript files to review.');
    process.exit(0);
  }

  console.error(`Reviewing ${files.length} file(s):\n${files.map((f) => `  ${f}`).join('\n')}\n`);

  // Phase 1: static analysis (always runs — zero Claude calls, instant)
  console.error('Phase 1: Static analysis...');
  const allViolations: Violation[] = [];
  for (const file of files) {
    allViolations.push(...staticAnalyse(file));
  }

  const staticReport = formatStaticViolations(allViolations);
  console.log('\n── Static Analysis ──────────────────────────────────────────────');
  console.log(staticReport);
  console.log('');

  const criticalCount = allViolations.filter((v) => v.severity === 'CRITICAL').length;
  const majorCount = allViolations.filter((v) => v.severity === 'MAJOR').length;
  const minorCount = allViolations.filter((v) => v.severity === 'MINOR').length;

  // Phase 2: AI review — skip when explicitly disabled or when there is no readable file content.
  // When static analysis is clean, skip AI by default (pass --force-ai to override).
  // Rationale: sending all files to Haiku on every clean run is expensive with low ROI —
  // the user can gate a deeper AI review to pre-merge or scheduled checks with --force-ai.
  const readableFiles = files.filter(fs.existsSync);
  let aiText = '';

  const isStaticClean = allViolations.length === 0;

  if (skipAi) {
    console.error('Phase 2: AI review skipped (--skip-ai).\n');
  } else if (readableFiles.length === 0) {
    console.error('Phase 2: AI review skipped — no readable files.\n');
  } else if (isStaticClean && !forceAi) {
    console.error(
      'Phase 2: AI review skipped — static analysis is clean.\n' +
      '  Pass --force-ai for a deep AI review even when no static violations are found.\n',
    );
  } else {
    console.error('Phase 2: AI review (Claude Haiku)...\n');

    // Focus the AI on files that static analysis flagged — those are most likely to have
    // subtler issues too. If nothing was flagged (--force-ai path), send all files
    // up to the file cap.
    const violationFiles = new Set(allViolations.map((v) => v.file));
    const candidates =
      violationFiles.size > 0
        ? readableFiles.filter((f) => violationFiles.has(f))
        : readableFiles;

    // Cap the total number of files sent to Claude — large projects with 50+ spec
    // files can exceed 400 KB in a single request. Prioritise flagged files (already
    // selected above); cap the rest at 20. Beyond 20 files, the marginal signal per
    // additional file is near-zero and token cost is linear.
    const FILE_LIMIT = 20;
    const filesToReview = candidates.slice(0, FILE_LIMIT);
    const omittedCount = candidates.length - filesToReview.length;

    // Send only context windows (30 lines) around each violation rather than full
    // file content. Reduces token cost by 60–80% vs the old 8 KB-per-file cap
    // while giving Claude enough context to identify related subtler issues.
    const fileSections = filesToReview
      .map((f) => {
        const src = fs.readFileSync(f, 'utf-8');
        const fileViolationLines = allViolations.filter((v) => v.file === f).map((v) => v.line);
        const content = extractContextWindows(src, fileViolationLines);
        return `### ${f}\n\`\`\`typescript\n${content}\n\`\`\``;
      })
      .join('\n\n');

    if (filesToReview.length < readableFiles.length) {
      const skippedClean = readableFiles.length - candidates.length;
      const skippedCap = omittedCount;
      const parts: string[] = [];
      if (skippedClean > 0) parts.push(`${skippedClean} clean file(s) skipped`);
      if (skippedCap > 0) parts.push(`${skippedCap} omitted — ${FILE_LIMIT}-file cap reached`);
      console.error(
        `  Reviewing ${filesToReview.length} file(s)` +
          (parts.length > 0 ? ` (${parts.join(', ')})` : '') + '.\n',
      );
    }

    const userMessage =
      `## Files under review\n${fileSections}\n\n` +
      `## Static analysis findings (already reported — do not repeat these)\n${staticReport}`;

    const stream = await client.messages.stream({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      system: [
        {
          type: 'text',
          text: SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: userMessage }],
    });

    console.log('── AI Review ────────────────────────────────────────────────────');
    aiText = await streamToStdout(stream);
  }

  // Summary
  const verdict =
    criticalCount > 0 ? '🔴 BLOCK — fix CRITICAL issues before merging'
    : majorCount > 0   ? '⚠️  WARN — MAJOR violations should be addressed'
                        : '✅ PASS — no blocking issues found';

  const summary =
    `\n── Summary ──────────────────────────────────────────────────────\n` +
    `Files reviewed: ${files.length}\n` +
    `Static violations: ${criticalCount} CRITICAL, ${majorCount} MAJOR, ${minorCount} MINOR\n` +
    `Verdict: ${verdict}`;
  console.log(summary);

  if (outputPath) {
    const aiSection = aiText ? `## AI Review\n${aiText}\n\n` : '';
    const report =
      `# Convention Review Report\n_Generated: ${new Date().toISOString()}_\n` +
      `_Files: ${files.join(', ')}_\n\n` +
      `## Static Analysis\n${staticReport}\n\n` +
      aiSection +
      `## Summary\n${summary}`;
    fs.writeFileSync(outputPath, report, 'utf-8');
    console.error(`\n✓ Report saved to: ${outputPath}`);
  }

  // Exit codes for CI / pre-commit hook integration:
  //   0 — clean (no violations)
  //   1 — MAJOR violations present (warn but don't block)
  //   2 — CRITICAL violations present (block the commit / build)
  process.exitCode = criticalCount > 0 ? 2 : majorCount > 0 ? 1 : 0;
}

// ── Entry point ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const filesFlag = args.indexOf('--files');
const outputFlag = args.indexOf('--output');
const useStagedFlag = args.includes('--staged');
const skipAi = args.includes('--skip-ai');
const forceAi = args.includes('--force-ai');

const outputPath = outputFlag !== -1 ? args[outputFlag + 1] : null;

let targetFiles: string[] = [];

if (useStagedFlag) {
  targetFiles = getStagedTypeScriptFiles();
  console.error(`Using ${targetFiles.length} staged TypeScript file(s).`);
} else if (filesFlag !== -1) {
  // Collect all args after --files until the next flag
  const fileArgs: string[] = [];
  for (let i = filesFlag + 1; i < args.length; i++) {
    if (args[i].startsWith('--')) break;
    fileArgs.push(args[i]);
  }
  targetFiles = resolveFiles(fileArgs);
} else {
  // Default: all spec and page files in the tests/ directory
  targetFiles = resolveFiles(['tests/ui', 'tests/api', 'tests/pages', 'tests/accessibility', 'tests/performance']);
}

reviewConventions(targetFiles, outputPath, skipAi, forceAi).catch((err: Error) => {
  console.error('Convention reviewer error:', err.message);
  process.exit(1);
});
