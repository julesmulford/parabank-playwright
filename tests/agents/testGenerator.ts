/**
 * Test Generator Agent
 *
 * Given a feature description, generates a complete Playwright test following
 * the project's conventions. Supports four test types: ui, api, accessibility,
 * and performance.  Validates generated TypeScript before writing files.
 *
 * Model: claude-opus-4-6 with enabled thinking — code generation benefits from
 * planning the class structure, fixture wiring, and locator choices before writing.
 * Prompt caching: static rules + all existing page objects are cached so repeated
 * invocations only pay for the short feature description.
 *
 * Usage:
 *   npx tsx tests/agents/testGenerator.ts --feature "transfer funds between accounts"
 *   npx tsx tests/agents/testGenerator.ts --feature "loan request" --type api
 *   npx tsx tests/agents/testGenerator.ts --feature "registration page" --type accessibility
 *   npx tsx tests/agents/testGenerator.ts --feature "home page load" --type performance
 *   npx tsx tests/agents/testGenerator.ts --feature "login" --write   # confirm then write
 */

import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import readline from 'readline';

const client = new Anthropic();

// ── Project context loader ──────────────────────────────────────────────────
// Globs all existing page objects dynamically so new pages are always included.

/**
 * Loads project context filtered by test type to avoid sending irrelevant tokens.
 * - API tests: types + factories + an API spec example. No page objects (never used in API tests).
 * - UI / a11y / performance: fixtures + types + factories + all page objects + a UI spec example.
 *
 * This can reduce Level-2 cache content by 60-80% for API tests on large codebases.
 */
function loadProjectContext(testType: string): string {
  const sections: string[] = [];

  // Data types and factories are needed by all test types
  const dataFiles = ['tests/data/types.ts', 'tests/data/factories.ts'];
  for (const f of dataFiles) {
    if (fs.existsSync(f)) {
      sections.push(`### ${f}\n\`\`\`typescript\n${fs.readFileSync(f, 'utf-8')}\n\`\`\``);
    }
  }

  if (testType !== 'api') {
    // Fixtures wrapper and page objects are only relevant for browser tests
    if (fs.existsSync('tests/fixtures/fixtures.ts')) {
      sections.push(
        `### tests/fixtures/fixtures.ts\n\`\`\`typescript\n${fs.readFileSync('tests/fixtures/fixtures.ts', 'utf-8')}\n\`\`\``,
      );
    }
    if (fs.existsSync('tests/pages')) {
      for (const f of fs.readdirSync('tests/pages').filter((n) => n.endsWith('.ts'))) {
        const p = path.join('tests', 'pages', f);
        sections.push(`### ${p}\n\`\`\`typescript\n${fs.readFileSync(p, 'utf-8')}\n\`\`\``);
      }
    }
  }

  // Representative example spec for the target type — teaches the model local patterns
  const exampleMap: Record<string, string> = {
    ui: 'tests/ui/registration.spec.ts',
    api: 'tests/api/parabank.spec.ts',
    accessibility: 'tests/accessibility',
    performance: 'tests/performance',
  };
  const exampleTarget = exampleMap[testType] ?? exampleMap['ui'];

  let exampleFile: string | null = null;
  if (fs.existsSync(exampleTarget)) {
    if (fs.statSync(exampleTarget).isDirectory()) {
      // Pick the first spec in the directory — read once, not twice
      const specName = fs.readdirSync(exampleTarget).find((f) => f.endsWith('.spec.ts'));
      if (specName) exampleFile = path.join(exampleTarget, specName);
    } else {
      exampleFile = exampleTarget;
    }
  }

  if (exampleFile) {
    sections.push(
      `### ${exampleFile} (example — match this style)\n\`\`\`typescript\n${fs.readFileSync(exampleFile, 'utf-8')}\n\`\`\``,
    );
  }

  return sections.join('\n\n');
}

// ── Static system prompt (cached — never changes) ──────────────────────────
// IMPORTANT: the project context (page objects, factories, etc.) is NOT here.
// It lives in the user message as a separately-cached block so that the static
// rules cache independently from the dynamic project state.

const STATIC_SYSTEM_PROMPT = `You are a senior Playwright test automation engineer. Generate production-ready tests that exactly match project conventions.

Critical non-negotiables:
- NEVER import test/expect from @playwright/test in UI/a11y/performance test files — always '../fixtures/fixtures'
- NEVER put assertions (expect) inside page object methods
- NEVER use page.waitForTimeout()
- NEVER hardcode usernames, passwords, or any value that would collide in parallel runs — use factories
- Locator priority: getByRole → getByLabel → getByTestId → getByText/getByPlaceholder → locator('[id="..."]')
- NEVER use XPath, CSS class selectors, or positional selectors

Output format — for each file produce:
  // tests/path/to/File.ts        ← exact path as a comment on line 1
  \`\`\`typescript
  <file content>
  \`\`\`

New page objects go in tests/pages/. Spec files go in the directory matching the test type.`;

// ── Per-type generation instructions ───────────────────────────────────────

const TYPE_INSTRUCTIONS: Record<string, string> = {
  ui: `Generate a UI test using page objects via the fixtures wrapper.
- Import { test, expect } from '../fixtures/fixtures' — NEVER from @playwright/test
- All locators declared as readonly in page object constructor
- No assertions inside page object methods — actions only
- No page.waitForTimeout() — use expect(locator).toBeVisible()
- Use factories from tests/data/factories.ts for all test data
- Tag happy-path tests with @smoke`,

  api: `Generate an API test using the request fixture.
- Import { test, expect } from '@playwright/test' (API tests are exempt from the fixtures rule)
- Use request.get / post / put / delete
- Use beforeAll for auth/registration setup with module-level let variables
- Assert response status, body structure, and key field values
- Register a fresh customer in beforeAll using the HTML form POST pattern (no registration REST endpoint exists)`,

  accessibility: `Generate an accessibility test using @axe-core/playwright.
- Import { checkA11y, injectAxe } from '@axe-core/playwright'
- Import { test, expect } from '../fixtures/fixtures'
- Test key states: page load, after form interaction, post-navigation
- Assert zero violations at wcag2a and wcag2aa levels
- Use { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } } in checkA11y options
- Group tests for each page state in a describe block`,

  performance: `Generate a performance test using Playwright CDP metrics.
- Import { test, expect } from '../fixtures/fixtures'
- Capture metrics via: const client = await page.context().newCDPSession(page); await client.send('Performance.enable')
- Collect: LCP (Largest Contentful Paint), FCP (First Contentful Paint), TTI (Time to Interactive)
- Use performance.getEntriesByType('navigation') and PerformancePaintTiming via page.evaluate()
- Assert thresholds: LCP < 2500ms, FCP < 1800ms, TTI < 3500ms
- Use CDP Performance.getMetrics for JS heap and DOM node counts`,
};

function deriveOutputPath(feature: string, testType: string): string {
  const slug = feature
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const dirMap: Record<string, string> = {
    ui: 'tests/ui',
    api: 'tests/api',
    accessibility: 'tests/accessibility',
    performance: 'tests/performance',
  };
  return path.join(dirMap[testType] ?? 'tests/ui', `${slug}.spec.ts`);
}

// ── Confirmation prompt ─────────────────────────────────────────────────────

function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y');
    });
  });
}

// ── TypeScript validation ───────────────────────────────────────────────────

/**
 * Validates TypeScript by running `tsc --noEmit` using the project's tsconfig.json.
 * Passing individual file paths to tsc bypasses tsconfig.json (which has target: ES2022,
 * esModuleInterop: true, skipLibCheck: true) and reverts to compiler defaults, producing
 * hundreds of spurious ES5-related errors. Instead we run the full project check and
 * filter the output down to errors that touch any of our written files.
 */
function validateTypeScript(writtenPaths: string[]): { valid: boolean; errors: string } {
  try {
    execSync('npx tsc --noEmit', { encoding: 'utf-8', stdio: 'pipe' });
    return { valid: true, errors: '' };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const raw = (e.stdout ?? e.stderr ?? e.message ?? '').trim();

    // Filter to lines that reference one of our written files so pre-existing errors
    // in the wider project don't obscure the signal.
    const normalized = writtenPaths.map((p) => p.replace(/\\/g, '/'));
    const relevantLines = raw
      .split('\n')
      .filter((line) => normalized.some((p) => line.replace(/\\/g, '/').includes(p)));

    if (relevantLines.length === 0) {
      // No errors in our files — treat as valid even if the wider project has issues
      return { valid: true, errors: '' };
    }
    return { valid: false, errors: relevantLines.join('\n') };
  }
}

// ── Fixtures registration check ─────────────────────────────────────────────

function isRegisteredInFixtures(className: string): boolean {
  const fixturesPath = 'tests/fixtures/fixtures.ts';
  if (!fs.existsSync(fixturesPath)) return false;
  return fs.readFileSync(fixturesPath, 'utf-8').includes(className);
}

// ── Main ────────────────────────────────────────────────────────────────────

async function generateTest(feature: string, testType: string, write: boolean): Promise<void> {
  const context = loadProjectContext(testType);
  const outputPath = deriveOutputPath(feature, testType);
  const typeInstruction = TYPE_INSTRUCTIONS[testType] ?? TYPE_INSTRUCTIONS['ui'];

  // Two-level caching strategy:
  //   Level 1 — system prompt: static rules that never change → always a cache hit after first call
  //   Level 2 — user message context block: project files that change infrequently → cache hit
  //             within the 5-min TTL window (common during active development sessions)
  //   Level 3 — user message feature request: tiny, unique per call → never cached, always fresh
  //
  // Putting context in the system prompt (as before) defeated Level 2 entirely because the
  // system prompt text changed whenever any project file changed, busting the cache every time.

  const contextBlock = `## Existing project code (match these patterns exactly)\n\n${context}`;

  const featureRequest = `## Feature to test
"${feature}"

## Test type: ${testType}
${typeInstruction}

## Expected output path
${outputPath}

Generate all required files. If a UI/a11y/performance test needs a new page object, generate it first, then the spec.`;

  console.error(`Generating ${testType} test: "${feature}"\n`);

  // max_tokens must cover thinking + text output combined.
  // budget_tokens: 8000 for planning; remaining ~8000 for the generated spec + page object.
  const stream = await client.messages.stream({
    model: 'claude-opus-4-6',
    max_tokens: 16000,
    thinking: { type: 'enabled', budget_tokens: 8000 },
    system: [
      {
        type: 'text',
        text: STATIC_SYSTEM_PROMPT,  // Level 1: always cached
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: contextBlock,             // Level 2: cached while files are unchanged
            cache_control: { type: 'ephemeral' },
          },
          {
            type: 'text',
            text: featureRequest,           // Level 3: small, unique, never cached
          },
        ],
      },
    ],
  });

  let fullText = '';
  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      process.stdout.write(event.delta.text);
      fullText += event.delta.text;
    }
  }
  console.log('\n');

  if (!write) return;

  // Extract all typescript blocks preceded by their path comment
  const blocks = [
    ...fullText.matchAll(/\/\/ (tests\/[^\n]+\.ts)\s*\n```typescript\n([\s\S]*?)```/g),
  ];

  if (blocks.length === 0) {
    console.error(
      '⚠  Could not parse file blocks from the response above.\n' +
        '   Check that each file starts with: // tests/path/to/file.ts',
    );
    return;
  }

  // Preview what will be written
  console.error('\nFiles to write:');
  for (const [, filePath] of blocks) {
    const exists = fs.existsSync(filePath) ? ' ⚠ OVERWRITES EXISTING' : ' (new)';
    console.error(`  ${filePath}${exists}`);
  }

  const ok = await confirm('\nWrite these files?');
  if (!ok) {
    console.error('Aborted — no files written.');
    return;
  }

  const writtenPaths: string[] = [];
  for (const [, filePath, content] of blocks) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
    console.error(`  ✓ Written: ${filePath}`);
    writtenPaths.push(filePath);
  }

  // TypeScript type-check
  console.error('\nValidating TypeScript...');
  const { valid, errors } = validateTypeScript(writtenPaths);
  if (valid) {
    console.error('  ✓ No TypeScript errors');
  } else {
    console.error('  ✗ TypeScript errors detected:');
    console.error(errors.split('\n').map((l) => `    ${l}`).join('\n'));
    console.error('  Files are written — fix errors manually or re-run the generator.');
  }

  // Fixtures registration reminder
  const newPageObjects = writtenPaths.filter((p) => p.startsWith('tests/pages/'));
  for (const po of newPageObjects) {
    const className = path.basename(po, '.ts');
    if (!isRegisteredInFixtures(className)) {
      console.error(`\n⚠  Add ${className} to tests/fixtures/fixtures.ts before running UI tests.`);
    }
  }
}

// ── Entry point ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const featureFlag = args.indexOf('--feature');
const typeFlag = args.indexOf('--type');

const feature = featureFlag !== -1 ? args[featureFlag + 1] : null;
const testType = typeFlag !== -1 ? args[typeFlag + 1] : 'ui';
const write = args.includes('--write');

const validTypes = ['ui', 'api', 'accessibility', 'performance'];

if (!feature) {
  console.error(
    'Usage: npx tsx tests/agents/testGenerator.ts --feature "description" [--type ui|api|accessibility|performance] [--write]',
  );
  process.exit(1);
}

if (!validTypes.includes(testType)) {
  console.error(`Invalid --type "${testType}". Valid options: ${validTypes.join(', ')}`);
  process.exit(1);
}

generateTest(feature, testType, write).catch((err: Error) => {
  console.error('Generator error:', err.message);
  process.exit(1);
});
