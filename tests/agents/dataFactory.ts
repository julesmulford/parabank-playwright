/**
 * Data Factory Agent
 *
 * Generates realistic, boundary-aware test data variants for Parabank.
 * Reads existing types and factories so generated data matches the schema,
 * then uses Claude to produce edge-case and boundary data sets.
 *
 * Usage:
 *   npx tsx tests/agents/dataFactory.ts --entity customer
 *   npx tsx tests/agents/dataFactory.ts --entity customer --scenario "invalid ssn"
 *   npx tsx tests/agents/dataFactory.ts --entity customer --count 5
 *   npx tsx tests/agents/dataFactory.ts --entity customer --write
 */

import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';

const client = new Anthropic();

// ── helpers ────────────────────────────────────────────────────────────────

function loadDataContext(): string {
  const files = ['tests/data/types.ts', 'tests/data/factories.ts'];
  return files
    .filter(fs.existsSync)
    .map((f) => `### ${f}\n\`\`\`typescript\n${fs.readFileSync(f, 'utf-8')}\n\`\`\``)
    .join('\n\n');
}

// ── main ───────────────────────────────────────────────────────────────────

async function generateData(
  entity: string,
  scenario: string,
  count: number,
  write: boolean,
) {
  const context = loadDataContext();

  const scenarioClause = scenario
    ? `Focus on this specific scenario: "${scenario}".`
    : `Generate a variety of interesting cases including: happy path, boundary values, maximum-length fields, special characters in names, and edge cases that are valid but unusual.`;

  const prompt = `You are a test data expert for a banking application (Parabank).

## Existing data schema and factories
${context}

## Task
Generate ${count} factory function variant(s) for entity: **${entity}**

${scenarioClause}

Rules:
- Each variant must be a named export function like \`buildCustomer_<scenario>()\`
- Use \`Date.now()\` or \`crypto.randomUUID()\` for fields that must be unique per run
- Match the exact TypeScript types from types.ts
- For invalid/boundary data, add a JSDoc comment explaining what the variant tests
- All generated functions should call the base factory with overrides:
  e.g. \`export function buildCustomer_longName() { return buildCustomer({ firstName: 'A'.repeat(50) }); }\`
- For Parabank specifically: SSN must be 9 digits, username must be unique, password must satisfy the app's rules (minimum 8 chars)

Produce:
1. A brief explanation of each variant and what it tests
2. The TypeScript code for all variants in a single \`\`\`typescript block
   - Include the import from './factories.js' at the top
`;

  console.log(`Generating ${count} ${entity} data variant(s)${scenario ? ` for "${scenario}"` : ''}...\n`);

  const stream = await client.messages.stream({
    model: 'claude-opus-4-6',
    max_tokens: 4096,
    thinking: { type: 'adaptive' },
    messages: [{ role: 'user', content: prompt }],
  });

  let fullText = '';
  for await (const event of stream) {
    if (
      event.type === 'content_block_delta' &&
      event.delta.type === 'text_delta'
    ) {
      process.stdout.write(event.delta.text);
      fullText += event.delta.text;
    }
  }

  console.log('\n');

  if (write) {
    const match = fullText.match(/```typescript\n([\s\S]*?)```/);
    if (match) {
      const appendContent = `\n// ── Generated variants (${new Date().toISOString()}) ──\n${match[1]}`;
      fs.appendFileSync('tests/data/factories.ts', appendContent);
      console.log('Appended generated variants to tests/data/factories.ts');
    } else {
      console.warn('Could not extract TypeScript from response — nothing written.');
    }
  }
}

// ── entry point ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const entityFlag = args.indexOf('--entity');
const scenarioFlag = args.indexOf('--scenario');
const countFlag = args.indexOf('--count');

const entity = entityFlag !== -1 ? args[entityFlag + 1] : 'customer';
const scenario = scenarioFlag !== -1 ? args[scenarioFlag + 1] : '';
const count = countFlag !== -1 ? parseInt(args[countFlag + 1], 10) : 3;
const write = args.includes('--write');

generateData(entity, scenario, count, write);
