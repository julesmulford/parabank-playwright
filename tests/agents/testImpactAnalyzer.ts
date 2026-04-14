/**
 * Test Impact Analyzer
 *
 * Maps a git diff to the existing Playwright specs most likely to catch regressions.
 * Uses two-phase analysis:
 *
 *   Phase 1 — Static scoring (no API call):
 *     Builds a dependency graph — which specs import which page objects, actions,
 *     and data files — and scores each spec deterministically:
 *       100  spec file itself changed
 *        90  spec directly imports the changed page object
 *        85  fixtures.ts changed (all browser specs affected)
 *        80  spec imports changed action file
 *        65  data/factories.ts or types.ts changed
 *        70  playwright.config.ts changed
 *        50  test title/describe keyword matches the changed file stem
 *
 *   Phase 2 — Claude enrichment (Sonnet):
 *     Validates and adjusts scores using semantic reasoning — e.g. LoginPage changes
 *     affect all post-login tests even if they don't directly import LoginPage.
 *     Skipped for --format files/grep (machine-readable formats are deterministic).
 *
 * Model: claude-sonnet-4-6 — dependency reasoning; no extended thinking needed.
 * Prompt caching: system prompt cached; static spec graph rarely changes mid-PR.
 *
 * Usage:
 *   npx tsx tests/agents/testImpactAnalyzer.ts --base main
 *   npx tsx tests/agents/testImpactAnalyzer.ts --base HEAD~3
 *   npx tsx tests/agents/testImpactAnalyzer.ts --base main --format files   # spec paths, one per line
 *   npx tsx tests/agents/testImpactAnalyzer.ts --base main --format grep    # --grep pattern
 *   npx tsx tests/agents/testImpactAnalyzer.ts --base main --output impact.md
 *   npx tsx tests/agents/testImpactAnalyzer.ts --staged                     # staged changes (pre-commit hook)
 *   npx tsx tests/agents/testImpactAnalyzer.ts --staged --format files      # pipe to playwright test
 */

import Anthropic from '@anthropic-ai/sdk';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { streamToStdout } from './lib/streamUtils.js';

const client = new Anthropic();

// ── System prompt (cached) ──────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a senior test automation engineer performing test impact analysis for a Playwright TypeScript test suite testing Parabank (a banking application).

You will receive:
1. A list of changed files with their types (page-object, action, fixture, data, config, spec, other)
2. A scored list of spec files with their test titles, imports, and initial static-analysis scores

Your job:
- Validate and adjust static scores using semantic reasoning
- Identify transitive dependencies the static analysis missed (e.g. LoginPage changes affect all post-login tests even without a direct import, because login is a prerequisite flow)
- Flag specs the static analysis missed that are clearly at risk
- For each adjusted/flagged spec: one sentence explaining the dependency

Output format:

## Impact Analysis Summary
One paragraph: what changed, how wide the blast radius is, and the confidence level.

## High Risk — Run First (score ≥ 80)
**[score] path/to/spec.ts** — reason

## Medium Risk — Run if time allows (score 50–79)
**[score] path/to/spec.ts** — reason

## Low Risk — Can safely skip for this change (score < 50)
path/to/spec.ts (one per line, no scores needed)

## Recommended Playwright Command
The exact npx playwright test command to run only the high-risk specs.`;

// ── Types ────────────────────────────────────────────────────────────────────

type FileType = 'spec' | 'page-object' | 'action' | 'fixture' | 'data' | 'config' | 'other';

interface ChangedFile {
  path: string;
  type: FileType;
  stem: string;
}

interface SpecMeta {
  filePath: string;
  testCount: number;
  imports: string[];
  describes: string[];
  testTitles: string[];
  score: number;
  reasons: string[];
}

// ── Git utilities ─────────────────────────────────────────────────────────────

/**
 * Validates and sanitizes a git ref before interpolating it into shell commands.
 * Git ref names may only contain alphanumeric chars and a small set of punctuation.
 * Anything outside that set is a sign of attempted injection — reject early.
 */
function sanitizeRef(ref: string): string {
  if (!/^[a-zA-Z0-9._\-/~^@{}]+$/.test(ref)) {
    console.error(`✗ Invalid git ref: "${ref}" — ref must contain only alphanumeric, ., -, _, /, ~, ^, @, {, }`);
    process.exit(1);
  }
  return ref;
}

function validateRef(ref: string): boolean {
  const safe = sanitizeRef(ref); // exits on injection attempts
  try {
    execSync(`git rev-parse --verify ${safe}`, { stdio: 'pipe', encoding: 'utf-8' });
    return true;
  } catch {
    return false;
  }
}

/** Classifies a file path into a FileType for impact scoring. */
function classifyFile(filePath: string): ChangedFile {
  const stem = path.basename(filePath, path.extname(filePath));
  let type: FileType = 'other';

  if (filePath.endsWith('.spec.ts')) type = 'spec';
  else if (filePath.startsWith('tests/pages/')) type = 'page-object';
  else if (filePath.startsWith('tests/actions/')) type = 'action';
  else if (filePath === 'tests/fixtures/fixtures.ts') type = 'fixture';
  else if (filePath.startsWith('tests/data/')) type = 'data';
  else if (
    filePath === 'playwright.config.ts' ||
    filePath.endsWith('.env') ||
    filePath.endsWith('.env.example')
  ) {
    type = 'config';
  }

  return { path: filePath, type, stem };
}

function getChangedFiles(base: string): ChangedFile[] {
  const safe = sanitizeRef(base);
  const tryDiff = (cmd: string): string => {
    try {
      return execSync(cmd, { encoding: 'utf-8', stdio: 'pipe' }).trim();
    } catch {
      return '';
    }
  };

  // Triple-dot: commits on this branch not yet in base
  let raw = tryDiff(`git diff --name-only --diff-filter=ACMR ${safe}...HEAD`);
  // Fallback: two-dot diff against base commit
  if (!raw) raw = tryDiff(`git diff --name-only --diff-filter=ACMR ${safe}`);
  // Final fallback: uncommitted changes
  if (!raw) raw = tryDiff('git diff --name-only --diff-filter=ACMR HEAD');

  return raw.split('\n').filter(Boolean).map(classifyFile);
}

/** Returns staged (index) changes — useful in pre-commit hooks and CI pre-flight checks. */
function getStagedFiles(): ChangedFile[] {
  try {
    const raw = execSync('git diff --cached --name-only --diff-filter=ACMR', {
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();
    return raw.split('\n').filter(Boolean).map(classifyFile);
  } catch {
    return [];
  }
}

// ── Spec scanner ──────────────────────────────────────────────────────────────

function resolveImports(src: string, specFile: string): string[] {
  const specDir = path.dirname(specFile);
  const results: string[] = [];
  const re = /from\s+['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const raw = m[1];
    if (raw.startsWith('.')) {
      results.push(path.normalize(path.join(specDir, raw)).replace(/\\/g, '/'));
    }
  }
  return results;
}

function scanSpecs(): SpecMeta[] {
  const specs: SpecMeta[] = [];

  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name).replace(/\\/g, '/');
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.spec.ts')) {
        const src = fs.readFileSync(full, 'utf-8');
        const testCount = (src.match(/\btest\s*\(/g) ?? []).length;
        const describes = [...src.matchAll(/describe\s*\(\s*['"`]([^'"`]+)['"`]/g)].map(([, t]) => t);
        const testTitles = [...src.matchAll(/\btest\s*\(\s*['"`]([^'"`]+)['"`]/g)].map(([, t]) => t);
        specs.push({
          filePath: full,
          testCount,
          imports: resolveImports(src, full),
          describes,
          testTitles,
          score: 0,
          reasons: [],
        });
      }
    }
  };

  for (const dir of ['tests/ui', 'tests/api', 'tests/accessibility', 'tests/performance']) {
    walk(dir);
  }
  return specs;
}

// ── Static scoring ────────────────────────────────────────────────────────────

function scoreSpecs(specs: SpecMeta[], changedFiles: ChangedFile[]): void {
  const changedPaths = new Set(changedFiles.map((f) => f.path.replace(/\\/g, '/')));

  for (const spec of specs) {
    const specPath = spec.filePath.replace(/\\/g, '/');

    // The spec itself changed — run it, nothing to infer
    if (changedPaths.has(specPath)) {
      spec.score = 100;
      spec.reasons.push('spec file was directly modified');
      continue;
    }

    for (const file of changedFiles) {
      const fileStem = file.stem.toLowerCase();

      // Direct import match: spec imports the changed file
      const importedDirectly = spec.imports.some(
        (imp) => imp.endsWith(file.stem) || imp.endsWith(`/${file.stem}`),
      );

      if (importedDirectly) {
        const score =
          file.type === 'fixture' ? 85 :
          file.type === 'page-object' ? 90 :
          file.type === 'action' ? 80 :
          file.type === 'data' ? 65 : 70;

        if (score > spec.score) {
          spec.score = score;
          spec.reasons.push(`imports changed ${file.type} "${file.stem}"`);
        }
        continue;
      }

      // Global-impact file types
      if (file.type === 'fixture') {
        // API specs import from @playwright/test directly and never use browser fixtures —
        // a fixtures.ts change does not affect them. Scoring them at 85 would cause the
        // full API suite to run on every browser-fixture change, which is wrong.
        const isBrowserSpec = !spec.filePath.startsWith('tests/api/');
        if (isBrowserSpec && spec.score < 85) {
          spec.score = 85;
          spec.reasons.push('fixtures.ts changed — affects all browser tests');
        }
        continue;
      }
      if (file.type === 'data') {
        if (spec.score < 65) { spec.score = 65; spec.reasons.push(`data file "${file.stem}" changed — test data may differ`); }
        continue;
      }
      if (file.type === 'config') {
        if (spec.score < 70) { spec.score = 70; spec.reasons.push(`config file "${file.path}" changed`); }
        continue;
      }

      // Keyword: the changed file's stem appears in test/describe titles
      // Strip common suffixes so "LoginPage" matches "login" in titles
      const keyword = fileStem.replace(/page$/, '').replace(/spec$/, '').replace(/actions?$/, '');
      if (keyword.length > 3) {
        const inTitles =
          spec.testTitles.some((t) => t.toLowerCase().includes(keyword)) ||
          spec.describes.some((d) => d.toLowerCase().includes(keyword));
        if (inTitles && spec.score < 50) {
          spec.score = 50;
          spec.reasons.push(`test titles reference keyword "${keyword}" from changed file`);
        }
      }
    }
  }
}

// ── Output formatters ─────────────────────────────────────────────────────────

function outputFiles(specs: SpecMeta[]): void {
  const ranked = specs.filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
  if (ranked.length === 0) {
    console.log('# No spec files appear to be impacted by this change.');
    return;
  }
  for (const s of ranked) console.log(s.filePath);
}

function outputGrep(specs: SpecMeta[]): void {
  const highRisk = specs.filter((s) => s.score >= 70).sort((a, b) => b.score - a.score);
  if (highRisk.length === 0) {
    console.log('');
    return;
  }
  // Build a grep pattern from describe blocks first, falling back to test titles when
  // a spec has no describe block (a convention violation but it happens in practice).
  // Cap at 8 terms to keep the --grep pattern manageable on the command line.
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const terms = new Set<string>();
  for (const s of highRisk) {
    const candidates = s.describes.length > 0 ? s.describes : s.testTitles;
    for (const c of candidates) {
      if (terms.size >= 8) break;
      terms.add(escape(c));
    }
  }
  console.log([...terms].join('|'));
}

// ── Claude enrichment ─────────────────────────────────────────────────────────

async function enrichWithClaude(
  specs: SpecMeta[],
  changedFiles: ChangedFile[],
  base: string,
  outputPath: string | null,
): Promise<void> {
  const changedSection = changedFiles
    .map((f) => `- [${f.type}] ${f.path}`)
    .join('\n');

  // Only send impacted specs to Claude — zero-score specs add tokens with no value.
  // Cap at 30 (sorted by score desc) to stay within a reasonable token budget.
  const impacted = [...specs].filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
  const zeroCount = specs.length - impacted.length;
  const capped = impacted.slice(0, 30);
  const truncationNote = impacted.length > 30
    ? `\n(${impacted.length - 30} additional impacted spec(s) omitted — showing top 30 by score)`
    : '';

  const specsSection =
    (capped.length === 0
      ? '(no specs have a non-zero impact score for these changes)'
      : capped
          .map((s) =>
            `- score=${s.score} ${s.filePath} (${s.testCount} test(s))\n` +
            `  Imports: ${s.imports.map((i) => path.basename(i)).join(', ') || 'none'}\n` +
            `  Describes: ${s.describes.slice(0, 3).join(' | ') || 'none'}\n` +
            `  Reasons: ${s.reasons.join('; ') || 'none'}`,
          )
          .join('\n')) +
    truncationNote +
    (zeroCount > 0 ? `\n(${zeroCount} spec(s) scored 0 — no detected dependency on changed files)` : '');

  const userMessage =
    `## Changed files\n${changedSection}\n\n` +
    `## Spec files (static scores — impacted only)\n${specsSection}`;

  const stream = await client.messages.stream({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userMessage }],
  });

  const fullText = await streamToStdout(stream);

  if (outputPath) {
    const header = `# Test Impact Analysis\n_Base: ${base} | Generated: ${new Date().toISOString()}_\n\n`;
    fs.writeFileSync(outputPath, header + fullText, 'utf-8');
    console.error(`✓ Report saved to: ${outputPath}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function analyzeImpact(
  base: string,
  format: string,
  outputPath: string | null,
): Promise<void> {
  if (!validateRef(base)) {
    console.error(`✗ Git ref "${base}" does not exist. Use a branch name, tag, or commit SHA.`);
    process.exit(1);
  }

  console.error(`Analyzing impact of changes since "${base}"...\n`);

  const changedFiles = getChangedFiles(base);
  if (changedFiles.length === 0) {
    console.error('No changed files detected — nothing to analyze.');
    process.exit(0);
  }

  console.error(`Changed files (${changedFiles.length}):`);
  for (const f of changedFiles) console.error(`  [${f.type}] ${f.path}`);
  console.error('');

  const specs = scanSpecs();
  console.error(`Scanning ${specs.length} spec file(s)...`);
  scoreSpecs(specs, changedFiles);

  const impacted = specs.filter((s) => s.score > 0);
  console.error(`${impacted.length}/${specs.length} specs flagged as potentially impacted.\n`);

  if (format === 'files') { outputFiles(specs); return; }
  if (format === 'grep') { outputGrep(specs); return; }

  // Early exit for markdown format — no Claude call when zero specs are impacted.
  // Static analysis is already deterministic; sending an empty spec list to Claude
  // produces a generic "nothing to run" message at needless API cost.
  if (impacted.length === 0) {
    const msg =
      '✅ No spec files are impacted by these changes — static analysis found no test dependencies.\n' +
      '   Only non-test source files changed (docs, CI config, assets, etc.).\n\n' +
      '**Recommended command**: `npx playwright test` (full suite, or skip if CI only runs on impacted tests)';
    console.log(msg);
    if (outputPath) {
      const header = `# Test Impact Analysis\n_Base: ${base} | Generated: ${new Date().toISOString()}_\n\n`;
      fs.writeFileSync(outputPath, header + msg + '\n', 'utf-8');
      console.error(`✓ Report saved to: ${outputPath}`);
    }
    return;
  }

  // Default: full Claude analysis
  await enrichWithClaude(specs, changedFiles, base, outputPath);
}

// ── Entry point ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes('--help') || args.length === 0) {
  console.error(
    'Usage:\n' +
    '  npx tsx tests/agents/testImpactAnalyzer.ts --base main\n' +
    '  npx tsx tests/agents/testImpactAnalyzer.ts --base main --format files\n' +
    '  npx tsx tests/agents/testImpactAnalyzer.ts --base main --format grep\n' +
    '  npx tsx tests/agents/testImpactAnalyzer.ts --base HEAD~3 --output impact.md\n' +
    '  npx tsx tests/agents/testImpactAnalyzer.ts --staged              # staged changes (pre-commit)\n' +
    '  npx tsx tests/agents/testImpactAnalyzer.ts --staged --format files',
  );
  process.exit(args.length === 0 ? 1 : 0);
}

const baseFlag = args.indexOf('--base');
const formatFlag = args.indexOf('--format');
const outputFlag = args.indexOf('--output');
const stagedFlag = args.includes('--staged');

const base = baseFlag !== -1 ? args[baseFlag + 1] : null;
const format = formatFlag !== -1 ? args[formatFlag + 1] : 'markdown';
const outputPath = outputFlag !== -1 ? args[outputFlag + 1] : null;

const validFormats = ['markdown', 'files', 'grep'];
if (!validFormats.includes(format)) {
  console.error(`Invalid --format "${format}". Valid options: ${validFormats.join(', ')}`);
  process.exit(1);
}

if (stagedFlag) {
  // --staged mode: analyse currently staged changes without needing a base ref.
  // Ideal for pre-commit hooks: `npx tsx ... --staged --format files | xargs npx playwright test`
  const changedFiles = getStagedFiles();
  if (changedFiles.length === 0) {
    console.error('No staged files detected — nothing to analyze.');
    process.exit(0);
  }
  console.error(`Analyzing impact of ${changedFiles.length} staged file(s)...\n`);
  for (const f of changedFiles) console.error(`  [${f.type}] ${f.path}`);
  console.error('');

  const specs = scanSpecs();
  scoreSpecs(specs, changedFiles);
  const impacted = specs.filter((s) => s.score > 0);
  console.error(`${impacted.length}/${specs.length} specs flagged as potentially impacted.\n`);

  if (format === 'files') { outputFiles(specs); process.exit(0); }
  if (format === 'grep') { outputGrep(specs); process.exit(0); }

  if (impacted.length === 0) {
    console.log('✅ No spec files impacted by staged changes.');
    process.exit(0);
  }
  enrichWithClaude(specs, changedFiles, '(staged)', outputPath).catch((err: Error) => {
    console.error('Test impact analyzer error:', err.message);
    process.exit(1);
  });
} else {
  if (!base) {
    console.error('--base <ref> or --staged is required.');
    process.exit(1);
  }
  analyzeImpact(base, format, outputPath).catch((err: Error) => {
    console.error('Test impact analyzer error:', err.message);
    process.exit(1);
  });
}
