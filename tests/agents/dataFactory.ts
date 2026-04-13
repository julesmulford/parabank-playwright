/**
 * Data Factory Agent
 *
 * Generates realistic, boundary-aware test data variants for Parabank entities.
 * Reads existing types and factories so all output matches the schema exactly.
 * Before writing, deduplicates against existing function names to prevent
 * re-running from creating broken duplicate exports.
 *
 * Model: claude-sonnet-4-6 — data generation is a structured creative task
 * that doesn't require extended reasoning, but benefits from strong instruction
 * following. Prompt caching: schema context is cached across runs.
 *
 * Usage:
 *   npx tsx tests/agents/dataFactory.ts --entity customer
 *   npx tsx tests/agents/dataFactory.ts --entity customer --scenario "invalid ssn"
 *   npx tsx tests/agents/dataFactory.ts --entity customer --count 5
 *   npx tsx tests/agents/dataFactory.ts --entity customer --write          # append to factories.ts
 *   npx tsx tests/agents/dataFactory.ts --entity customer --output path/to/variants.ts
 */

import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';

const client = new Anthropic();

// ── System prompt (cached) ──────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a test data expert specialising in banking application edge cases for Parabank.

Rules for every generated factory function:
- Named export matching the pattern: export function build<Entity>_<scenario>()
- Call the base factory with overrides only: return buildCustomer({ firstName: 'X', ... })
- Use Date.now() or crypto.randomUUID() for any field that must be unique per test run
- Match TypeScript types exactly as defined in types.ts — no extra fields, no missing required ones
- For invalid/boundary variants: add a JSDoc comment explaining exactly what validation rule the variant targets
- Parabank field constraints:
    SSN: exactly 9 digits (no hyphens)
    Password: minimum 8 characters, must contain a digit and a special character
    Username: must be unique — always include Date.now() or randomUUID()
    Phone: numeric string
- Never use hardcoded Date values — use Date.now() so each run produces a unique value

Output format:
1. One paragraph explaining each variant and its test purpose
2. All TypeScript code in a single \`\`\`typescript block, starting with the required import`;

// ── Helpers ─────────────────────────────────────────────────────────────────

const CONTEXT_CAP = 12_000; // chars — stays well within a single cache-friendly token block

function loadDataContext(): string {
  return ['tests/data/types.ts', 'tests/data/factories.ts']
    .filter(fs.existsSync)
    .map((f) => {
      let src = fs.readFileSync(f, 'utf-8');
      if (src.length > CONTEXT_CAP) {
        // Keep the top of the file (imports + interfaces/types) which is most important
        src = src.slice(0, CONTEXT_CAP) + '\n// ... (truncated — file exceeds context cap)';
      }
      return `### ${f}\n\`\`\`typescript\n${src}\n\`\`\``;
    })
    .join('\n\n');
}

function extractExportedFunctionNames(src: string): Set<string> {
  const names = new Set<string>();
  for (const [, name] of src.matchAll(/export\s+function\s+(\w+)/g)) {
    names.add(name);
  }
  return names;
}

/** Strip functions whose names already exist in the target file. */
function deduplicateGeneratedCode(generated: string, existingNames: Set<string>): string {
  const lines = generated.split('\n');
  const out: string[] = [];
  let skipping = false;
  let braceDepth = 0;
  let skippedCount = 0;

  for (const line of lines) {
    const fnMatch = line.match(/^export\s+function\s+(\w+)/);
    if (fnMatch) {
      if (existingNames.has(fnMatch[1])) {
        console.warn(`  ⚠ Skipping duplicate: ${fnMatch[1]}`);
        skipping = true;
        braceDepth = 0;
        skippedCount++;
      } else {
        skipping = false;
      }
    }
    if (skipping) {
      braceDepth += (line.match(/{/g) ?? []).length;
      braceDepth -= (line.match(/}/g) ?? []).length;
      if (braceDepth <= 0 && line.includes('}')) skipping = false;
      continue;
    }
    out.push(line);
  }

  if (skippedCount > 0) {
    console.warn(`  Skipped ${skippedCount} duplicate function(s) — they already exist in the target file.`);
  }
  return out.join('\n');
}

// ── Main ────────────────────────────────────────────────────────────────────

async function generateData(
  entity: string,
  scenario: string,
  count: number,
  write: boolean,
  outputFile: string | null,
): Promise<void> {
  const context = loadDataContext();

  const scenarioClause = scenario
    ? `Focus specifically on this scenario: "${scenario}".`
    : `Generate a variety covering: happy-path baseline, minimum-length fields, maximum-length fields (50-char strings where applicable), special characters in name fields (O'Brien, García, résumé), numeric edge cases for phone/SSN, and one variant per significant validation rule that Parabank enforces.`;

  console.error(
    `Generating ${count} ${entity} variant(s)${scenario ? ` — "${scenario}"` : ' (varied edge cases)'}...\n`,
  );

  // Two-level caching:
  //   Level 1 — system prompt (rules, never changes) → always a cache hit
  //   Level 2 — data context (types.ts + factories.ts, changes infrequently) → cache hit within 5-min TTL
  //   Level 3 — entity/scenario request (unique per call) → never cached
  const contextBlock = `## Existing data schema and factories\n${context}`;
  const requestBlock = `## Task\nGenerate ${count} factory variant(s) for entity: **${entity}**\n\n${scenarioClause}`;

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
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: contextBlock,
            cache_control: { type: 'ephemeral' }, // Level 2: cached while schema is unchanged
          },
          {
            type: 'text',
            text: requestBlock, // Level 3: unique per call, never cached
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

  if (!write && !outputFile) return;

  const match = fullText.match(/```typescript\n([\s\S]*?)```/);
  if (!match) {
    console.warn('⚠  Could not extract TypeScript block from response — nothing written.');
    return;
  }

  let generated = match[1];

  if (outputFile) {
    // Write standalone file — keep the import, no dedup needed
    fs.writeFileSync(outputFile, generated, 'utf-8');
    console.error(`✓ Written to ${outputFile}`);
  } else {
    // Append to factories.ts — strip import line, dedup against existing exports
    const factoriesPath = 'tests/data/factories.ts';
    const existing = fs.existsSync(factoriesPath) ? fs.readFileSync(factoriesPath, 'utf-8') : '';
    const existingNames = extractExportedFunctionNames(existing);

    generated = generated.replace(/^import[^\n]*\n+/, '');
    generated = deduplicateGeneratedCode(generated, existingNames);

    if (generated.trim().length === 0) {
      console.warn('  All generated functions were duplicates — nothing appended.');
      return;
    }

    const appendContent = `\n// ── Generated variants (${new Date().toISOString()}) ──────────────────────────────\n${generated}`;
    fs.appendFileSync(factoriesPath, appendContent, 'utf-8');
    console.error(`✓ Appended to ${factoriesPath}`);
  }
}

// ── Entry point ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const entityFlag = args.indexOf('--entity');
const scenarioFlag = args.indexOf('--scenario');
const countFlag = args.indexOf('--count');
const outputFlag = args.indexOf('--output');

const entity = entityFlag !== -1 ? args[entityFlag + 1] : 'customer';
const scenario = scenarioFlag !== -1 ? args[scenarioFlag + 1] : '';
const rawCount = countFlag !== -1 ? args[countFlag + 1] : '3';
const count = parseInt(rawCount, 10);
const write = args.includes('--write');
const outputFile = outputFlag !== -1 ? args[outputFlag + 1] : null;

if (isNaN(count) || count < 1 || count > 20) {
  console.error('--count must be an integer between 1 and 20.');
  process.exit(1);
}

generateData(entity, scenario, count, write, outputFile).catch((err: Error) => {
  console.error('Data factory error:', err.message);
  process.exit(1);
});
