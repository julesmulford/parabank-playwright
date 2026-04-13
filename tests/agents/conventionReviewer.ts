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
 */

import Anthropic from '@anthropic-ai/sdk';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

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
];

function staticAnalyse(filePath: string): Violation[] {
  const violations: Violation[] = [];
  if (!fs.existsSync(filePath)) return violations;

  const src = fs.readFileSync(filePath, 'utf-8');
  const lines = src.split('\n');

  for (const rule of STATIC_RULES) {
    if (rule.skipFor?.(filePath)) continue;
    lines.forEach((line, idx) => {
      if (rule.pattern.test(line)) {
        violations.push({
          file: filePath,
          line: idx + 1,
          rule: rule.rule,
          severity: rule.severity,
          code: line.trim(),
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
    const out = execSync('git diff --cached --name-only --diff-filter=ACM', {
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

  // Phase 2: AI review — skip when explicitly disabled or when there is no readable file content
  const readableFiles = files.filter(fs.existsSync);
  let aiText = '';

  if (skipAi) {
    console.error('Phase 2: AI review skipped (--skip-ai).\n');
  } else if (readableFiles.length === 0) {
    console.error('Phase 2: AI review skipped — no readable files.\n');
  } else {
    console.error('Phase 2: AI review (Claude Haiku)...\n');

    // Focus the AI on files that static analysis flagged — those are most likely to have
    // subtler issues too. If nothing was flagged, send all files so the AI can find what
    // regex can't catch (poor but technically legal locator choices, missing @smoke tags, etc).
    const violationFiles = new Set(allViolations.map((v) => v.file));
    const filesToReview =
      violationFiles.size > 0
        ? readableFiles.filter((f) => violationFiles.has(f))
        : readableFiles;

    const fileSections = filesToReview
      .map((f) => `### ${f}\n\`\`\`typescript\n${fs.readFileSync(f, 'utf-8')}\n\`\`\``)
      .join('\n\n');

    if (filesToReview.length < readableFiles.length) {
      console.error(
        `  Focusing AI review on ${filesToReview.length} flagged file(s) ` +
          `(${readableFiles.length - filesToReview.length} clean file(s) skipped).\n`,
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
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        process.stdout.write(event.delta.text);
        aiText += event.delta.text;
      }
    }
    console.log('\n');
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
}

// ── Entry point ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const filesFlag = args.indexOf('--files');
const outputFlag = args.indexOf('--output');
const useStagedFlag = args.includes('--staged');
const skipAi = args.includes('--skip-ai');

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

reviewConventions(targetFiles, outputPath, skipAi).catch((err: Error) => {
  console.error('Convention reviewer error:', err.message);
  process.exit(1);
});
