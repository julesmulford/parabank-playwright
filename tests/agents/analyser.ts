/**
 * Analyser Agent
 *
 * Reads Playwright test results (JSON or stdout) and uses Claude to produce a
 * plain-English diagnosis: root cause, whether it is a flaky selector, an app
 * bug, or an environment issue, and a concrete suggested fix per failure.
 *
 * Usage:
 *   npx tsx tests/agents/analyser.ts                         # reads test-results/ dir
 *   npx tsx tests/agents/analyser.ts --results results.json  # explicit JSON file
 */

import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';

const client = new Anthropic();

// ── helpers ────────────────────────────────────────────────────────────────

function readResultsJson(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8');
}

function collectErrorContextFiles(dir: string): string {
  if (!fs.existsSync(dir)) return '';
  const lines: string[] = [];
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name === 'error-context.md') {
        lines.push(`\n--- ${full} ---\n`);
        lines.push(fs.readFileSync(full, 'utf-8'));
      }
    }
  };
  walk(dir);
  return lines.join('\n');
}

// ── main ───────────────────────────────────────────────────────────────────

async function analyse(resultsSource: string) {
  const errorContexts = collectErrorContextFiles('test-results');

  const prompt = `You are a Playwright test expert. Analyse the following test results and error contexts.

For each failed test produce:
1. **Test name** — the full test title
2. **Root cause** — one sentence: is this a broken locator, an app bug, or an environment issue?
3. **Evidence** — the key line(s) from the error that confirm your diagnosis
4. **Suggested fix** — a concrete, actionable next step (e.g. update the locator, start Docker, check the API endpoint)

Be concise. Do not repeat information that is the same across failures — group them if they share the same root cause.

## Test Results
\`\`\`json
${resultsSource}
\`\`\`

${errorContexts ? `## Error Contexts\n${errorContexts}` : ''}
`;

  console.log('Analysing test results with Claude...\n');

  const stream = await client.messages.stream({
    model: 'claude-opus-4-6',
    max_tokens: 4096,
    thinking: { type: 'adaptive' },
    messages: [{ role: 'user', content: prompt }],
  });

  for await (const event of stream) {
    if (
      event.type === 'content_block_delta' &&
      event.delta.type === 'text_delta'
    ) {
      process.stdout.write(event.delta.text);
    }
  }

  console.log('\n');
}

// ── entry point ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const resultsFlag = args.indexOf('--results');
const resultsFile =
  resultsFlag !== -1 ? args[resultsFlag + 1] : null;

if (resultsFile) {
  analyse(readResultsJson(resultsFile));
} else {
  // Try to read the default Playwright JSON reporter output
  const defaultPath = 'test-results/results.json';
  if (fs.existsSync(defaultPath)) {
    analyse(readResultsJson(defaultPath));
  } else {
    console.error(
      'No results file found. Run: npx playwright test --reporter=json > test-results/results.json\n' +
        'Or pass: npx tsx tests/agents/analyser.ts --results <file>',
    );
    process.exit(1);
  }
}
