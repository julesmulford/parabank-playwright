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
 *   npx tsx tests/agents/testGenerator.ts --feature "login" --write        # confirm then write
 *   npx tsx tests/agents/testGenerator.ts --feature "login" --write --yes  # skip confirmation (CI/non-TTY)
 */

import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import readline from 'readline';
import { streamToStdout } from './lib/streamUtils.js';

const client = new Anthropic();

// ── Project context loader ──────────────────────────────────────────────────
// Globs all existing page objects dynamically so new pages are always included.

// ── Page-object index cache ─────────────────────────────────────────────────
// Persists extracted method names and locator labels keyed by file path + mtime.
// On repeated runs (common during active sessions), this avoids re-reading every
// page object file just to build the scoring index.

interface IndexEntry {
  mtime: number;
  methods: string[];
  labels: string[];
}

type PageIndex = Record<string, IndexEntry>;

const PG_INDEX_PATH = '.pg-index.json';

function loadOrBuildPageIndex(pagesDir: string): PageIndex {
  let cached: PageIndex = {};
  if (fs.existsSync(PG_INDEX_PATH)) {
    try {
      cached = JSON.parse(fs.readFileSync(PG_INDEX_PATH, 'utf-8')) as PageIndex;
    } catch { /* corrupt index — rebuild silently */ }
  }

  const files = fs.existsSync(pagesDir)
    ? fs.readdirSync(pagesDir).filter((n) => n.endsWith('.ts'))
    : [];

  const updated: PageIndex = {};
  let changed = false;

  for (const f of files) {
    const p = path.join(pagesDir, f);
    const mtime = fs.statSync(p).mtimeMs;

    if (cached[p]?.mtime === mtime) {
      updated[p] = cached[p]; // cache hit — no file read needed
    } else {
      // Cache miss — read first 800 chars for index extraction
      const preview = fs.readFileSync(p, 'utf-8').slice(0, 800);
      const methods = [...preview.matchAll(/async\s+(\w+)\s*\(/g)].map(([, m]) => m);
      const labels = [
        ...preview.matchAll(/getBy(?:Label|Role|Text|Placeholder)\s*\(\s*['"]([^'"]{1,40})['"]/g),
      ].map(([, m]) => m);
      updated[p] = { mtime, methods, labels };
      changed = true;
    }
  }

  if (changed) {
    try { fs.writeFileSync(PG_INDEX_PATH, JSON.stringify(updated)); } catch { /* best-effort */ }
  }

  return updated;
}

// ── Signature extractor for types/factories ─────────────────────────────────
// Extracts ONLY exported interfaces, type aliases, and function signatures.
// Function bodies are replaced with { /* ... */ } stubs so Claude sees the type
// contract without implementation noise. Non-exported declarations are omitted.

function extractTypeSignatures(src: string): string {
  const lines = src.split('\n');
  const out: string[] = [];
  let mode: 'normal' | 'collect' | 'skip' = 'normal';
  let depth = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    const opens = (line.match(/\{/g) ?? []).length;
    const closes = (line.match(/\}/g) ?? []).length;

    // Collecting an interface/type body — include every line verbatim
    if (mode === 'collect') {
      out.push(line);
      depth += opens - closes;
      if (depth <= 0) { mode = 'normal'; depth = 0; out.push(''); }
      continue;
    }

    // Skipping a function/const body — discard every line
    if (mode === 'skip') {
      depth += opens - closes;
      if (depth <= 0) { mode = 'normal'; depth = 0; }
      continue;
    }

    // ── mode === 'normal' — look for exported declarations only ──────────────

    // Exported interface or type alias — include fully (may be multi-line)
    if (/^export\s+(interface|type)\s+/.test(trimmed)) {
      out.push(line);
      depth = opens - closes;
      if (depth > 0) mode = 'collect';
      continue;
    }

    // Exported function — emit signature stub, skip body
    if (/^export\s+(async\s+)?function\s+/.test(trimmed)) {
      if (opens > 0) {
        // Replace everything from first '{' to end of line with a stub
        out.push(line.replace(/\s*\{.*$/, ' { /* ... */ }'));
        depth = opens - closes;
        if (depth > 0) mode = 'skip';
      } else {
        out.push(line); // multi-line signature, no brace yet
      }
      continue;
    }

    // Exported const (object, arrow function, etc.) — emit stub, skip body
    if (/^export\s+const\s+\w+/.test(trimmed) && opens > 0) {
      out.push(line.replace(/\s*\{.*$/, ' { /* ... */ }'));
      depth = opens - closes;
      if (depth > 0) mode = 'skip';
      continue;
    }

    // Everything else (imports, non-exported declarations, comments) — omit
  }

  return out.join('\n');
}

// Common English stop words that add no signal for relevance scoring
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'for', 'to', 'of', 'in', 'on', 'at', 'with',
  'from', 'by', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'have', 'has',
  'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might',
  'can', 'that', 'this', 'its', 'not', 'but', 'into', 'out', 'then', 'than',
]);

/**
 * Loads project context filtered by test type AND feature relevance.
 * Returns the context string and the number of relevant page objects found.
 *
 * - API tests: types + factories + example. No page objects.
 * - UI / a11y / performance: fixtures + types + factories + up to TOP_N most relevant
 *   page objects + a spec example.
 *
 * Two-phase loading: Phase 1 builds a lightweight index from the first 800 chars of each
 * file (class name, method names, locator labels) — avoids reading full 6 KB files for
 * objects that won't be selected. Phase 2 reads full content only for the top winners.
 *
 * Minimum relevance threshold: if no page object scores > 0, all are omitted entirely
 * rather than sending 3 random ones that would add noise without improving generation.
 */
function loadProjectContext(
  testType: string,
  featureText: string,
): { context: string; relevantPageObjectCount: number } {
  const sections: string[] = [];
  let relevantPageObjectCount = 0;

  // Data types and factories — extract signatures only (strip function bodies).
  // Claude needs interface shapes and function signatures to generate correct factory calls;
  // it never needs to read factory implementations.
  const SIG_CAP = 3_000;
  const dataFiles = ['tests/data/types.ts', 'tests/data/factories.ts'];
  for (const f of dataFiles) {
    if (fs.existsSync(f)) {
      let src = extractTypeSignatures(fs.readFileSync(f, 'utf-8'));
      if (src.length > SIG_CAP) src = src.slice(0, SIG_CAP) + '\n// ... (truncated)';
      sections.push(`### ${f} (signatures only)\n\`\`\`typescript\n${src}\n\`\`\``);
    }
  }

  if (testType !== 'api') {
    // Fixtures wrapper — capped at 4 KB. Claude needs the import lines and the Fixtures
    // type to wire new page objects; it doesn't need every existing fixture implementation.
    const FIXTURES_CAP = 4_000;
    if (fs.existsSync('tests/fixtures/fixtures.ts')) {
      let fixtureSrc = fs.readFileSync('tests/fixtures/fixtures.ts', 'utf-8');
      if (fixtureSrc.length > FIXTURES_CAP) {
        fixtureSrc = fixtureSrc.slice(0, FIXTURES_CAP) + '\n// ... (truncated)';
      }
      sections.push(`### tests/fixtures/fixtures.ts\n\`\`\`typescript\n${fixtureSrc}\n\`\`\``);
    }

    const PAGE_CAP = 6_000;
    const TOP_N = 3;

    if (fs.existsSync('tests/pages')) {
      const keywords = featureText
        .toLowerCase()
        .split(/\W+/)
        .filter((w) => w.length > 3 && !STOP_WORDS.has(w));

      // Use mtime-keyed cache so repeated runs don't re-read every page object.
      // Cache persists at .pg-index.json in the project root; only rebuilt on file change.
      const pageIndex = loadOrBuildPageIndex('tests/pages');

      const indexed = Object.entries(pageIndex).map(([p, entry]) => {
        const f = path.basename(p);
        const indexText = `${f} ${entry.methods.join(' ')} ${entry.labels.join(' ')}`.toLowerCase();
        const nameScore = keywords.filter((kw) => f.toLowerCase().includes(kw)).length * 3;
        const indexScore = keywords.filter((kw) => indexText.includes(kw)).length;
        return { f, p, score: nameScore + indexScore };
      });

      // Minimum relevance threshold: if no file scores above 0, skip page objects entirely.
      // Sending 3 unrelated page objects adds noise that degrades generation quality and
      // busts the L2 cache unnecessarily.
      const maxScore = indexed.reduce((m, x) => (x.score > m ? x.score : m), 0);
      if (maxScore === 0) {
        sections.push(
          '<!-- No existing page objects match this feature description — ' +
          'a new page object will likely be needed -->',
        );
        // relevantPageObjectCount stays 0 → caller gates Opus for new-PO generation
      } else {
        // Phase 2: read full content only for top-N relevant winners
        const relevant = indexed.filter((x) => x.score > 0);
        const top = relevant
          .sort((a, b) => b.score - a.score || a.f.localeCompare(b.f))
          .slice(0, TOP_N);
        relevantPageObjectCount = top.length;

        for (const { p } of top) {
          let src = fs.readFileSync(p, 'utf-8');
          if (src.length > PAGE_CAP) {
            src =
              src.slice(0, PAGE_CAP) +
              '\n// ... (truncated — see full file for implementation details)';
          }
          sections.push(`### ${p}\n\`\`\`typescript\n${src}\n\`\`\``);
        }

        const omitted = relevant.length - top.length;
        if (omitted > 0) {
          sections.push(
            `<!-- ${omitted} additional matching page object(s) omitted. ` +
            `Use a more specific --feature description to include them. -->`,
          );
        }
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
    // Cap example at 4 KB — the model only needs the import pattern, describe/test structure,
    // and one or two assertions to understand local conventions. Full files waste L2 cache space.
    const EXAMPLE_CAP = 4_000;
    let exampleSrc = fs.readFileSync(exampleFile, 'utf-8');
    if (exampleSrc.length > EXAMPLE_CAP) {
      exampleSrc = exampleSrc.slice(0, EXAMPLE_CAP) + '\n// ... (truncated)';
    }
    sections.push(
      `### ${exampleFile} (example — match this style)\n\`\`\`typescript\n${exampleSrc}\n\`\`\``,
    );
  }

  // ── Hard context budget ────────────────────────────────────────────────────
  // If the assembled context exceeds ~100 KB (≈25k tokens), trim lowest-value
  // sections first: example spec → lower-ranked page objects → long signatures.
  // This prevents cache-busting and token overruns on large projects.
  const CONTEXT_BUDGET = 100_000;
  let joined = sections.join('\n\n');

  if (joined.length > CONTEXT_BUDGET) {
    // Step 1: Remove the example spec section (lowest value — conventions are clear
    // from the system prompt; the example is only useful when context is small)
    const exampleIdx = sections.findIndex((s) => s.includes('(example — match this style)'));
    if (exampleIdx !== -1) {
      sections.splice(exampleIdx, 1);
      joined = sections.join('\n\n');
    }
  }

  if (joined.length > CONTEXT_BUDGET) {
    // Step 2: Drop the lowest-ranked page object (last in the top-N list)
    // Page objects are sorted highest → lowest relevance score, so the last one is cheapest to drop.
    const poIndices = sections.reduce<number[]>((acc, s, i) => {
      if (s.startsWith('### tests/pages/')) acc.push(i);
      return acc;
    }, []);
    if (poIndices.length > 1) {
      sections.splice(poIndices[poIndices.length - 1], 1);
      joined = sections.join('\n\n');
    }
  }

  if (joined.length > CONTEXT_BUDGET) {
    // Step 3: Hard-truncate the entire context block as a safety net
    joined = joined.slice(0, CONTEXT_BUDGET) + '\n\n// ... (context budget exceeded — truncated)';
  }

  return { context: joined, relevantPageObjectCount };
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
  // Always use forward slashes — path.join produces backslashes on Windows, but
  // the regex that parses Claude's "// tests/path/to/file.ts" comment block and
  // the Playwright test runner both expect forward slashes.
  return `${dirMap[testType] ?? 'tests/ui'}/${slug}.spec.ts`;
}

// ── Confirmation prompt ─────────────────────────────────────────────────────
// In non-TTY environments (CI, piped stdin) readline.question never fires.
// --yes bypasses the prompt so the generator can be scripted without hanging.

function confirm(question: string, autoYes: boolean): Promise<boolean> {
  if (autoYes || !process.stdin.isTTY) {
    console.error(`${question} [auto-yes]`);
    return Promise.resolve(true);
  }
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

async function generateTest(feature: string, testType: string, write: boolean, autoYes: boolean): Promise<void> {
  const { context, relevantPageObjectCount } = loadProjectContext(testType, feature);
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

  // Model selection strategy:
  //   API tests           → Sonnet (request/response patterns; no locator reasoning)
  //   1 relevant PO found → Sonnet (extending a single known class; straightforward)
  //   2+ relevant POs     → Opus+thinking (multi-page flow coordination)
  //   0 relevant POs      → Sonnet-first with Opus fallback:
  //                         Try Sonnet first (cheapest); if response contains no file
  //                         blocks → new page object design is complex → escalate to Opus.
  //                         This avoids paying Opus cost for simple new-feature specs
  //                         while still getting Opus quality when it's genuinely needed.

  const buildMessages = () => [
    {
      role: 'user' as const,
      content: [
        {
          type: 'text' as const,
          text: contextBlock,         // Level 2: cached while files are unchanged
          cache_control: { type: 'ephemeral' as const },
        },
        {
          type: 'text' as const,
          text: featureRequest,       // Level 3: small, unique, never cached
        },
      ],
    },
  ];

  const systemBlocks = [
    {
      type: 'text' as const,
      text: STATIC_SYSTEM_PROMPT,
      cache_control: { type: 'ephemeral' as const },
    },
  ];

  const useOpusDirect = testType !== 'api' && relevantPageObjectCount >= 2;
  const useSonnetFirst = testType !== 'api' && relevantPageObjectCount === 0;
  const useSonnet = testType === 'api' || relevantPageObjectCount === 1;

  let fullText: string;

  if (useSonnet) {
    const stream = await client.messages.stream({
      model: 'claude-sonnet-4-6', max_tokens: 8000,
      system: systemBlocks, messages: buildMessages(),
    });
    fullText = await streamToStdout(stream, '', { model: 'sonnet', po_count: relevantPageObjectCount });
  } else if (useOpusDirect) {
    const stream = await client.messages.stream({
      model: 'claude-opus-4-6', max_tokens: 16000,
      thinking: { type: 'enabled', budget_tokens: 8000 },
      system: systemBlocks, messages: buildMessages(),
    });
    fullText = await streamToStdout(stream, '', { model: 'opus', po_count: relevantPageObjectCount });
  } else {
    // Sonnet-first: 0 relevant POs — new feature, try cheap path first
    const sonnetStream = await client.messages.stream({
      model: 'claude-sonnet-4-6', max_tokens: 8000,
      system: systemBlocks, messages: buildMessages(),
    });
    fullText = await streamToStdout(sonnetStream, '', { model: 'sonnet-first', po_count: 0 });

    // Check if Sonnet produced parseable file blocks — no blocks = complex new PO design needed
    const hasBlocks = /\/\/ tests\/[^\n]+\.ts\s*\n```typescript/.test(fullText);
    if (!hasBlocks) {
      console.error(
        '\n⚠  Sonnet response lacked file blocks — sending retry-delta to Opus+thinking...\n',
      );
      // Retry-delta: send Opus only the failure context + correction request, NOT the full
      // original prompt again. The original context is cached from the Sonnet call so the
      // L2 cache hit means we only pay for the (tiny) correction turn + Opus generation.
      const retryMessages = [
        ...buildMessages(),
        { role: 'assistant' as const, content: fullText.slice(0, 2_000) }, // Sonnet's incomplete attempt
        {
          role: 'user' as const,
          content:
            'Your response above is missing the required file blocks. Each file MUST start with ' +
            '"// tests/path/to/file.ts" on its own line, followed immediately by a ```typescript block. ' +
            `Expected output path: ${outputPath}. ` +
            'Please provide all required files now.',
        },
      ];
      const opusStream = await client.messages.stream({
        model: 'claude-opus-4-6', max_tokens: 16000,
        thinking: { type: 'enabled', budget_tokens: 8000 },
        system: systemBlocks, messages: retryMessages,
      });
      fullText = await streamToStdout(opusStream, '', { model: 'opus-delta', po_count: 0 });
    }
  }

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

  const ok = await confirm('\nWrite these files?', autoYes);
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
const autoYes = args.includes('--yes');

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

generateTest(feature, testType, write, autoYes).catch((err: Error) => {
  console.error('Generator error:', err.message);
  process.exit(1);
});
